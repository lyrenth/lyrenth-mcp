# Lyrenth MCP server

Read the web through [Lyrenth](https://lyrenth.com) from any MCP client.

Exposes one tool, `read_url`, that turns a public web page into a clean
**AIDocument**: stable Markdown plus title, description, and structure, with the
navigation and boilerplate stripped. Your agent reads cleaned, low-token content
instead of raw HTML. Reads resolve through Lyrenth's cross-caller cache, and for
verified domains they return the publisher's canonical version.

## Setup

1. Get a free API key at <https://lyrenth.com/signup> (2,000 reads/month, no card).
2. Add the server to your MCP client.

### Claude Desktop / Cursor

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

## Tool

| Tool | Arguments | Returns |
|------|-----------|---------|
| `read_url` | `url` (string, required), `fresh` (boolean, optional) | The page as a clean AIDocument: a short provenance header plus the Markdown body. `fresh: true` forces a fresh fetch instead of the cached copy. |

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

## Local build

```sh
npm install
npm run build
LYRENTH_API_KEY=aiwk_... node dist/index.js   # speaks MCP over stdio
```

Part of the [Lyrenth](https://lyrenth.com) project. The AIDocument format is an
open contract; see <https://lyrenth.com/llms-full.txt>.
