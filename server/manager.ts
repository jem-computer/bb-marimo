// Owns the marimo server processes this plugin starts: one `marimo edit`
// server per workspace root (it serves every notebook under that root), plus
// one `marimo run` server per notebook shown as an app.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { childEnv, type ResolvedCommand } from "./resolve.js";

export type ServerMode = "edit" | "run";
export type ServerStatus = "starting" | "running" | "exited";

export interface ServerInfo {
  id: string;
  root: string;
  mode: ServerMode;
  /** Root-relative notebook path for `run` servers; null for `edit`. */
  file: string | null;
  port: number;
  url: string;
  pid: number | null;
  status: ServerStatus;
  command: string;
  startedAt: number;
  lastUsedAt: number;
  exitCode: number | null;
}

export interface NotebookEntry {
  path: string;
  name: string;
}

interface ServerRecord extends ServerInfo {
  child: ChildProcess | null;
  token: string | null;
  log: string[];
  ready: Promise<void>;
}

export interface ManagerSettings {
  basePort: number;
  sandbox: boolean;
  watch: boolean;
}

export interface ManagerOptions {
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  resolveCommand(root: string): ResolvedCommand;
  getSettings(): Promise<ManagerSettings>;
  onChange(): void;
  /** Milliseconds to wait for `/health`; defaults to 45s. */
  startupTimeoutMs?: number;
}

