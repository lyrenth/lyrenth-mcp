/**
 * Tests for the streamable HTTP transport (src/http.ts, built to
 * dist/http.js).
 *
 * Run with:  npm test        (after npm run build)
 *
 * No test framework and no new dependencies: node's own test runner and
 * assert module, both built in since node 18, which is what this package
 * already requires.
 *
 * A stub Lyrenth api stands in for the real one, so the tests are
 * deterministic, need no api key, and spend no credits. The stub records
 * the Authorization header of every call it receives, which is what makes
 * the important assertion possible: THE KEY THAT ARRIVES ON THE MCP
 * REQUEST IS THE KEY THAT GOES UPSTREAM, per request, never a shared one.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTTP_ENTRY = path.join(HERE, "..", "dist", "http.js");

/** Every upstream call the stub api saw, in order. */
const upstreamCalls = [];

let stubApi;
let stubApiUrl;
let mcpProcess;
let mcpUrl;

/** Start a stub of the Lyrenth api on an ephemeral port. */
function startStubApi() {
  return new Promise((resolve) => {
    stubApi = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        upstreamCalls.push({
          method: req.method,
          path: req.url,
          authorization: req.headers.authorization ?? null,
          body: raw ? JSON.parse(raw) : null,
        });

        res.setHeader("Content-Type", "application/json");
        if (req.url === "/v1/quota") {
          res.end(
            JSON.stringify({ tier: "free", used: 12, limit: 2000, remaining: 1988 }),
          );
          return;
        }
        if (req.url === "/v1/aidocument") {
          res.end(
            JSON.stringify({
              identity: { title: "Example Domain" },
              source: { url: "https://example.com/", status_code: 200 },
              signals: { word_count: 28 },
              economics: { output_tokens_approx: 41, token_savings_percent: 0.94 },
              content: { markdown: "This domain is for use in examples." },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      });
    });
    stubApi.listen(0, "127.0.0.1", () => {
      stubApiUrl = `http://127.0.0.1:${stubApi.address().port}`;
      resolve();
    });
  });
}

/** Start the MCP HTTP server as a child process pointed at the stub. */
function startMcpServer() {
  return new Promise((resolve, reject) => {
    mcpProcess = spawn(process.execPath, [HTTP_ENTRY], {
      env: {
        ...process.env,
        MCP_HTTP_PORT: "0",
        MCP_HTTP_HOST: "127.0.0.1",
        LYRENTH_API_URL: stubApiUrl,
        // Deliberately set, and deliberately expected NEVER to be used.
        // If the HTTP server ever falls back to the environment, the
        // key-isolation test below sees this value and fails.
        LYRENTH_API_KEY: "env-key-that-must-never-be-used",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => reject(new Error("mcp server did not start")), 10000);
    mcpProcess.stderr.on("data", (chunk) => {
      const line = chunk.toString();
      const match = /listening on 127\.0\.0\.1:(\d+)(\/\S*)/.exec(line);
      if (match) {
        clearTimeout(timer);
        mcpUrl = `http://127.0.0.1:${match[1]}${match[2]}`;
        resolve();
      }
    });
    mcpProcess.on("error", reject);
  });
}

/**
 * Send one JSON-RPC message to the MCP endpoint and decode the reply.
 *
 * The transport answers either application/json or text/event-stream
 * depending on the request, so both are handled. In the SSE case the
 * single JSON-RPC response arrives as one `data:` line.
 */
async function mcpPost(message, { apiKey, headers = {}, url = mcpUrl } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    body: JSON.stringify(message),
  });

  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  let payload = null;
  if (text.trim()) {
    if (contentType.includes("text/event-stream")) {
      const dataLine = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("data:"))
        .pop();
      payload = dataLine ? JSON.parse(dataLine.slice("data:".length).trim()) : null;
    } else {
      payload = JSON.parse(text);
    }
  }
  return { status: res.status, headers: res.headers, payload, contentType };
}

/** The MCP initialize request every client sends first. */
function initializeMessage(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "lyrenth-transport-test", version: "0.0.0" },
    },
  };
}

before(async () => {
  await startStubApi();
  await startMcpServer();
});

after(() => {
  if (mcpProcess) mcpProcess.kill();
  if (stubApi) stubApi.close();
});

