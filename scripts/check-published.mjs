#!/usr/bin/env node
/**
 * Compare every place a version of this server is published.
 *
 * The badge a user sees is not one number, it is five, maintained by five
 * different systems that can each fall behind on their own:
 *
 *   repo         package.json in this checkout
 *   npm          the lyrenth-mcp dist-tag `latest`
 *   registry     the isLatest record at registry.modelcontextprotocol.io
 *   live         serverInfo.version from the hosted endpoint
 *   release      the newest GitHub release tag
 *
 * A sixth, Anthropic's connector directory, has no public API. It ingests from
 * this repo on its own schedule, so it is reported as manual and never fails
 * the run.
 *
 * Usage:
 *   node scripts/check-published.mjs             # exit 1 on any mismatch
 *   node scripts/check-published.mjs --warn      # always exit 0, just report
 */
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const warnOnly = process.argv.includes("--warn");

const REPO = "lyrenth/lyrenth-mcp";
const LIVE = process.env.LYRENTH_MCP_ENDPOINT ?? "https://api.lyrenth.com/mcp";
const timeout = (ms) => AbortSignal.timeout(ms);

const probe = async (name, fn) => {
  try {
    return { name, ...(await fn()) };
  } catch (err) {
    return { name, version: null, note: `unreachable: ${err.message}` };
  }
};

const checks = await Promise.all([
  probe("repo", async () => ({ version: pkg.version, note: "package.json" })),

  probe("npm", async () => {
    const r = await fetch(`https://registry.npmjs.org/${pkg.name}`, { signal: timeout(20000) });
    const d = await r.json();
    return { version: d["dist-tags"]?.latest, note: `published ${(d.time?.[d["dist-tags"]?.latest] ?? "").slice(0, 10)}` };
  }),

  probe("registry", async () => {
    const r = await fetch(
      `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(server.name)}`,
      { signal: timeout(20000) }
    );
    const d = await r.json();
    const records = (d.servers ?? []).filter((s) => s.server?.name === server.name);
    const latest = records.find((s) => s._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest);
    if (!latest) return { version: null, note: `no isLatest record among ${records.length}` };
    const pkgVersions = (latest.server.packages ?? []).map((p) => p.version);
    const inner = pkgVersions.find((v) => v !== latest.server.version);
    return {
      version: latest.server.version,
      note: inner ? `packages[] disagrees: ${pkgVersions.join(", ")}` : `${records.length} records, packages[] agree`,
    };
  }),

  probe("live", async () => {
    const r = await fetch(LIVE, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drift-watch", version: "1.0" } },
      }),
      signal: timeout(20000),
    });
    const text = await r.text();
    const line = text.split("\n").find((l) => l.trim().startsWith("data:") || l.trim().startsWith("{"));
    const msg = JSON.parse(line.replace(/^data:\s*/, ""));
    return { version: msg.result?.serverInfo?.version, note: new URL(LIVE).host };
  }),

  probe("release", async () => {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "lyrenth-drift-watch" },
      signal: timeout(20000),
    });
    if (!r.ok) return { version: null, note: `GitHub API ${r.status}` };
    const d = await r.json();
    return { version: (d.tag_name ?? "").replace(/^v/, ""), note: `${(d.assets ?? []).length} asset(s)` };
  }),
]);

const truth = pkg.version;
const bad = checks.filter((c) => c.version !== truth);

const rows = checks.map((c) => {
  const mark = c.version === truth ? "ok  " : "DRIFT";
  return `  ${mark}  ${c.name.padEnd(9)} ${String(c.version ?? "unknown").padEnd(10)} ${c.note ?? ""}`;
});

const out = [
  `expected ${truth} (package.json)`,
  "",
  ...rows,
  "",
  "  n/a   anthropic  ingest cache, no public API. Check the connector listing by hand;",
  "        it re-syncs on Anthropic's schedule. Escalation: mcp-review@anthropic.com",
];

const text = out.join("\n");
console[bad.length ? "error" : "log"](text);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Published version drift\n\n\`\`\`\n${text}\n\`\`\`\n`);
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `drift=${bad.length ? "true" : "false"}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `report<<REPORT\n${text}\nREPORT\n`);
}
process.exit(bad.length && !warnOnly ? 1 : 0);
