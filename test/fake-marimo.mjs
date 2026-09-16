#!/usr/bin/env node
// A stand-in for `marimo edit|run` used by the manager tests: honors --port,
// serves /health, an index page with a skew token, and the workspace listing.
import { createServer } from "node:http";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("9.9.9\n");
  process.exit(0);
}
const portIndex = args.indexOf("--port");
const port = Number(args[portIndex + 1]);
const delayMs = Number(process.env.FAKE_MARIMO_DELAY_MS ?? "0");
const TOKEN = "fake-token-123";

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "healthy" }));
    return;
  }
  if (url.pathname === "/api/home/workspace_files") {
    if (request.headers["marimo-server-token"] !== TOKEN) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: "Missing server token" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        root: process.cwd(),
        files: [
          { path: "nb.py", name: "nb.py", isDirectory: false, isMarimoFile: true, children: [] },
          { path: "plain.py", name: "plain.py", isDirectory: false, isMarimoFile: false, children: [] },
          {
            path: "sub",
            name: "sub",
            isDirectory: true,
            isMarimoFile: false,
            children: [{ path: "sub/deep.py", name: "deep.py", isDirectory: false, isMarimoFile: true, children: [] }],
          },
        ],
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<html><head><marimo-server-token data-token="${TOKEN}" hidden></marimo-server-token></head><body>fake marimo ${args.join(" ")}</body></html>`);
});

setTimeout(() => {
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`fake marimo listening on ${port}\n`);
  });
}, delayMs);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
