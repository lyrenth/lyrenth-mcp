# Publishing lyrenth-mcp to the official MCP registry

Step-by-step to list the server at <https://registry.modelcontextprotocol.io>.
We use **domain (DNS) authentication** with `lyrenth.com`, which gives the clean
`com.lyrenth/...` namespace and needs only a DNS TXT record (no code deploy).

Already done in this repo (committed):
- `package.json` carries `"mcpName": "com.lyrenth/lyrenth-mcp"` and is bumped to `0.1.1`.
- `server.json` is created, its `name` matches `mcpName`, and it points at the
  npm package `lyrenth-mcp@0.1.1`.
- `key.pem` / `*.pem` / `mcp-registry-auth` are gitignored so the DNS private key
  can never be committed.

Everything below runs from this folder: `cd integrations/lyrenth-mcp`.

## 1. Re-publish the npm package as 0.1.1

The registry verifies ownership of the npm package by reading its `mcpName`
field, so the **published** package must carry it. Our live `0.1.0` does not, so
republish `0.1.1` (which does). `npm publish` rebuilds via the `prepare` script.

```sh
npm publish
```

(Same npm token as before. You should see `+ lyrenth-mcp@0.1.1`.)

## 2. Install the registry publisher CLI

```sh
brew install mcp-publisher
```

## 3. Prove you own lyrenth.com (DNS) and log in

Generate an Ed25519 key pair and print the TXT record to add:

```sh
openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "lyrenth.com. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
```

Add the printed record at your DNS provider:
- **Host / name:** the apex, `lyrenth.com` (often entered as `@`)
- **Type:** `TXT`
- **Value:** `v=MCPv1; k=ed25519; p=<the public key it printed>`

Wait a few minutes for it to propagate, then log in (this reads the private key
from `key.pem`; the awk takes the lines between `priv:` and `pub:`, because
OpenSSL 4 prints the key on two lines where older versions used three):

```sh
PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | awk '/^priv:/{f=1;next} /^pub:/{f=0} f' | tr -d ' :\n')"
mcp-publisher login dns --domain lyrenth.com --private-key "${PRIVATE_KEY}"
```

You should see a success message. This grants the `com.lyrenth.*` namespace.

## 4. Publish to the registry

```sh
mcp-publisher publish
```

It reads `server.json` from the current directory and submits it. Then confirm
it shows up:

```sh
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=lyrenth" | python3 -m json.tool
```

## 5. Cleanup

- `key.pem` is your private key. It is gitignored. Keep it (or the DNS TXT
  record) somewhere safe if you want to publish updates later; otherwise delete
  `key.pem`. You can leave the TXT record in place.

## The public mirror is a projection of this folder

`https://github.com/lyrenth/lyrenth-mcp` is public, and since 2026-08-25 it
is never edited by hand: `npm run sync:mirror` projects this folder onto it
after running the release guards, and the owner commits and pushes the
mirror. `key.pem` and the built `.mcpb` are never copied.

The tool surface a release hands every npx and .mcpb user is
`release-tools.json`, checked against a real handshake by
`scripts/check-tools.mjs --strict` in the Release workflow. Today it is
three tools: `read_url`, `read_urls` and `check_usage`. The `search` tool is
in the source and registered only when `LYRENTH_MCP_SEARCH=1`.

**`plugin.json` and `manifest.json` are public copy, not package metadata.**
The Cursor directory renders `plugin.json`'s `description` verbatim in its
listing, so a stale sentence there is a stale sentence on someone else's
website. Neither file states the size of the index (owner, 2026-11-02): a number
there goes stale as the index grows, and a directory listing is not
something anyone updates every week.
Changing them here does nothing on its own: a directory sees the edit only
after the mirror is synced and pushed.

## Notes / gotchas

- **`repository` in `server.json`** points at `https://github.com/lyrenth/lyrenth-mcp`.
  If you have not created that public repo yet, either create it (a public mirror
  of this folder, which also doubles as the link for the awesome-mcp listing) or,
  if `mcp-publisher publish` rejects the missing repo, remove the `repository`
  block from `server.json`.
- **Schema version:** the registry is in preview and the `$schema` URL in
  `server.json` may move. If publish complains about the schema, run
  `mcp-publisher init` to see the current `$schema`/template and update
  `server.json` to match (keeping our `name`, `description`, `version`, and
  `packages`).
- **Updating later:** bump the version in both `package.json` and `server.json`,
  `npm publish`, then `mcp-publisher publish` again (re-login if the session
  expired).

## Alternative: GitHub namespace

If you would rather use a GitHub namespace than DNS, log in with
`mcp-publisher login github` (device-flow) and change the `name` in `server.json`
(and `mcpName` in `package.json`) to `io.github.<your-lyrenth-github-username>/lyrenth-mcp`.
DNS is recommended here because it gives the on-brand `com.lyrenth/...` name and
does not depend on a GitHub account name.
