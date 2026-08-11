# Installing lyrenth-mcp (instructions for an AI assistant)

You are setting up the Lyrenth MCP server for a user. It gives them three
tools: `read_url`, `read_urls`, and `check_usage`. Follow these steps in order.

## What you need from the user

A Lyrenth API key, which looks like `aiwk_...`. If the user does not have one,
tell them to get a free key at <https://lyrenth.com/signup> and wait for them to
paste it. Do not proceed without it, and do not invent a placeholder value: the
server starts without a key but every tool call fails with an authentication
error, which looks like a broken install.

## Requirements

Node.js 18 or newer, already on the user's machine. There is nothing to clone,
compile, or install ahead of time: the config below runs the published npm
package with `npx`, which fetches it on first use.

## Configuration

Add this server entry to the user's MCP settings file, merging it into any
existing `mcpServers` object rather than replacing the file:

```json
{
  "mcpServers": {
    "lyrenth": {
      "command": "npx",
      "args": ["-y", "lyrenth-mcp"],
      "env": { "LYRENTH_API_KEY": "aiwk_the_users_key" }
    }
  }
}
```

Replace `aiwk_the_users_key` with the key the user gave you.

For Cline, the file is `cline_mcp_settings.json` in the extension's global
storage directory. For Claude Desktop it is `claude_desktop_config.json`. If
you are unsure which file the host uses, ask rather than guessing, and never
write the key into a file the user has not agreed to.

## Verify the install

Restart the MCP host so it picks up the new server, then confirm two things:

1. The server connects and exposes exactly three tools: `read_url`,
   `read_urls`, `check_usage`.
2. A real call succeeds. Call `check_usage` first, because it takes no
   arguments and returns the user's plan tier and remaining credits, so it
   proves the key works without spending a read. Then call `read_url` on
   `https://example.com` and confirm you get Markdown back with a short
   provenance header.

If `check_usage` reports an authentication failure, the key is wrong or was not
picked up: re-check the `LYRENTH_API_KEY` value in the config and that the host
was restarted.

## Notes

- Reads resolve through Lyrenth's shared cache. Pass `fresh: true` only when
  the user explicitly needs an uncached fetch; it is slower.
- `read_urls` takes 1 to 20 URLs in one call and isolates failures per URL, so
  prefer it over repeated `read_url` calls when reading several pages.
- `max_tokens` caps a document at roughly that many tokens, trimmed at a clean
  paragraph or sentence boundary. Use it when the context budget is tight.
- The free tier is metered per read; `check_usage` shows the remaining
  allowance and the reset date.
