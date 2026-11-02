/**
 * Tests for the release check (scripts/check-published.mjs), which the
 * drift watch runs every week with --warn and the release workflow runs
 * after a publish.
 *
 * Run with:  npm test
 *
 * Every published surface (npm, the MCP registry, the hosted endpoint and
 * GitHub releases) is a stub on one local port, so the tests need no network
 * and contact nothing that is published. Each test sets how its surfaces
 * answer and counts the requests each one receives.
 *
 * The case these tests exist for: on 2026-09-07, 10-05 and 10-19 the drift
 * watch reported the registry as drift because its search timed out. A
 * surface that does not answer could not be checked; it does not disagree.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(HERE, "..");
const SCRIPT = path.join(PACKAGE_DIR, "scripts", "check-published.mjs");
const pkg = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));
const serverName = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "server.json"), "utf8")).name;

/** The version every surface should report: the one in package.json. */
const VERSION = pkg.version;
const LATEST_ROUTE = `/registry/v0.1/servers/${encodeURIComponent(serverName)}/versions/latest`;

/** One registry record, as the registry serves it. */
function registryRecord(version) {
  return {
    server: {
      name: serverName,
      version,
      packages: [{ registryType: "npm", identifier: pkg.name, version, transport: { type: "stdio" } }],
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  };
}

/** A registry whose latest record, on the latest version route and in the search, is `version`. */
function registryAnswering(version) {
  return (req, res) => {
    if (req.url === LATEST_ROUTE) return sendJSON(res, 200, registryRecord(version));
    if (req.url.startsWith("/registry/v0.1/servers?search=")) {
      return sendJSON(res, 200, { servers: [registryRecord(version)], metadata: { count: 1 } });
    }
    sendJSON(res, 404, { title: "Not Found", status: 404 });
  };
}

function sendJSON(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Each surface answering the version in package.json, as it does after a good release. */
const RIGHT_ANSWERS = {
  npm: (req, res) =>
    sendJSON(res, 200, { "dist-tags": { latest: VERSION }, time: { [VERSION]: "2026-11-02T03:21:45.000Z" } }),
  registry: registryAnswering(VERSION),
  live: (req, res) =>
    sendJSON(res, 200, {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "lyrenth", version: VERSION } },
    }),
  release: (req, res) => sendJSON(res, 200, { tag_name: `v${VERSION}`, assets: [{ name: "lyrenth-mcp.mcpb" }] }),
};

/** An answer that never comes. The check's own timeout ends the request. */
const NEVER_ANSWER = () => {};

/** How each surface answers in the current test, and how many requests it has had. */
let answers;
let hits;

let stub;
let stubUrl;

/** The surface a stub request is for, from its path prefix. */
function surfaceOf(url) {
  if (url.startsWith("/npm/")) return "npm";
  if (url.startsWith("/registry/")) return "registry";
  if (url.startsWith("/mcp")) return "live";
  if (url.startsWith("/github/")) return "release";
  return null;
}

function startStub() {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const surface = surfaceOf(req.url);
        if (!surface) return sendJSON(res, 404, { error: "no such surface" });
        hits[surface] += 1;
        answers[surface](req, res, hits[surface]);
      });
    });
    stub.listen(0, "127.0.0.1", () => {
      stubUrl = `http://127.0.0.1:${stub.address().port}`;
      resolve();
    });
  });
}

/** Read the key=value and key<<DELIMITER lines the script appends to GITHUB_OUTPUT. */
function parseOutputs(raw) {
  const out = {};
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heredoc = lines[i].match(/^(\w+)<<(.+)$/);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], i + 1);
      out[heredoc[1]] = lines.slice(i + 1, end).join("\n");
      i = end;
    } else if (lines[i].includes("=")) {
      const at = lines[i].indexOf("=");
      out[lines[i].slice(0, at)] = lines[i].slice(at + 1);
    }
  }
  return out;
}

/**
 * Run the check against the stub and return its exit code, its printed
 * report and its GitHub outputs. Timeouts and waits are short so a surface
 * that never answers costs well under a second.
 */
function runCheck(args = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "check-published-"));
  const outputFile = path.join(dir, "output");
  const summaryFile = path.join(dir, "summary");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");
  const env = {
    ...process.env,
    LYRENTH_MCP_NPM_URL: `${stubUrl}/npm`,
    LYRENTH_MCP_REGISTRY_URL: `${stubUrl}/registry`,
    LYRENTH_MCP_ENDPOINT: `${stubUrl}/mcp`,
    LYRENTH_MCP_GITHUB_API_URL: `${stubUrl}/github`,
    LYRENTH_MCP_CHECK_TIMEOUT_MS: "300",
    LYRENTH_MCP_CHECK_RETRY_WAIT_MS: "20",
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`check-published did not finish:\n${text}`));
    }, 60000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const outputs = parseOutputs(readFileSync(outputFile, "utf8"));
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, text, outputs });
    });
  });
}

/** The mark, version and note of one surface's row in the report. */
function rowOf(text, surface) {
  const line = text.split("\n").find((l) => new RegExp(`^  \\S+\\s+${surface} `).test(l));
  assert.ok(line, `no ${surface} row in:\n${text}`);
  const [, mark, version, note] = line.match(/^  (\S+)\s+\S+\s+(\S+)\s*(.*)$/);
  return { mark, version, note };
}

