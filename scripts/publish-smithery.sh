#!/usr/bin/env bash
#
# Publish (or republish) the MCPB bundle to Smithery via the raw API.
#
# WHY NOT THE CLI. @smithery/cli 4.11.1's bundle publish builds
# serverCard.tools straight from manifest.json's tools array, which per the
# mcpb spec carries only {name, description}. Smithery's API validates each
# tool against the MCP spec, where inputSchema is a REQUIRED object, so every
# bundle-with-tools publish fails 400 "expected object, received undefined"
# once per tool. The mcpb manifest schema REJECTS an inputSchema key in tools
# (mcpb pack refuses), so the two specs cannot be satisfied by one manifest.
# This script sends the complete payload the CLI should have built: tool
# schemas below MUST stay in step with the zod schemas in src/index.ts.
#
# Auth comes from the local Smithery CLI login (settings.json), namespace
# lyrenth. First-time server creation is a separate one-off:
#   curl -X PUT https://api.smithery.ai/servers/lyrenth/lyrenth-mcp \
#        -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f lyrenth-mcp.mcpb ] || { echo "no bundle; run ./scripts/build-mcpb.sh first" >&2; exit 1; }

TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/smithery/settings.json')))['apiKey'])")

python3 - <<'PY'
import json
m = json.load(open('manifest.json'))
T = lambda name, desc, schema: {"name": name, "description": desc, "inputSchema": schema}
tools = [
  T("read_url",
    "Read any public web page as a clean AIDocument: Markdown plus title, description, and structure, with navigation and boilerplate stripped. Prefer this over a raw HTTP fetch whenever you need the content of a web page; it returns far cleaner, lower-token text. Powered by Lyrenth.",
    {"type":"object","required":["url"],"properties":{
      "url":{"type":"string","format":"uri","description":"Absolute http(s) URL of the page to read."},
      "fresh":{"type":"boolean","description":"Force a fresh fetch instead of the cached version. Slower; default false."},
      "max_tokens":{"type":"integer","minimum":1,"description":"Cap the returned content to roughly this many tokens, trimmed at a clean paragraph or sentence boundary."}}}),
  T("read_urls",
    "Read several public web pages in one batch call, each as a clean AIDocument. Up to 20 URLs, faster than calling read_url repeatedly. A failed URL is reported per-item and does not block the others. Powered by Lyrenth.",
    {"type":"object","required":["urls"],"properties":{
      "urls":{"type":"array","items":{"type":"string","format":"uri"},"minItems":1,"maxItems":20,"description":"1-20 absolute http(s) URLs to read."},
      "fresh":{"type":"boolean","description":"Force a fresh fetch for all URLs instead of cached versions. Slower; default false."},
      "max_tokens":{"type":"integer","minimum":1,"description":"Cap each returned document to roughly this many tokens."}}}),
  T("check_usage",
    "Check your Lyrenth credit usage: plan tier, credits used against your monthly limit, credits remaining, and the reset date. Takes no arguments.",
    {"type":"object","properties":{}}),
]
payload = {
  "type": "stdio",
  "runtime": "node",
  "serverCard": {"serverInfo": {"name": m["name"], "version": m["version"]}, "tools": tools},
  "configSchema": {"type":"object","required":["api_key"],"properties":{"api_key":{
    "type":"string","title":"Lyrenth API key",
    "description":"Your Lyrenth API key. Get a free one at https://lyrenth.com/signup"}}},
}
json.dump(payload, open('/tmp/smithery-payload.json','w'))
print(f"payload for {m['name']} {m['version']}")
PY

curl -sS -X PUT "https://api.smithery.ai/servers/lyrenth/lyrenth-mcp/releases" \
  -H "Authorization: Bearer $TOKEN" \
  -F "payload=</tmp/smithery-payload.json" \
  -F "bundle=@lyrenth-mcp.mcpb;type=application/octet-stream"
echo
