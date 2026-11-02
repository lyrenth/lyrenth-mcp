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
 * A surface that does not answer is not a disagreement. Each request is tried
 * up to 3 times on a network error, a timeout or a 5xx answer. A surface that
 * still gives no readable answer is marked `?` with "could not check:", and is
 * counted apart from the surfaces that answered a different version.
 *
 * Usage:
 *   node scripts/check-published.mjs             # exit 1 unless every surface was checked and agrees
 *   node scripts/check-published.mjs --warn      # always exit 0, just report
 *
 * Under GitHub Actions it writes these step outputs:
 *   drift                true when a surface that answered disagrees
 *   unchecked            true when a surface could not be checked
 *   unchecked_surfaces   the names of those surfaces, comma separated
 *   report               the printed report
 *
 * The addresses default to the real surfaces. The tests point them at a local
 * stub with LYRENTH_MCP_NPM_URL, LYRENTH_MCP_REGISTRY_URL, LYRENTH_MCP_ENDPOINT
 * and LYRENTH_MCP_GITHUB_API_URL, and shorten the waits with
 * LYRENTH_MCP_CHECK_TIMEOUT_MS and LYRENTH_MCP_CHECK_RETRY_WAIT_MS.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const warnOnly = process.argv.includes("--warn");

const REPO = "lyrenth/lyrenth-mcp";
const NPM = process.env.LYRENTH_MCP_NPM_URL ?? "https://registry.npmjs.org";
const REGISTRY = process.env.LYRENTH_MCP_REGISTRY_URL ?? "https://registry.modelcontextprotocol.io";
const LIVE = process.env.LYRENTH_MCP_ENDPOINT ?? "https://api.lyrenth.com/mcp";
const GITHUB_API = process.env.LYRENTH_MCP_GITHUB_API_URL ?? "https://api.github.com";

// Per attempt. The registry's search timed out at 20 seconds on 2026-09-07,
// 10-05 and 10-19, and was reported as drift each time.
const TIMEOUT_MS = Number(process.env.LYRENTH_MCP_CHECK_TIMEOUT_MS) || 30000;
const RETRY_WAIT_MS = Number(process.env.LYRENTH_MCP_CHECK_RETRY_WAIT_MS) || 5000;
const ATTEMPTS = 3;

/** A surface that gave no answer this script can judge. */
class Unchecked extends Error {}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, tried up to ATTEMPTS times. A network error, a timeout or a 5xx
 * answer is tried again after RETRY_WAIT_MS. Any other answer is returned with
 * its body and never retried, whatever it says.
 */
async function request(url, init = {}) {
  let failure;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await wait(RETRY_WAIT_MS);
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = await r.text();
      if (r.status < 500) return { status: r.status, ok: r.ok, body };
      failure = `HTTP ${r.status}`;
    } catch (err) {
      failure = err.cause?.code ? `${err.message} (${err.cause.code})` : err.message;
    }
  }
  throw new Unchecked(`${failure}, after ${ATTEMPTS} attempts`);
}

/** The body of a 2xx answer as JSON. Any other answer could not be checked. */
function okJSON(res) {
  if (!res.ok) throw new Unchecked(`HTTP ${res.status}`);
  return JSON.parse(res.body);
}

const probe = async (name, fn) => {
  try {
    return { name, ...(await fn()) };
  } catch (err) {
    return { name, version: null, unchecked: true, note: `could not check: ${err.message}` };
  }
};

const official = (record) => record._meta?.["io.modelcontextprotocol.registry/official"];

