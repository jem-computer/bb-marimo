// A minimal loopback reverse proxy in front of a marimo server. It forwards
// every request and WebSocket upgrade untouched, except that HTML documents
// get BB's theme stylesheet injected (see theme.ts).
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { findFreePort } from "./ports.js";
import { rewriteMarimoHtml, type ThemeMode } from "./theme.js";

export interface ThemeSource {
  /** Current stylesheet and mode; null means pass HTML through untouched. */
  current(): { css: string; mode: ThemeMode } | null;
}

export interface ProxyHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

const HOST = "127.0.0.1";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

function forwardHeaders(incoming: IncomingMessage, targetPort: number): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  headers.host = `${HOST}:${targetPort}`;
  return headers;
}

function isHtml(response: IncomingMessage): boolean {
  return (response.headers["content-type"] ?? "").toLowerCase().includes("text/html");
}

export async function startProxy(options: {
  targetPort: number;
  basePort: number;
  theme: ThemeSource;
}): Promise<ProxyHandle> {
  const { targetPort, theme } = options;
  const sockets = new Set<Socket>();

  const server: Server = createServer((request, response) => {
    const themed = theme.current();
    const headers = forwardHeaders(request, targetPort);
    if (themed !== null) {
      // Ask for identity encoding so HTML can be rewritten; marimo honors it.
      headers["accept-encoding"] = "identity";
    }
    const upstream = httpRequest(
      { host: HOST, port: targetPort, method: request.method, path: request.url, headers },
      (upstreamResponse) => {
        if (themed !== null && isHtml(upstreamResponse) && upstreamResponse.headers["content-encoding"] === undefined) {
          const chunks: Buffer[] = [];
          upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
          upstreamResponse.on("end", () => {
            const body = Buffer.from(rewriteMarimoHtml(Buffer.concat(chunks).toString("utf8"), themed.css, themed.mode));
            const responseHeaders = { ...upstreamResponse.headers };
            delete responseHeaders["content-length"];
            delete responseHeaders["transfer-encoding"];
            delete responseHeaders.etag;
            responseHeaders["content-length"] = String(body.byteLength);
            responseHeaders["cache-control"] = "no-store";
            response.writeHead(upstreamResponse.statusCode ?? 200, responseHeaders);
            response.end(body);
          });
          return;
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain" });
      }
      response.end(`marimo upstream error: ${error.message}`);
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, clientSocket, head) => {
    const upstreamSocket = connect(targetPort, HOST, () => {
      const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        const rendered = name === "host" ? `${HOST}:${targetPort}` : Array.isArray(value) ? value.join(", ") : value;
        lines.push(`${name}: ${rendered}`);
      }
      upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    sockets.add(upstreamSocket);
    sockets.add(clientSocket as Socket);
    const cleanup = () => {
      sockets.delete(upstreamSocket);
      sockets.delete(clientSocket as Socket);
      upstreamSocket.destroy();
      clientSocket.destroy();
    };
    upstreamSocket.on("error", cleanup);
    upstreamSocket.on("close", cleanup);
    clientSocket.on("error", cleanup);
    clientSocket.on("close", cleanup);
  });

  const port = await findFreePort(options.basePort);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve());
  });

  return {
    port,
    url: `http://${HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
