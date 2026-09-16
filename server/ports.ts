import { createServer } from "node:net";

export const LOOPBACK = "127.0.0.1";

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, LOOPBACK, () => {
      probe.close(() => resolve(true));
    });
  });
}

export async function findFreePort(from: number, attempts = 200): Promise<number> {
  for (let port = from; port < from + attempts && port <= 65535; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in ${from}–${from + attempts}`);
}