const checks = await Promise.all([
  probe("repo", async () => ({ version: pkg.version, note: "package.json" })),

  probe("npm", async () => {
    const res = await request(`${NPM}/${pkg.name}`);
    if (res.status === 404) return { version: null, note: "not on npm" };
    const d = okJSON(res);
    return { version: d["dist-tags"]?.latest, note: `published ${(d.time?.[d["dist-tags"]?.latest] ?? "").slice(0, 10)}` };
  }),

  probe("registry", async () => {
    // One server's latest record. The search below lists every version ever
    // published and grows with each release; it stays as the fallback in case
    // the registry stops serving this route.
    const name = encodeURIComponent(server.name);
    const res = await request(`${REGISTRY}/v0.1/servers/${name}/versions/latest`);
    let latest;
    let source;
    if (res.status !== 404) {
      const d = okJSON(res);
      if (d.server?.name !== server.name || !official(d)?.isLatest) {
        return { version: null, note: "versions/latest answered no isLatest record" };
      }
      latest = d;
      source = "versions/latest";
    } else {
      const d = okJSON(await request(`${REGISTRY}/v0.1/servers?search=${name}`));
      const records = (d.servers ?? []).filter((s) => s.server?.name === server.name);
      latest = records.find((s) => official(s)?.isLatest);
      if (!latest) return { version: null, note: `no isLatest record among ${records.length}` };
      source = `${records.length} records`;
    }
    const pkgVersions = (latest.server.packages ?? []).map((p) => p.version);
    const inner = pkgVersions.find((v) => v !== latest.server.version);
    return {
      version: latest.server.version,
      note: inner ? `packages[] disagrees: ${pkgVersions.join(", ")}` : `${source}, packages[] agree`,
    };
  }),

  probe("live", async () => {
    const res = await request(LIVE, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drift-watch", version: "1.0" } },
      }),
    });
    if (!res.ok) throw new Unchecked(`HTTP ${res.status}`);
    const line = res.body.split("\n").find((l) => l.trim().startsWith("data:") || l.trim().startsWith("{"));
    if (!line) throw new Unchecked("no JSON-RPC message in the answer");
    const msg = JSON.parse(line.replace(/^data:\s*/, ""));
    return { version: msg.result?.serverInfo?.version, note: new URL(LIVE).host };
  }),

  probe("release", async () => {
    const res = await request(`${GITHUB_API}/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "lyrenth-drift-watch" },
    });
    if (res.status === 404) return { version: null, note: "GitHub API 404, no release" };
    if (!res.ok) throw new Unchecked(`GitHub API ${res.status}`);
    const d = JSON.parse(res.body);
    return { version: (d.tag_name ?? "").replace(/^v/, ""), note: `${(d.assets ?? []).length} asset(s)` };
  }),
]);

const truth = pkg.version;
const unchecked = checks.filter((c) => c.unchecked);
const bad = checks.filter((c) => !c.unchecked && c.version !== truth);
const names = (list) => list.map((c) => c.name).join(", ");

const rows = checks.map((c) => {
  const mark = c.unchecked ? "?   " : c.version === truth ? "ok  " : "DRIFT";
  return `  ${mark}  ${c.name.padEnd(9)} ${String(c.version ?? "unknown").padEnd(10)} ${c.note ?? ""}`;
});

const out = [
  `expected ${truth} (package.json)`,
  "",
  ...rows,
  "",
  `disagrees with package.json: ${names(bad) || "none"}`,
  `could not check: ${names(unchecked) || "none"}`,
  "",
  "  n/a   anthropic  ingest cache, no public API. Check the connector listing by hand;",
  "        it re-syncs on Anthropic's schedule. Escalation: mcp-review@anthropic.com",
];

const text = out.join("\n");
const failed = bad.length > 0 || unchecked.length > 0;
console[failed ? "error" : "log"](text);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Published version drift\n\n\`\`\`\n${text}\n\`\`\`\n`);
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `drift=${bad.length ? "true" : "false"}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `unchecked=${unchecked.length ? "true" : "false"}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `unchecked_surfaces=${names(unchecked)}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `report<<REPORT\n${text}\nREPORT\n`);
}
// A release must be confirmed everywhere, so without --warn a surface that
// could not be checked fails the run as a disagreement does.
process.exit(failed && !warnOnly ? 1 : 0);
