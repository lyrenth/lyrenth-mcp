/**
 * Tests for the stdio transport (src/index.ts, built to dist/index.js),
 * the server every npx and .mcpb user runs.
 *
 * Run with:  npm test        (after npm run build)
 *
 * The server is started exactly as npx starts it, as a child process
 * spoken to over stdin and stdout, and pointed at a stub of the Lyrenth
 * api, so the tests need no api key and spend no credits. The hosted
 * endpoint's tests are in http-transport.test.mjs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STDIO_ENTRY = path.join(HERE, "..", "dist", "index.js");
const TOOLS_MODULE = pathToFileURL(path.join(HERE, "..", "dist", "tools.js")).href;

/** Every upstream call the stub api saw, in order. */
const upstreamCalls = [];

let stubApi;
let stubApiUrl;

/** Start a stub of the Lyrenth api that records every call and answers 404. */
function startStubApi() {
  return new Promise((resolve) => {
    stubApi = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        upstreamCalls.push({ method: req.method, path: req.url });
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "not found" }));
      });
    });
    stubApi.listen(0, "127.0.0.1", () => {
      stubApiUrl = `http://127.0.0.1:${stubApi.address().port}`;
      resolve();
    });
  });
}

/**
 * Start the stdio server, send initialize, then one tools/call, and return
 * the tools/call response with the time it took to answer. The server is
 * stopped once it has answered.
 */
function stdioCall(name, args) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      LYRENTH_API_KEY: "stdio-test-key",
      LYRENTH_API_URL: stubApiUrl,
    };
    const child = spawn(process.execPath, [STDIO_ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("stdio server did not answer tools/call"));
    }, 20000);
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    let buffer = "";
    let started = 0;
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          started = Date.now();
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          const elapsed = Date.now() - started;
          child.kill("SIGTERM");
          resolve({ response: msg, elapsed });
        }
      }
    });
    child.on("error", reject);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "lyrenth-stdio-test", version: "0.0.0" },
      },
    });
  });
}

before(async () => {
  await startStubApi();
});

after(() => {
  if (stubApi) stubApi.close();
});

describe("stdio transport", () => {
  it("refuses arguments over the element cap before the tool's schema reads them", async () => {
    const { MAX_TOOL_INPUT_ELEMENTS } = await import(TOOLS_MODULE);
    // The same call the hosted endpoint test sends: 200,000 one-letter
    // strings, far over the cap. Without the cap, zod checks every element
    // and the answer lists every one of them.
    const urls = new Array(200_000).fill("x");
    const before = upstreamCalls.length;
    const { response, elapsed } = await stdioCall("read_urls", { urls });

    assert.equal(response.result.isError, true);
    const text = response.result.content[0].text;
    assert.ok(
      text.length < 300,
      `a short refusal, not one line per element (got ${text.length} characters)`,
    );
    assert.match(text, new RegExp(`more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`));
    assert.equal(
      upstreamCalls.length,
      before,
      "a refused call reaches no upstream endpoint, /v1/aidocument included",
    );
    assert.ok(elapsed < 2000, `answered in ${elapsed} ms`);
  });
});
