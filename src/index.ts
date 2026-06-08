#!/usr/bin/env node
/**
 * Lyrenth MCP server.
 *
 * Exposes a `read_url` tool that turns any public web page into a clean
 * AIDocument (Markdown + title/description + structure), so an MCP client
 * (Claude Desktop, Claude Code, Cursor, ...) reads the web through Lyrenth
 * instead of a raw fetch. Reads resolve through Lyrenth's cross-caller cache,
 * and for verified domains they return the publisher's canonical version.
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

const API_BASE = (process.env.LYRENTH_API_URL ?? "https://api.lyrenth.com").replace(
  /\/+$/,
  "",
);
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
  const markdown: string = d.content?.markdown ?? "";

  const metaLine = [
    source.status_code ? `status ${source.status_code}` : null,
    source.render_mode ? `render ${source.render_mode}` : null,
    typeof signals.word_count === "number" ? `${signals.word_count} words` : null,
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

async function readUrl(url: string, fresh: boolean): Promise<TextResult> {
  if (!API_KEY) {
    return textResult(
      "LYRENTH_API_KEY is not set. Get a free key at https://lyrenth.com/signup and add it to this server's config.",
      true,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/aidocument`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        freshness_policy: fresh ? "force_refresh" : "cache_first",
      }),
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

async function main(): Promise<void> {
  const server = new McpServer({ name: "lyrenth", version: "0.1.0" });

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
    },
    async ({ url, fresh }) => readUrl(url, fresh ?? false),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`lyrenth-mcp fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
