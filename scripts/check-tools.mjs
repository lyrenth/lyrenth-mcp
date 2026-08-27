#!/usr/bin/env node
/**
 * Assert what a published build actually hands a user.
 *
 * This does not read the source. It launches the built stdio server exactly
 * as `npx lyrenth-mcp` and the .mcpb bundle do, performs a real MCP handshake,
 * calls tools/list, and compares the answer against release-tools.json.
 *
 * Why it exists: src/tools.ts registers additional tools depending on the
 * context it is handed. src/http.ts gates those behind an env var that
 * defaults off; src/index.ts, the stdio entry point, does not. So the tool
 * set a user receives depends on which entry point was built and which flag
 * survived, and a source grep cannot tell you that. A handshake can.
 *
 * Usage:
 *   node scripts/check-tools.mjs            # report: prints drift, exits 0
 *   node scripts/check-tools.mjs --strict   # gate: exits 1 on any drift
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const entry = join(root, "dist", "index.js");

const allowed = JSON.parse(readFileSync(join(root, "release-tools.json"), "utf8")).allowed;

const finish = (ok, lines) => {
  const text = lines.join("\n");
  console[ok ? "log" : "error"](text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Tool surface\n\n${text}\n`);
  }
  process.exit(ok || !strict ? 0 : 1);
};

if (!existsSync(entry)) {
  finish(false, ["dist/index.js is missing. Run `npm run build` first."]);
}

const listTools = () =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // The server exits without a key, so a placeholder satisfies the
        // boot check. ALWAYS the placeholder, never a real key from the
        // caller's environment: nothing in this probe reaches the network
        // (tools/list is answered from the local registration table), so a
        // real credential in the child is pure downside, and scanners
        // rightly flag secrets flowing into spawned processes.
        LYRENTH_API_KEY: "ci-tool-surface-probe",
      },
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for tools/list (20s)"));
    }, 20_000);

    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})\n${stderr.trim()}`));
    });

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let nl;
      while ((nl = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        }
        if (msg.id === 2 && msg.result) {
          clearTimeout(timer);
          child.removeAllListeners("exit");
          child.kill("SIGTERM");
          resolve({
            tools: (msg.result.tools ?? []).map((t) => t.name).sort(),
            serverInfo: msg.serverInfo,
          });
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tool-surface-check", version: "1.0" },
      },
    });
  });

let result;
try {
  result = await listTools();
} catch (err) {
  finish(false, [`could not read the tool surface: ${err.message}`]);
}

const actual = result.tools;
const expected = [...allowed].sort();
const extra = actual.filter((t) => !expected.includes(t));
const missing = expected.filter((t) => !actual.includes(t));

if (!extra.length && !missing.length) {
  finish(true, [`stdio build exposes exactly the allowed ${actual.length} tools: ${actual.join(", ")}`]);
}

const lines = [`tool surface drift in the stdio build (dist/index.js)`, ``];
lines.push(`  expected: ${expected.join(", ")}`);
lines.push(`  actual:   ${actual.join(", ") || "(none)"}`);
if (extra.length) {
  lines.push(``, `  UNEXPECTED: ${extra.join(", ")}`);
  lines.push(
    ``,
    `  This build hands every npx and .mcpb user a tool set the release list does`,
    `  not authorise. Check which entry point was built and how src/index.ts`,
    `  constructs its tool context. Do not widen release-tools.json to clear this:`,
    `  that changes what the product gives away, and it is not CI's call.`
  );
}
if (missing.length) lines.push(``, `  MISSING: ${missing.join(", ")}`);
lines.push(``, strict ? `  blocking the release.` : `  reported only; the release workflow runs this with --strict.`);
finish(false, lines);
