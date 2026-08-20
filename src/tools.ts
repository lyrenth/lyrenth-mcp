/**
 * The Lyrenth tools, shared by both transports.
 *
 * `index.ts` runs these over stdio (the `npx -y lyrenth-mcp` path) and
 * `http.ts` runs the same set over streamable HTTP (the hosted endpoint).
 * The tool code lives here so the two transports can never drift: a tool
 * description, an argument, or an error string is written once.
 *
 * The one thing the transports do differently is WHERE THE API KEY COMES
 * FROM, so that is an argument (`resolveApiKey`) rather than a global.
 * Over stdio the key is a local environment variable belonging to the one
 * person running the process. Over HTTP the key arrives on each request in
 * the Authorization header and belongs to whoever sent it. A hosted
 * endpoint that fell back to its own environment variable would spend one
 * account's credits on everybody's reads, so the HTTP resolver never does.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * The part of the MCP request context the tools care about. The SDK hands
 * each tool callback a much larger object; this is the structural subset,
 * so nothing here depends on the SDK's internal request types.
 */
export interface AuthCarrier {
  authInfo?: { token?: string };
}

export interface ToolContext {
  /** Base URL of the upstream Lyrenth API, no trailing slash. */
  apiBase: string;
  /** Pulls the caller's Lyrenth api key out of one MCP request. */
  resolveApiKey: (extra: AuthCarrier) => string;
  /** What to tell the caller when resolveApiKey comes back empty. */
  missingKeyMessage: string;
  /**
   * Register the search tool.
   *
   * True over stdio, which is what ships on npm today. False on the hosted
   * endpoint until search is generally available: a public listing that
   * advertises a tool answering "not enabled for this key yet" is a broken
   * promise, and the endpoint is a public surface. Flip it with
   * LYRENTH_MCP_SEARCH=1 on the day search serves.
   */
  includeSearch: boolean;
}