before(async () => {
  await startStub();
});

beforeEach(() => {
  answers = { ...RIGHT_ANSWERS };
  hits = { npm: 0, registry: 0, live: 0, release: 0 };
});

after(() => {
  if (stub) {
    stub.closeAllConnections();
    stub.close();
  }
});

describe("check-published", () => {
  it("reports every surface ok and exits 0 when each one answers the version in package.json", async () => {
    const { code, text, outputs } = await runCheck();

    assert.equal(code, 0, text);
    for (const surface of ["repo", "npm", "registry", "live", "release"]) {
      assert.equal(rowOf(text, surface).mark, "ok", text);
    }
    assert.equal(outputs.drift, "false");
    assert.equal(outputs.unchecked, "false");
    assert.match(outputs.report, /^expected /);
  });

  it("reports a registry that never answers in time as could not check, and --warn writes drift=false and exits 0", async () => {
    answers.registry = NEVER_ANSWER;
    const { code, text, outputs } = await runCheck(["--warn"]);

    assert.equal(code, 0, text);
    const row = rowOf(text, "registry");
    assert.equal(row.mark, "?", text);
    assert.match(row.note, /^could not check: /);
    assert.equal(hits.registry, 3, "a timeout is tried again, 3 attempts in all");
    assert.match(text, /^disagrees with package\.json: none$/m);
    assert.match(text, /^could not check: registry$/m);
    assert.equal(outputs.drift, "false");
    assert.equal(outputs.unchecked, "true");
    assert.equal(outputs.unchecked_surfaces, "registry");
    assert.match(outputs.report, /could not check: /);
  });

  it("writes drift=true when the registry answers an older version, and asks it only once", async () => {
    answers.registry = registryAnswering("0.0.1");
    const { code, text, outputs } = await runCheck(["--warn"]);

    assert.equal(code, 0, text);
    const row = rowOf(text, "registry");
    assert.equal(row.mark, "DRIFT", text);
    assert.equal(row.version, "0.0.1");
    assert.equal(hits.registry, 1, "an answer that parsed is never retried");
    assert.match(text, /^disagrees with package\.json: registry$/m);
    assert.match(text, /^could not check: none$/m);
    assert.equal(outputs.drift, "true");
    assert.equal(outputs.unchecked, "false");
  });

  it("tries again when the registry fails twice, and reports ok on the third answer", async () => {
    answers.registry = (req, res, attempt) => {
      if (attempt === 1) return req.socket.destroy();
      if (attempt === 2) return sendJSON(res, 503, { title: "Service Unavailable", status: 503 });
      RIGHT_ANSWERS.registry(req, res);
    };
    const { code, text, outputs } = await runCheck();

    assert.equal(code, 0, text);
    assert.equal(rowOf(text, "registry").mark, "ok", text);
    assert.equal(rowOf(text, "registry").version, VERSION);
    assert.equal(hits.registry, 3);
    assert.equal(outputs.drift, "false");
    assert.equal(outputs.unchecked, "false");
  });

  it("exits 1 without --warn when a surface could not be checked, because a release must be confirmed everywhere", async () => {
    answers.registry = NEVER_ANSWER;
    const { code, text, outputs } = await runCheck();

    assert.equal(code, 1, text);
    assert.equal(rowOf(text, "registry").mark, "?", text);
    assert.equal(outputs.drift, "false");
    assert.equal(outputs.unchecked, "true");
  });

  it("exits 1 without --warn when a surface disagrees", async () => {
    answers.npm = (req, res) => sendJSON(res, 200, { "dist-tags": { latest: "0.0.1" }, time: {} });
    const { code, text, outputs } = await runCheck();

    assert.equal(code, 1, text);
    assert.equal(rowOf(text, "npm").mark, "DRIFT", text);
    assert.equal(outputs.drift, "true");
  });

  it("falls back to the registry search when the latest version route answers 404", async () => {
    answers.registry = (req, res) => {
      if (req.url === LATEST_ROUTE) return sendJSON(res, 404, { title: "Not Found", status: 404 });
      RIGHT_ANSWERS.registry(req, res);
    };
    const { code, text } = await runCheck();

    assert.equal(code, 0, text);
    const row = rowOf(text, "registry");
    assert.equal(row.mark, "ok", text);
    assert.match(row.note, /1 records, packages\[\] agree/);
    assert.equal(hits.registry, 2, "the latest route, then the search");
  });

  it("does not retry a refusal such as a rate limit, and reports it as could not check", async () => {
    answers.release = (req, res) => sendJSON(res, 403, { message: "API rate limit exceeded" });
    const { code, text, outputs } = await runCheck(["--warn"]);

    assert.equal(code, 0, text);
    const row = rowOf(text, "release");
    assert.equal(row.mark, "?", text);
    assert.match(row.note, /^could not check: .*403/);
    assert.equal(hits.release, 1);
    assert.equal(outputs.drift, "false");
    assert.equal(outputs.unchecked_surfaces, "release");
  });
});
