import { createServer } from "node:http";
import { createStatusSummary, readJson, readText, readWorkflowState } from "./ai-state.mjs";

const root = process.cwd();
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

function usage() {
  process.stdout.write([
    "Usage: node scripts/ai-server.mjs [--port <0-65535>] [--host <loopback-host>]",
    "",
    "Starts a read-only local A3 status service. Default: http://127.0.0.1:3337"
  ].join("\n") + "\n");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseOptions(argv) {
  const options = { host: "127.0.0.1", port: 3337 };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "help") {
      usage();
      process.exit(0);
    }
    const value = argv[index + 1];
    if (item === "--host" && value) {
      options.host = value;
      index += 1;
      continue;
    }
    if (item === "--port" && value) {
      options.port = Number(value);
      index += 1;
      continue;
    }
    fail(`Unknown or incomplete argument: ${item}`);
  }
  if (!loopbackHosts.has(options.host)) {
    fail("A3 only accepts a loopback host: 127.0.0.1, localhost, or ::1");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    fail("--port must be an integer from 0 to 65535");
  }
  return options;
}

function send(response, statusCode, contentType, body, headOnly = false) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff"
  });
  response.end(headOnly ? undefined : body);
}

function sendJson(response, statusCode, value, headOnly) {
  send(response, statusCode, "application/json; charset=utf-8", `${JSON.stringify(value, null, 2)}\n`, headOnly);
}

async function readEndpoint(pathname) {
  if (pathname === "/health") {
    return { kind: "json", value: { service: "ai-dev-workflow-a3", status: "ok", readOnly: true } };
  }
  if (pathname === "/" || pathname === "/dashboard") {
    return { kind: "html", value: await readText(root, ".codex-dev/dashboard.html") };
  }
  if (pathname === "/api/status" || pathname === "/status") {
    const { state, tasks } = await readWorkflowState(root);
    return { kind: "json", value: createStatusSummary(state, tasks) };
  }
  if (pathname === "/api/tasks" || pathname === "/tasks") {
    const { taskState, taskViews } = await readWorkflowState(root);
    return { kind: "json", value: { ...taskState, tasks: taskViews, readOnly: true } };
  }
  if (pathname === "/api/context" || pathname === "/context") {
    return { kind: "json", value: { content: await readText(root, ".codex-dev/context.md") } };
  }
  if (pathname === "/api/api-sync" || pathname === "/api-sync") {
    return { kind: "json", value: await readJson(root, ".codex-dev/api-sync.json") };
  }
  if (pathname === "/api/verify" || pathname === "/verify") {
    const { state } = await readWorkflowState(root);
    return { kind: "json", value: { ...(state.lastVerification ?? { result: "not-run" }), currentSourceRechecked: false } };
  }
  return null;
}

const options = parseOptions(process.argv.slice(2));
const server = createServer(async (request, response) => {
  const headOnly = request.method === "HEAD";
  if (request.method !== "GET" && !headOnly) {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { error: "method_not_allowed" }, false);
    return;
  }

  const pathname = new URL(request.url ?? "/", `http://${options.host}`).pathname;
  try {
    const endpoint = await readEndpoint(pathname);
    if (!endpoint) {
      sendJson(response, 404, { error: "not_found" }, headOnly);
      return;
    }
    if (endpoint.kind === "html") {
      send(response, 200, "text/html; charset=utf-8", endpoint.value, headOnly);
      return;
    }
    sendJson(response, 200, endpoint.value, headOnly);
  } catch (error) {
    process.stderr.write(`A3 request failed: ${error.message}\n`);
    sendJson(response, 500, { error: "state_unavailable" }, headOnly);
  }
});

server.listen(options.port, options.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const displayHost = options.host === "::1" ? "[::1]" : options.host;
  process.stdout.write(`A3 server listening at http://${displayHost}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
