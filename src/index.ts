#!/usr/bin/env node
/**
 * Lyrenth MCP server, stdio transport.
 *
 * This is the `npx -y lyrenth-mcp` path: a local process an MCP client
 * (Claude Desktop, Claude Code, Cursor, and so on) starts and talks to
 * over a pipe. The tools themselves live in tools.ts and are shared with
 * the hosted HTTP server in http.ts, so the two can never drift.
 *
 * Tools:
 *   - search: find pages in the Lyrenth index by query, with the read
 *     action and its access terms attached to every hit.
 *   - read_url: turn any public web page into a clean AIDocument
 *     (Markdown + title/description + structure), optionally capped to a
 *     max_tokens budget.
 *   - read_urls: the same for up to 20 URLs in one batch call.
 *   - check_usage: report the caller's plan tier + credit usage.
 * So an MCP client reads the web through Lyrenth instead of a raw fetch.
 * Reads resolve through Lyrenth's cross-caller cache, and for verified
 * domains they return the publisher's canonical version.
 *
 * Config (env):
 *   LYRENTH_API_KEY   required. Free key at https://lyrenth.com/signup
 *   LYRENTH_API_URL   optional. Default https://api.lyrenth.com
 *
 * The key comes from the environment here, and only here. One local
 * process serves one person, so their own environment is the right place
 * for their credential. The hosted HTTP server takes the key from each
 * request instead, because it serves everybody.
 *
 * Speaks MCP over stdio. stdout is reserved for the protocol; all
 * diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { normalizeApiBase, registerTools } from "./tools.js";

async function main(): Promise<void> {
  const server = new McpServer({ name: "lyrenth", version: "0.1.5" });

  registerTools(server, {
    apiBase: normalizeApiBase(process.env.LYRENTH_API_URL),
    resolveApiKey: () => process.env.LYRENTH_API_KEY ?? "",
    missingKeyMessage:
      "LYRENTH_API_KEY is not set. Get a free key at https://lyrenth.com/signup and add it to this server's config.",
    includeSearch: true,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`lyrenth-mcp fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
