#!/usr/bin/env node
/**
 * Lyrenth MCP server.
 *
 * Exposes three tools:
 *   - read_url: turn any public web page into a clean AIDocument (Markdown +
 *     title/description + structure), optionally capped to a max_tokens budget.
 *   - read_urls: the same for up to 20 URLs in one batch call.
 *   - check_usage: report the caller's plan tier + credit usage.
 * So an MCP client (Claude Desktop, Claude Code, Cursor, ...) reads the web
 * through Lyrenth instead of a raw fetch. Reads resolve through Lyrenth's
 * cross-caller cache, and for verified domains they return the publisher's
 * canonical version.
 *
 * Config (env):
 *   LYRENTH_API_KEY   required. Free key at https://lyrenth.com/signup
 *   LYRENTH_API_URL   optional. Default https://api.lyrenth.com
 *
 * Speaks MCP over stdio. stdout is reserved for the protocol; all diagnostics
 * go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Resolve the API base. Strip trailing slashes, and tolerate a scheme-less
// value (e.g. "api.lyrenth.com") by defaulting it to https. A bare host with
// no scheme is the most common config mistake (it's what some MCP hosts put in
// the URL field) and otherwise makes fetch() throw "Failed to parse URL from
// api.lyrenth.com/v1/aidocument" before the request is ever sent.
const API_BASE = (() => {
  const raw = (process.env.LYRENTH_API_URL ?? "https://api.lyrenth.com")
    .trim()
    .replace(/\/+$/, "");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
})();
const API_KEY = process.env.LYRENTH_API_KEY ?? "";

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function textResult(text: string, isError = false): TextResult {
  return { content: [{ type: "text", text }], isError };
}

// Render the v2 AIDocument envelope into a compact, model-friendly block: a
// short provenance header followed by the cleaned Markdown body.
function formatDoc(doc: unknown, requestedUrl: string): string {
  const d = (doc ?? {}) as Record<string, any>;
  const identity = d.identity ?? {};
  const source = d.source ?? {};
  const signals = d.signals ?? {};
  const economics = d.economics ?? {};
  const markdown: string = d.content?.markdown ?? "";

  const tokens = economics.output_tokens_approx;
  const savings = economics.token_savings_percent; // fraction, e.g. 0.91
  const metaLine = [
    source.status_code ? `status ${source.status_code}` : null,
    source.render_mode ? `render ${source.render_mode}` : null,
    typeof signals.word_count === "number" ? `${signals.word_count} words` : null,
    typeof tokens === "number" ? `~${tokens.toLocaleString()} tokens` : null,
    typeof savings === "number" ? `${Math.round(savings * 100)}% smaller than raw HTML` : null,
    economics.truncated ? "truncated to budget" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const header = [
    identity.title ? `# ${identity.title}` : null,
    identity.description ? `> ${identity.description}` : null,
    `Source: ${source.canonical_url || source.url || requestedUrl}`,
    metaLine || null,
  ]
    .filter(Boolean)
    .join("\n");

  const body = markdown || "(no body text was extracted from this page)";
  return `${header}\n\n---\n\n${body}`.trim();
}

function missingKeyResult(): TextResult {
  return textResult(
    "LYRENTH_API_KEY is not set. Get a free key at https://lyrenth.com/signup and add it to this server's config.",
    true,
  );
}

async function readUrl(
  url: string,
  fresh: boolean,
  maxTokens?: number,
): Promise<TextResult> {
  if (!API_KEY) return missingKeyResult();

  const body: Record<string, unknown> = {
    url,
    freshness_policy: fresh ? "force_refresh" : "cache_first",
  };
  if (typeof maxTokens === "number" && maxTokens > 0) {
    body.max_tokens = Math.floor(maxTokens);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/aidocument`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return textResult(`Failed to reach Lyrenth: ${(e as Error).message}`, true);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    return textResult(`Lyrenth returned HTTP ${res.status}. ${detail}`.trim(), true);
  }

  let doc: unknown;
  try {
    doc = await res.json();
  } catch (e) {
    return textResult(
      `Lyrenth returned an unparseable response: ${(e as Error).message}`,
      true,
    );
  }
  return textResult(formatDoc(doc, url));
}

// check_usage reports the caller's Lyrenth credit usage (tier, used vs limit,
// remaining, reset) from /v1/quota.
async function checkUsage(): Promise<TextResult> {
  if (!API_KEY) return missingKeyResult();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/quota`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  } catch (e) {
    return textResult(`Failed to reach Lyrenth: ${(e as Error).message}`, true);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    return textResult(`Lyrenth returned HTTP ${res.status}. ${detail}`.trim(), true);
  }

  let q: Record<string, any>;
  try {
    q = (await res.json()) as Record<string, any>;
  } catch (e) {
    return textResult(
      `Lyrenth returned an unparseable response: ${(e as Error).message}`,
      true,
    );
  }

  const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString() : "0");
  if (q.unlimited) {
    return textResult(`Plan: ${q.tier ?? "enterprise"} · unlimited credits`);
  }
  const lines = [
    `Plan: ${q.tier ?? "free"}`,
    `Credits used: ${n(q.used)} / ${n(q.limit)}`,
    `Remaining: ${n(q.remaining)}`,
    q.resets_at ? `Resets: ${q.resets_at}` : null,
  ].filter(Boolean);
  return textResult(lines.join("\n"));
}

// read_urls resolves several URLs in one batch call (POST /v1/aidocument/batch),
// each to a clean AIDocument, with per-URL error isolation.
async function readUrls(
  urls: string[],
  fresh: boolean,
  maxTokens?: number,
): Promise<TextResult> {
  if (!API_KEY) return missingKeyResult();
  if (!urls.length) return textResult("Provide at least one URL.", true);

  const body: Record<string, unknown> = {
    urls,
    freshness_policy: fresh ? "force_refresh" : "cache_first",
  };
  if (typeof maxTokens === "number" && maxTokens > 0) {
    body.max_tokens = Math.floor(maxTokens);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/aidocument/batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return textResult(`Failed to reach Lyrenth: ${(e as Error).message}`, true);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    return textResult(`Lyrenth returned HTTP ${res.status}. ${detail}`.trim(), true);
  }

  let payload: { results?: any[] };
  try {
    payload = (await res.json()) as { results?: any[] };
  } catch (e) {
    return textResult(
      `Lyrenth returned an unparseable response: ${(e as Error).message}`,
      true,
    );
  }

  const results = payload.results ?? [];
  const ok = results.filter((r) => r?.ok).length;
  const sections = results.map((r) =>
    r?.ok && r.document
      ? formatDoc(r.document, r.url)
      : `## ${r?.url ?? "(unknown url)"}\n\nError: ${r?.error ?? "failed"}`,
  );
  const header = `Read ${ok}/${results.length} URLs successfully.`;
  return textResult([header, ...sections].join("\n\n---\n\n"));
}

async function main(): Promise<void> {
  const server = new McpServer({ name: "lyrenth", version: "0.1.4" });

  server.tool(
    "read_url",
    "Read any public web page as a clean AIDocument: Markdown plus title, " +
      "description, and structure, with navigation and boilerplate stripped. " +
      "Prefer this over a raw HTTP fetch whenever you need the content of a web " +
      "page; it returns far cleaner, lower-token text. Powered by Lyrenth.",
    {
      url: z.string().url().describe("Absolute http(s) URL of the page to read."),
      fresh: z
        .boolean()
        .optional()
        .describe(
          "Force a fresh fetch instead of the cached version. Slower; default false.",
        ),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Cap the returned content to roughly this many tokens, trimmed at a clean paragraph or sentence boundary. Use it when you have a tight context budget.",
        ),
    },
    async ({ url, fresh, max_tokens }) => readUrl(url, fresh ?? false, max_tokens),
  );

  server.tool(
    "read_urls",
    "Read several public web pages in one batch call, each as a clean " +
      "AIDocument. Up to 20 URLs, faster than calling read_url repeatedly. Use " +
      "it to compare or summarize multiple pages at once; a failed URL is " +
      "reported per-item and does not block the others. Powered by Lyrenth.",
    {
      urls: z
        .array(z.string().url())
        .min(1)
        .max(20)
        .describe("1-20 absolute http(s) URLs to read."),
      fresh: z
        .boolean()
        .optional()
        .describe(
          "Force a fresh fetch for all URLs instead of cached versions. Slower; default false.",
        ),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap each returned document to roughly this many tokens."),
    },
    async ({ urls, fresh, max_tokens }) =>
      readUrls(urls, fresh ?? false, max_tokens),
  );

  server.tool(
    "check_usage",
    "Check your Lyrenth credit usage: plan tier, credits used against your " +
      "monthly limit, credits remaining, and the reset date. Takes no arguments.",
    {},
    async () => checkUsage(),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`lyrenth-mcp fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
