# Lyrenth MCP server

[![lyrenth-mcp MCP server](https://glama.ai/mcp/servers/lyrenth/lyrenth-mcp/badges/card.svg)](https://glama.ai/mcp/servers/lyrenth/lyrenth-mcp)

[![MCP Badge](https://lobehub.com/badge/mcp-full/lyrenth-lyrenth-mcp)](https://lobehub.com/mcp/lyrenth-lyrenth-mcp)

Read the web through [Lyrenth](https://lyrenth.com)'s index from any MCP client.

Exposes three tools:

- **`read_url`** turns a public web page into a clean **AIDocument**: stable
  Markdown plus title, description, and structure, with the navigation and
  boilerplate stripped. Your agent reads cleaned, low-token content instead of
  raw HTML, and every result shows how many tokens it saved vs the raw page.
- **`read_urls`** does the same for up to 20 URLs in one batch call.
- **`check_usage`** reports your plan tier and credit usage.

Reads resolve through Lyrenth's cross-caller cache, and for verified domains
they return the publisher's canonical version.

## Setup

1. Get a free API key at <https://lyrenth.com/signup> (2,000 reads/month, no card).
2. Add the server to your MCP client.

### Claude Desktop (one click)

Download `lyrenth-mcp.mcpb` from the
[latest release](https://github.com/lyrenth/lyrenth-mcp/releases/latest) and
open it. Claude Desktop installs the server and asks for your API key; there is
no config file to edit. The bundle carries the same code as the npm package.

To build it yourself: `./scripts/build-mcpb.sh`.

### Claude Desktop / Cursor (manual config)

Add to your MCP config (Claude Desktop: `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lyrenth": {
      "command": "npx",
      "args": ["-y", "lyrenth-mcp"],
      "env": { "LYRENTH_API_KEY": "aiwk_your_key_here" }
    }
  }
}
```

### Claude Code

```sh
claude mcp add lyrenth -e LYRENTH_API_KEY=aiwk_your_key_here -- npx -y lyrenth-mcp
```

Then ask your assistant to read a page, for example: *"Read
https://example.com/article and summarize it."* It will call `read_url` and get
the cleaned AIDocument back.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `read_url` | `url` (string, required), `fresh` (boolean, optional), `max_tokens` (integer, optional) | The page as a clean AIDocument: a short provenance header (token count + how much smaller than raw HTML) plus the Markdown body. `fresh: true` forces a fresh fetch instead of the cached copy; `max_tokens` caps the body to your context budget, trimmed at a clean paragraph or sentence boundary. |
| `read_urls` | `urls` (array of 1-20 strings, required), `fresh` (boolean, optional), `max_tokens` (integer, optional) | Up to 20 pages in one call, each as a clean AIDocument, with per-URL error isolation (a failed URL is reported and doesn't block the others). Billed one credit per successfully-read URL. |
| `check_usage` | none | Your plan tier, credits used against your monthly limit, credits remaining, and the reset date. |

## Configuration

| Env var | Required | Default | Notes |
|---------|----------|---------|-------|
| `LYRENTH_API_KEY` | yes | none | Free key at <https://lyrenth.com/signup> |
| `LYRENTH_API_URL` | no | `https://api.lyrenth.com` | Override for staging or self-host |

## Why read through Lyrenth

- **Cleaner, cheaper.** One stable AIDocument shape per URL; far fewer tokens
  than raw HTML to a model.
- **Cached across callers.** The same URL fetched by many agents collapses to a
  minimal number of origin fetches, so it is fast and origin-friendly.
- **Canonical when verified.** When a site's owner has verified with Lyrenth,
  you get the version they authored, kept fresh by their change signal.

## Privacy

The server sends exactly two things to Lyrenth's API (api.lyrenth.com): the
URLs you ask it to read, and your API key to authenticate and meter the call.
Nothing else leaves your machine: no page content you hold locally, no
conversation context, no telemetry. How Lyrenth handles fetched pages and
account data is covered by the privacy policy:
<https://www.lyrenth.com/privacy>.

## License

MIT. See [LICENSE](LICENSE).

## Local build

```sh
npm install
npm run build
LYRENTH_API_KEY=aiwk_... node dist/index.js   # speaks MCP over stdio
```

Part of the [Lyrenth](https://lyrenth.com) project. The AIDocument format is an
open contract; see <https://lyrenth.com/llms-full.txt>.