const LOG_LINES = 200;
const HOST = "127.0.0.1";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, HOST, () => {
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

export function serverKey(root: string, mode: ServerMode, file: string | null): string {
  return `${mode}:${root}${file === null ? "" : `:${file}`}`;
}

export class MarimoServerManager {
  private readonly servers = new Map<string, ServerRecord>();
  private counter = 0;

  constructor(private readonly options: ManagerOptions) {}

  list(): ServerInfo[] {
    return [...this.servers.values()]
      .map((record) => this.toInfo(record))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  get(id: string): ServerInfo | null {
    const record = this.servers.get(id);
    return record === undefined ? null : this.toInfo(record);
  }

  logs(id: string): string[] {
    return [...(this.servers.get(id)?.log ?? [])];
  }

  find(root: string, mode: ServerMode, file: string | null): ServerInfo | null {
    const record = this.findRecord(root, mode, file);
    return record === null ? null : this.toInfo(record);
  }

  /** Return the running server for this root/mode, starting one if needed. */
  async ensure(root: string, mode: ServerMode, file: string | null = null): Promise<ServerInfo> {
    const existing = this.findRecord(root, mode, file);
    if (existing !== null) {
      existing.lastUsedAt = Date.now();
      await existing.ready;
      return this.toInfo(existing);
    }
    const record = await this.start(root, mode, file);
    await record.ready;
    return this.toInfo(record);
  }

  touch(id: string): void {
    const record = this.servers.get(id);
    if (record !== undefined) record.lastUsedAt = Date.now();
  }

  /** Notebook URL for an edit server; the app URL for a run server. */
  urlFor(info: ServerInfo, relativeFile: string | null): string {
    if (info.mode === "run" || relativeFile === null) return info.url;
    return `${info.url}/?file=${encodeURIComponent(relativeFile)}`;
  }

  async stop(id: string): Promise<boolean> {
    const record = this.servers.get(id);
    if (record === undefined) return false;
    this.servers.delete(id);
    await this.kill(record);
    this.options.onChange();
    return true;
  }

  async stopAll(): Promise<void> {
    const records = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(records.map((record) => this.kill(record)));
    this.options.onChange();
  }

  async restart(id: string): Promise<ServerInfo> {
    const record = this.servers.get(id);
    if (record === undefined) throw new Error(`No marimo server with id ${id}`);
    await this.stop(id);
    return this.ensure(record.root, record.mode, record.file);
  }

  /** Stop servers idle longer than `maxIdleMs`. Returns how many were stopped. */
  async sweepIdle(maxIdleMs: number): Promise<number> {
    if (maxIdleMs <= 0) return 0;
    const now = Date.now();
    let stopped = 0;
    for (const record of [...this.servers.values()]) {
      if (record.status === "running" && now - record.lastUsedAt > maxIdleMs) {
        this.options.log.info(`stopping idle marimo server ${record.id} (${record.root})`);
        await this.stop(record.id);
        stopped += 1;
      } else if (record.status === "exited") {
        this.servers.delete(record.id);
        stopped += 1;
      }
    }
    return stopped;
  }

  /** Notebooks marimo sees under an edit server's root (uses its skew token). */
  async notebooks(id: string): Promise<NotebookEntry[]> {
    const record = this.servers.get(id);
    if (record === undefined) throw new Error(`No marimo server with id ${id}`);
    if (record.mode !== "edit") return [];
    await record.ready;
    const token = record.token ?? (await this.fetchToken(record));
    const response = await fetch(`${record.url}/api/home/workspace_files`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Marimo-Server-Token": token ?? "",
      },
      body: JSON.stringify({ include_markdown: true }),
    });
    if (!response.ok) {
      throw new Error(`marimo workspace listing failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      files?: WorkspaceFile[];
    };
    const out: NotebookEntry[] = [];
    const walk = (files: WorkspaceFile[]) => {
      for (const file of files) {
        if (file.isDirectory) {
          walk(file.children ?? []);
        } else if (file.isMarimoFile) {
          out.push({ path: file.path, name: file.name });
        }
      }
    };
    walk(body.files ?? []);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private findRecord(root: string, mode: ServerMode, file: string | null): ServerRecord | null {
    const key = serverKey(root, mode, file);
    for (const record of this.servers.values()) {
      if (record.status !== "exited" && serverKey(record.root, record.mode, record.file) === key) {
        return record;
      }
    }
    return null;
  }

  private toInfo(record: ServerRecord): ServerInfo {
    const { child: _child, token: _token, log: _log, ready: _ready, ...info } = record;
    return { ...info };
  }

  private async start(root: string, mode: ServerMode, file: string | null): Promise<ServerRecord> {
    const settings = await this.options.getSettings();
    const command = this.options.resolveCommand(root);
    const port = await findFreePort(settings.basePort + (mode === "run" ? 10 : 0));
    const args = [
      ...command.argv.slice(1),
      "--yes",
      mode,
      mode === "edit" ? "." : (file ?? "."),
      "--headless",
      "--no-token",
      "--host",
      HOST,
      "--port",
      String(port),
    ];
    if (mode === "edit") args.push("--skip-update-check");
    if (settings.sandbox) args.push("--sandbox");
    if (settings.watch) args.push("--watch");
    const binary = command.argv[0];
    if (binary === undefined) throw new Error("Empty marimo command");

    this.counter += 1;
    const id = `${mode}-${port}-${this.counter}`;
    const now = Date.now();
    const record: ServerRecord = {
      id,
      root,
      mode,
      file,
      port,
      url: `http://${HOST}:${port}`,
      pid: null,
      status: "starting",
      command: [binary, ...args].join(" "),
      startedAt: now,
      lastUsedAt: now,
      exitCode: null,
      child: null,
      token: null,
      log: [],
      ready: Promise.resolve(),
    };
    this.servers.set(id, record);

    this.options.log.info(`starting marimo: ${record.command} (cwd ${root})`);
    const child = spawn(binary, args, {
      cwd: root,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    record.child = child;
    record.pid = child.pid ?? null;
    const append = (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() === "") continue;
        record.log.push(line);
        if (record.log.length > LOG_LINES) record.log.shift();
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code) => {
      record.status = "exited";
      record.exitCode = code;
      record.child = null;
      this.options.log.warn(`marimo server ${id} exited with code ${String(code)}`);
      this.options.onChange();
    });
    child.on("error", (error) => {
      append(`spawn error: ${error.message}`);
      record.status = "exited";
      record.child = null;
      this.options.onChange();
    });

    record.ready = this.waitUntilHealthy(record).then(
      async () => {
        record.status = "running";
        record.token = await this.fetchToken(record).catch(() => null);
        this.options.onChange();
      },
      async (error: unknown) => {
        await this.kill(record);
        this.servers.delete(id);
        this.options.onChange();
        throw error;
      },
    );
    this.options.onChange();
    return record;
  }

  private async waitUntilHealthy(record: ServerRecord): Promise<void> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 45_000);
    while (Date.now() < deadline) {
      if (record.status === "exited") {
        throw new Error(
          `marimo exited before it became healthy (code ${String(record.exitCode)}).\n${record.log.slice(-15).join("\n")}`,
        );
      }
      try {
        const response = await fetch(`${record.url}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
      } catch {
        // not up yet
      }
      await sleep(250);
    }
    throw new Error(
      `marimo did not become healthy within ${Math.round((this.options.startupTimeoutMs ?? 45_000) / 1000)}s.\n${record.log.slice(-15).join("\n")}`,
    );
  }

  private async fetchToken(record: ServerRecord): Promise<string | null> {
    const response = await fetch(`${record.url}/`, { signal: AbortSignal.timeout(5_000) });
    const html = await response.text();
    const match = html.match(/<marimo-server-token[^>]*data-token="([^"]+)"/);
    return match?.[1] ?? null;
  }

  private async kill(record: ServerRecord): Promise<void> {
    const child = record.child;
    if (child === null || child.exitCode !== null) {
      record.status = "exited";
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const controller = new AbortController();
    await Promise.race([exited, sleep(3_000, controller.signal).then(() => "timeout" as const)]).then(
      (outcome) => {
        if (outcome === "timeout" && child.exitCode === null) child.kill("SIGKILL");
      },
    );
    controller.abort();
    record.status = "exited";
    record.child = null;
  }
}

interface WorkspaceFile {
  path: string;
  name: string;
  isDirectory: boolean;
  isMarimoFile: boolean;
  children?: WorkspaceFile[];
}

export function relativeNotebookPath(root: string, absoluteOrRelative: string): string {
  const absolute = path.isAbsolute(absoluteOrRelative)
    ? absoluteOrRelative
    : path.join(root, absoluteOrRelative);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${absoluteOrRelative} is outside the workspace root ${root}`);
  }
  return relative.split(path.sep).join("/");
}