describe("streamable HTTP transport", () => {
  it("answers the MCP initialize handshake", async () => {
    const { status, payload } = await mcpPost(initializeMessage());
    assert.equal(status, 200);
    assert.equal(payload.jsonrpc, "2.0");
    assert.equal(payload.result.serverInfo.name, "lyrenth");
    assert.ok(payload.result.protocolVersion, "a protocol version is negotiated");
    assert.ok(payload.result.capabilities.tools, "tools capability is advertised");
  });

  it("mints no session id (stateless mode)", async () => {
    const { headers } = await mcpPost(initializeMessage());
    assert.equal(
      headers.get("mcp-session-id"),
      null,
      "a stateless server must not hand out a session id",
    );
  });

  it("handshakes without any credential, so a directory can introspect it", async () => {
    const before = upstreamCalls.length;
    const { status } = await mcpPost(initializeMessage());
    assert.equal(status, 200);
    assert.equal(upstreamCalls.length, before, "introspection calls no upstream endpoint");
  });

  it("declares all four hints on every tool, matching real behaviour", async () => {
    const { payload } = await mcpPost({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const tools = payload.result.tools;
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["check_usage", "read_url", "read_urls"]);

    for (const tool of tools) {
      assert.ok(tool.annotations, `${tool.name} declares annotations`);
      assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} readOnlyHint`);
      assert.equal(tool.annotations.destructiveHint, false, `${tool.name} destructiveHint`);
      assert.equal(tool.annotations.idempotentHint, true, `${tool.name} idempotentHint`);
      // The page readers reach the open web; check_usage never leaves
      // our own API, so its world is closed. Directories check that
      // hints match behaviour, and so does this test.
      const openWorld = tool.name !== "check_usage";
      assert.equal(tool.annotations.openWorldHint, openWorld, `${tool.name} openWorldHint`);
    }
  });

  it("carries each tool's title in both places a client might look", async () => {
    const { payload } = await mcpPost({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/list",
      params: {},
    });

    // The current spec's home for a title is the tool's own field, but
    // version 0.1.5 shipped it inside annotations and the directory
    // reviews that already passed read it from there. Both must stay.
    const expected = {
      read_url: "Read URL",
      read_urls: "Read URLs (batch)",
      check_usage: "Check usage",
    };
    for (const tool of payload.result.tools) {
      assert.equal(tool.title, expected[tool.name], `${tool.name} top-level title`);
      assert.equal(
        tool.annotations.title,
        expected[tool.name],
        `${tool.name} title inside annotations`,
      );
    }
  });

  it("leaves the search tool off until search is generally available", async () => {
    const { payload } = await mcpPost({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });
    const names = payload.result.tools.map((t) => t.name);
    assert.equal(names.includes("search"), false);
  });

  it("sends the caller's own key upstream, per request", async () => {
    const before = upstreamCalls.length;

    await mcpPost(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "check_usage", arguments: {} },
      },
      { apiKey: "key-belonging-to-alice" },
    );
    await mcpPost(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "check_usage", arguments: {} },
      },
      { apiKey: "key-belonging-to-bob" },
    );

    const seen = upstreamCalls.slice(before);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].authorization, "Bearer key-belonging-to-alice");
    assert.equal(seen[1].authorization, "Bearer key-belonging-to-bob");
    for (const call of seen) {
      assert.equal(
        call.authorization.includes("env-key-that-must-never-be-used"),
        false,
        "the hosted endpoint must never spend its own environment's key",
      );
    }
  });

  it("reads a URL end to end and renders the AIDocument", async () => {
    const before = upstreamCalls.length;
    const { payload } = await mcpPost(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "read_url",
          arguments: { url: "https://example.com/", max_tokens: 500 },
        },
      },
      { apiKey: "key-belonging-to-alice" },
    );

    const call = upstreamCalls[before];
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/v1/aidocument");
    assert.equal(call.body.url, "https://example.com/");
    assert.equal(call.body.freshness_policy, "cache_first");
    assert.equal(call.body.max_tokens, 500);

    const text = payload.result.content[0].text;
    assert.match(text, /# Example Domain/);
    assert.match(text, /Source: https:\/\/example\.com\//);
    assert.match(text, /94% smaller than raw HTML/);
    assert.match(text, /This domain is for use in examples\./);
  });

  it("explains the missing key instead of borrowing one", async () => {
    const before = upstreamCalls.length;
    const { payload } = await mcpPost({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "check_usage", arguments: {} },
    });

    assert.equal(payload.result.isError, true);
    assert.match(payload.result.content[0].text, /No Lyrenth API key was sent/);
    assert.equal(
      upstreamCalls.length,
      before,
      "a call with no key must not reach the upstream api at all",
    );
  });

  it("refuses GET and DELETE on the MCP path", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(mcpUrl, {
        method,
        headers: { Accept: "application/json, text/event-stream" },
      });
      assert.equal(res.status, 405, `${method} is not allowed`);
      assert.equal(res.headers.get("allow"), "POST");
    }
  });

  it("refuses a browser origin that is not allowlisted", async () => {
    const { status, payload } = await mcpPost(initializeMessage(), {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(status, 403);
    assert.match(payload.error.message, /Origin not allowed/);
  });

  it("404s a path that is not the MCP endpoint", async () => {
    const base = new URL(mcpUrl);
    const { status } = await mcpPost(initializeMessage(), {
      url: `${base.origin}/not-the-endpoint`,
    });
    assert.equal(status, 404);
  });

  it("serves a health check for the container", async () => {
    const base = new URL(mcpUrl);
    const res = await fetch(`${base.origin}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  it("refuses a body that is not JSON", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, -32700);
  });
});
