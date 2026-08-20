#!/usr/bin/env node
/**
 * Lyrenth MCP server over streamable HTTP.
 *
 * The same tools as the stdio server in index.ts, reachable as a hosted
 * endpoint so a remote MCP client (the ChatGPT Apps directory, a hosted
 * agent, anything that cannot spawn a local process) can connect over the
 * network instead of over a pipe.
 *
 * STATELESS. Every request builds its own McpServer and its own transport
 * and throws both away when the response ends. No session ids are minted,
 * nothing is held between calls, so any number of instances can sit behind
 * one address and a restart drops nothing. That is the SDK's stateless
 * mode: `sessionIdGenerator: undefined`.
 *
 * THE KEY BELONGS TO THE CALLER. The api key is read from the request's
 * Authorization header and used for that request only. There is no
 * LYRENTH_API_KEY fallback here on purpose: a hosted endpoint that fell
 * back to its own environment would bill every visitor's reads to one
 * account. Missing key means the tool answers with an explanation, not
 * with somebody else's credits.
 *
 * Introspection stays open. initialize and tools/list answer without any
 * credential, because a directory or a client has to be able to see what
 * the server offers before a user has pasted a key. Only an actual tool
 * call needs one.
 *
 * Config (env):
 *   MCP_HTTP_PORT       optional. Default 8081.
 *   MCP_HTTP_HOST       optional. Default 0.0.0.0 (see the note below).
 *   MCP_HTTP_PATH       optional. Default /mcp.
 *   LYRENTH_API_URL     optional. Default https://api.lyrenth.com
 *   MCP_ALLOWED_ORIGINS optional. Comma-separated browser origins allowed
 *                       to call this endpoint. Empty (the default) means
 *                       no browser origin is allowed.
 *   LYRENTH_MCP_SEARCH  optional. "1" registers the search tool. Off until
 *                       search is generally available.
 *
 * On the bind address: 0.0.0.0 is correct inside a container, where it
 * means the container's own interfaces. The public boundary is the compose
 * port publish (127.0.0.1:8081:8081) plus the reverse proxy in front, the
 * same arrangement the Go api uses. Running this on a bare host instead,
 * set MCP_HTTP_HOST=127.0.0.1.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { normalizeApiBase, registerTools, type AuthCarrier } from "./tools.js";

const SERVER_NAME = "lyrenth";
const SERVER_VERSION = "0.1.5";

const PORT = Number(process.env.MCP_HTTP_PORT ?? 8081);
const HOST = process.env.MCP_HTTP_HOST ?? "0.0.0.0";
const MCP_PATH = process.env.MCP_HTTP_PATH ?? "/mcp";
const API_BASE = normalizeApiBase(process.env.LYRENTH_API_URL);
const INCLUDE_SEARCH = process.env.LYRENTH_MCP_SEARCH === "1";

/**
 * Browser origins allowed to call this endpoint. Empty by default, which
 * means a request carrying any Origin header is refused.
 *
 * The MCP transport spec requires Origin validation on HTTP servers, to
 * stop a web page from driving an MCP server through the visitor's
 * browser (DNS rebinding). This endpoint is built for server-to-server
 * clients, which send no Origin header at all, so refusing every origin
 * is both the safe default and the accurate one. Set MCP_ALLOWED_ORIGINS
 * if a browser client is ever wanted.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

/**
 * Largest MCP request body accepted, in bytes. The biggest legitimate
 * call is read_urls with 20 URLs, which is a few kilobytes, so 1 MB is
 * generous and still refuses a body meant to exhaust memory.
 */
const MAX_BODY_BYTES = 1_000_000;

const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INTERNAL_ERROR = -32603;
/**
 * -32000 is the implementation-defined server error the MCP TypeScript
 * SDK's own stateless example returns for a method the transport does not
 * accept, so the same code is used here.
 */
const JSONRPC_METHOD_NOT_ALLOWED = -32000;

function log(message: string): void {
  process.stderr.write(`lyrenth-mcp-http ${new Date().toISOString()} ${message}\n`);
}

/**
 * Answer with a JSON-RPC error envelope. `id: null` is correct for an
 * error raised before a request id could be read.
 */
function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

/**
 * Read and decode the JSON body, refusing anything over MAX_BODY_BYTES.
 *
 * The transport can read the body itself, but then there is no size cap
 * and a malformed body surfaces as a transport error rather than a clean
 * parse error, so the body is read here and handed over already decoded.
 */