export type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function textResult(text: string, isError = false): TextResult {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Resolve an API base URL. Strip trailing slashes, and tolerate a
 * scheme-less value (for example "api.lyrenth.com") by defaulting it to
 * https. A bare host with no scheme is the most common config mistake
 * (it is what some MCP hosts put in the URL field) and otherwise makes
 * fetch() throw "Failed to parse URL from api.lyrenth.com/v1/aidocument"
 * before the request is ever sent.
 */
export function normalizeApiBase(raw: string | undefined): string {
  const value = (raw ?? "https://api.lyrenth.com").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * One upstream call: send it, check the status, decode the JSON. Returns
 * either the decoded body or the exact TextResult to hand back to the
 * caller, so every tool reports a network failure, an HTTP error and an
 * undecodable body in the same words.
 *
 * Every path this reaches is on the api's bearer allowlist (POST
 * /v1/aidocument, POST /v1/aidocument/batch, GET /v1/read, GET
 * /v1/document, POST /v1/submit, GET /v1/quota, plus /v1/search when the
 * search tool is registered). An api key cannot call anything else: the
 * product gate answers 403 for the whole account surface.
 */
async function callApi(
  ctx: ToolContext,
  apiKey: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<{ ok: true; data: unknown } | { ok: false; result: TextResult }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${ctx.apiBase}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (e) {
    return {
      ok: false,
      result: textResult(`Failed to reach Lyrenth: ${(e as Error).message}`, true),
    };
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    return {
      ok: false,
      result: textResult(`Lyrenth returned HTTP ${res.status}. ${detail}`.trim(), true),
    };
  }

  try {
    return { ok: true, data: await res.json() };
  } catch (e) {
    return {
      ok: false,
      result: textResult(
        `Lyrenth returned an unparseable response: ${(e as Error).message}`,
        true,
      ),
    };
  }
}

/**
 * Render the v2 AIDocument envelope into a compact, model-friendly block:
 * a short provenance header followed by the cleaned Markdown body.
 */
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

async function readUrl(
  ctx: ToolContext,
  apiKey: string,
  url: string,
  fresh: boolean,
  maxTokens?: number,
): Promise<TextResult> {
  const body: Record<string, unknown> = {
    url,
    freshness_policy: fresh ? "force_refresh" : "cache_first",
  };
  if (typeof maxTokens === "number" && maxTokens > 0) {
    body.max_tokens = Math.floor(maxTokens);
  }

  const call = await callApi(ctx, apiKey, "/v1/aidocument", { method: "POST", body });
  if (!call.ok) return call.result;
  return textResult(formatDoc(call.data, url));
}

/**
 * read_urls resolves several URLs in one batch call (POST
 * /v1/aidocument/batch), each to a clean AIDocument, with per-URL error
 * isolation.
 */
async function readUrls(
  ctx: ToolContext,
  apiKey: string,
  urls: string[],
  fresh: boolean,
  maxTokens?: number,
): Promise<TextResult> {
  if (!urls.length) return textResult("Provide at least one URL.", true);

  const body: Record<string, unknown> = {
    urls,
    freshness_policy: fresh ? "force_refresh" : "cache_first",
  };
  if (typeof maxTokens === "number" && maxTokens > 0) {
    body.max_tokens = Math.floor(maxTokens);
  }

  const call = await callApi(ctx, apiKey, "/v1/aidocument/batch", {
    method: "POST",
    body,
  });
  if (!call.ok) return call.result;

  const payload = (call.data ?? {}) as { results?: any[] };
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

/**
 * check_usage reports the caller's Lyrenth credit usage (tier, used vs
 * limit, remaining, reset) from /v1/quota.
 */
async function checkUsage(ctx: ToolContext, apiKey: string): Promise<TextResult> {
  const call = await callApi(ctx, apiKey, "/v1/quota", { method: "GET" });
  if (!call.ok) return call.result;

  const q = (call.data ?? {}) as Record<string, any>;
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

/**
 * Render one /v1/search hit as a compact block. The read action and its
 * access terms are part of the line on purpose: an agent choosing what to
 * open should see what opening it costs before it decides.
 */
function formatHit(hit: Record<string, any>, index: number): string {
  const score = typeof hit.score === "number" ? ` (score ${hit.score})` : "";
  // Description before snippet: the description is the page's own summary,
  // while the snippet is the head of the indexed body and often opens on
  // markdown image syntax, which tells a model nothing about the page.
  const summary: string = (hit.description || hit.snippet || "").replace(/\s+/g, " ").trim();

  const read = hit.read ?? {};
  const access: string = read.access ?? "free";
  const price = read.price_usd;
  const readLine =
    access === "paid" && typeof price === "number"
      ? `read: paid, $${price} per read via ${read.endpoint ?? "/v1/aidocument"}`
      : `read: ${access} via ${read.endpoint ?? "/v1/aidocument"}`;

  const license: string = hit.license ?? "none";
  const facts = [
    `license: ${license}`,
    readLine,
    hit.sponsored ? "SPONSORED" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return [
    `${index}. ${hit.title || "(untitled)"}${score}`,
    `   ${hit.url ?? ""}`,
    summary ? `   ${summary.slice(0, 300)}` : null,
    `   ${facts}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * search queries the Lyrenth index (POST /v1/search) and returns a compact
 * ranked list. Organic results and sponsored results arrive in separate
 * arrays and are kept separate here too, each labeled for what it is.
 */
async function search(
  ctx: ToolContext,
  apiKey: string,
  query: string,
  limit?: number,
  country?: string,
  language?: string,
): Promise<TextResult> {
  const body: Record<string, unknown> = { query };
  if (typeof limit === "number" && limit > 0) body.limit = Math.floor(limit);
  const filters: Record<string, string> = {};
  if (country) filters.country = country.toUpperCase();
  if (language) filters.language = language;
  if (Object.keys(filters).length) body.filters = filters;

  const call = await callApi(ctx, apiKey, "/v1/search", { method: "POST", body });
  if (!call.ok) {
    // The search route is not mounted on deployments where search is not
    // enabled, so a 404 here means exactly that. Say so plainly rather
    // than reporting it as an HTTP failure the caller could do something
    // about.
    const text = call.result.content[0]?.text ?? "";
    if (text.startsWith("Lyrenth returned HTTP 404.")) {
      return textResult("Search is not enabled for this key yet.");
    }
    return call.result;
  }

  const payload = (call.data ?? {}) as {
    results?: any[];
    sponsored?: any[];
    meta?: Record<string, any>;
  };
  const results = payload.results ?? [];
  const sponsored = payload.sponsored ?? [];
  const meta = payload.meta ?? {};

  if (!results.length && !sponsored.length) {
    return textResult(`No results for "${query}".`);
  }

  const headerBits = [
    `${results.length} result${results.length === 1 ? "" : "s"} for "${query}"`,
    typeof meta.total_estimate === "number"
      ? `~${meta.total_estimate.toLocaleString()} matched`
      : null,
    typeof meta.took_ms === "number" ? `${meta.took_ms}ms` : null,
    meta.country ? `country ${meta.country}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const blocks = results.map((r, i) => formatHit(r, i + 1));
  if (sponsored.length) {
    blocks.push(
      "Sponsored (never ranked against the results above):",
      ...sponsored.map((r, i) => formatHit(r, i + 1)),
    );
  }
  return textResult([headerBits, "", ...blocks].join("\n"));
}

/**
 * Every Lyrenth tool carries the same three annotations, declared rather
 * than left to a client's defaults, because the OpenAI Apps review reads
 * them and an unset hint is not the same as a false one.
 *
 *   readOnlyHint    true:  a call reads a page or a counter and changes
 *                          nothing on the caller's account or on the web.
 *   destructiveHint false: nothing is deleted, overwritten or undone.
 *   openWorldHint   true:  the tools reach the public internet, so the
 *                          set of things they can return is open ended.
 *
 * idempotentHint is deliberately left unset. A repeat read is not
 * guaranteed to give byte-identical output (a page changes, a cached copy
 * expires), so claiming it would be a hint we cannot honour.
 */
const READ_ONLY_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

/**
 * Build the annotations block for one tool.
 *
 * The title is set in TWO places on purpose, here inside `annotations`
 * and again as the tool's own `title` field where registerTool puts it.
 * The current spec's home for it is the top-level field, but version
 * 0.1.5 shipped it inside annotations and that is where the directory
 * reviews that already passed went looking. Writing both costs nothing
 * and cannot regress either reader.
 */
function readOnlyAnnotations(title: string) {
  return { title, ...READ_ONLY_HINTS };
}

/**
 * Register the Lyrenth tools on an MCP server.
 *
 * Called once per server instance. In stateless HTTP mode that is once per
 * request, which is cheap: registration only builds schema objects.
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  /**
   * Resolve the key for one call, or hand back the message explaining
   * what is missing. Every tool starts with this, so a call with no
   * credential is answered the same way everywhere.
   */
  const withKey = async (
    extra: AuthCarrier,
    run: (apiKey: string) => Promise<TextResult>,
  ): Promise<TextResult> => {
    const apiKey = ctx.resolveApiKey(extra);
    if (!apiKey) return textResult(ctx.missingKeyMessage, true);
    return run(apiKey);
  };

  if (ctx.includeSearch) {
    server.registerTool(
      "search",
      {
        title: "Search the index",
        description:
          "Search the Lyrenth index for web pages matching a query, and get back a " +
          "ranked list with the title, URL, snippet and the exact read action for " +
          "each hit. Use it to FIND pages, then read_url to open the ones worth " +
          "opening. Every hit says what reading it costs, so a priced page is " +
          "visible before you open it. Powered by Lyrenth.",
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(512)
            .describe("What to search for. Plain words work best; max 512 characters."),
          limit: z
            .number()
            .int()
            .positive()
            .max(50)
            .optional()
            .describe("How many results to return, 1-50. Default 10."),
          country: z
            .string()
            .length(2)
            .optional()
            .describe(
              "ISO 3166-1 alpha-2 country of the person you are searching for (for example CH, US). State it when you know it: your own server's location is usually not where your user is.",
            ),
          language: z
            .string()
            .optional()
            .describe("Restrict results to this language code (for example en, de)."),
        },
        annotations: readOnlyAnnotations("Search the index"),
      },
      async ({ query, limit, country, language }, extra) =>
        withKey(extra, (key) => search(ctx, key, query, limit, country, language)),
    );
  }

  server.registerTool(
    "read_url",
    {
      title: "Read URL",
      description:
        "Read any public web page as a clean AIDocument: Markdown plus title, " +
        "description, and structure, with navigation and boilerplate stripped. " +
        "Prefer this over a raw HTTP fetch whenever you need the content of a web " +
        "page; it returns far cleaner, lower-token text. Powered by Lyrenth.",
      inputSchema: {
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
      annotations: readOnlyAnnotations("Read URL"),
    },
    async ({ url, fresh, max_tokens }, extra) =>
      withKey(extra, (key) => readUrl(ctx, key, url, fresh ?? false, max_tokens)),
  );

  server.registerTool(
    "read_urls",
    {
      title: "Read URLs (batch)",
      description:
        "Read several public web pages in one batch call, each as a clean " +
        "AIDocument. Up to 20 URLs, faster than calling read_url repeatedly. Use " +
        "it to compare or summarize multiple pages at once; a failed URL is " +
        "reported per-item and does not block the others. Powered by Lyrenth.",
      inputSchema: {
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
      annotations: readOnlyAnnotations("Read URLs (batch)"),
    },
    async ({ urls, fresh, max_tokens }, extra) =>
      withKey(extra, (key) => readUrls(ctx, key, urls, fresh ?? false, max_tokens)),
  );

  server.registerTool(
    "check_usage",
    {
      title: "Check usage",
      description:
        "Check your Lyrenth credit usage: plan tier, credits used against your " +
        "monthly limit, credits remaining, and the reset date. Takes no arguments.",
      inputSchema: {},
      annotations: readOnlyAnnotations("Check usage"),
    },
    async (_args, extra) => withKey(extra, (key) => checkUsage(ctx, key)),
  );
}