async function readJsonBody(req: IncomingMessage): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; code: number; message: string }
> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      code: JSONRPC_INVALID_REQUEST,
      message: "Request body too large",
    };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        return {
          ok: false,
          status: 413,
          code: JSONRPC_INVALID_REQUEST,
          message: "Request body too large",
        };
      }
      chunks.push(buf);
    }
  } catch (e) {
    return {
      ok: false,
      status: 400,
      code: JSONRPC_INVALID_REQUEST,
      message: `Could not read request body: ${(e as Error).message}`,
    };
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {
      ok: false,
      status: 400,
      code: JSONRPC_INVALID_REQUEST,
      message: "Empty request body",
    };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return {
      ok: false,
      status: 400,
      code: JSONRPC_PARSE_ERROR,
      message: `Invalid JSON: ${(e as Error).message}`,
    };
  }
}

/**
 * Pull the caller's Lyrenth api key out of the Authorization header.
 *
 * "Authorization: Bearer <key>" is the MCP convention for passing a
 * credential to an HTTP server, and it is also exactly what the Lyrenth
 * api itself expects, so the key travels unchanged from the MCP client to
 * the upstream call. The scheme name is matched case-insensitively
 * because HTTP auth schemes are case-insensitive.
 */
function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/**
 * Refuse a request that carries a browser Origin we do not allow. Returns
 * true when the request was answered and the caller should stop.
 */
function rejectedByOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) return false; // Server-to-server client, no browser involved.
  if (ALLOWED_ORIGINS.has(origin)) return false;
  writeJsonRpcError(res, 403, JSONRPC_INVALID_REQUEST, "Origin not allowed");
  return true;
}

/**
 * Handle one MCP request: build a server, build a transport, let the
 * transport answer, then throw both away.
 */
async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    writeJsonRpcError(res, body.status, body.code, body.message);
    return;
  }

  // The token for this request and no other. An empty string is allowed
  // through so that initialize and tools/list still answer; the tools
  // themselves are what refuse to run without a key.
  const token = bearerToken(req);

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, {
    apiBase: API_BASE,
    resolveApiKey: (extra: AuthCarrier) => extra.authInfo?.token ?? "",
    missingKeyMessage:
      "No Lyrenth API key was sent with this request. Add your key to this " +
      "connection's settings, or get a free one at https://lyrenth.com/signup. " +
      "The key travels as: Authorization: Bearer <key>",
    includeSearch: INCLUDE_SEARCH,
  });

  const transport = new StreamableHTTPServerTransport({
    // undefined disables session management: this is the stateless mode.
    sessionIdGenerator: undefined,
  });

  // Closing on response end matters: without it every request would leak
  // a server and a transport for the lifetime of the process.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    // The SDK reads req.auth and passes it to tool handlers as
    // extra.authInfo, which is where resolveApiKey above picks it up.
    // clientId and scopes are required by the AuthInfo shape; there is no
    // OAuth client here, so the values say what is actually true.
    (req as IncomingMessage & { auth?: unknown }).auth = {
      token,
      clientId: "lyrenth-mcp-http",
      scopes: [],
    };
    await transport.handleRequest(req, res, body.value);
  } catch (e) {
    log(`request failed: ${(e as Error).message}`);
    if (!res.headersSent) {
      writeJsonRpcError(res, 500, JSONRPC_INTERNAL_ERROR, "Internal server error");
    }
  }
}

const httpServer = createServer((req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0];

  // Deliberately no request logging beyond method and path. A read
  // request carries the URL a user asked for, which is theirs, not ours
  // to write down.
  const done = (status: number) => log(`${requestId} ${method} ${path} -> ${status}`);

  if (method === "GET" && path === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    done(200);
    return;
  }

  if (path !== MCP_PATH) {
    writeJsonRpcError(res, 404, JSONRPC_INVALID_REQUEST, "Not found");
    done(404);
    return;
  }

  if (rejectedByOrigin(req, res)) {
    done(403);
    return;
  }

  if (method === "POST") {
    void handleMcpPost(req, res).then(
      () => done(res.statusCode),
      (e: Error) => {
        log(`${requestId} handler threw: ${e.message}`);
        if (!res.headersSent) {
          writeJsonRpcError(res, 500, JSONRPC_INTERNAL_ERROR, "Internal server error");
        }
        done(500);
      },
    );
    return;
  }

  // A stateless server has no standing stream to offer on GET and no
  // session to end on DELETE, so both are refused. This is what the
  // transport spec asks a stateless server to do, and what the SDK's own
  // stateless example does.
  writeJsonRpcError(res, 405, JSONRPC_METHOD_NOT_ALLOWED, "Method not allowed", {
    Allow: "POST",
  });
  done(405);
});

httpServer.listen(PORT, HOST, () => {
  // Report the port actually bound, not the configured one. They differ
  // when MCP_HTTP_PORT is 0, which is how the tests get an unused port.
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address ? address.port : PORT;
  log(
    `listening on ${HOST}:${boundPort}${MCP_PATH} (upstream ${API_BASE}, search ${
      INCLUDE_SEARCH ? "on" : "off"
    })`,
  );
});

/**
 * Compose stops a container with SIGTERM. Close the listener so in-flight
 * requests finish instead of being cut off mid-response.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
  });
}
