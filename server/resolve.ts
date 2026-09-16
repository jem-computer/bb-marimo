// Locate a marimo executable for a workspace root. The BB server may run
// with a GUI-app PATH, so the usual user bin directories are appended.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ResolvedCommand {
  /** argv prefix; append marimo subcommands and flags. */
  argv: string[];
  /** Where it came from, for status output. */
  source: "setting" | "venv" | "path" | "uvx";
}

const EXTRA_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  path.join(homedir(), ".local", "bin"),
  path.join(homedir(), ".cargo", "bin"),
];

export function extendedPath(base = process.env.PATH ?? ""): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const dir of [...base.split(path.delimiter), ...EXTRA_BIN_DIRS]) {
    if (dir === "" || seen.has(dir)) continue;
    seen.add(dir);
    parts.push(dir);
  }
  return parts.join(path.delimiter);
}

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: extendedPath(),
    MARIMO_SKIP_UPDATE_CHECK: "1",
    ...extra,
  };
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findOnPath(name: string): string | null {
  for (const dir of extendedPath().split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Split a user-supplied command line on whitespace, honoring simple quotes. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(re)) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out.filter((part) => part !== "");
}

export function venvBin(root: string, name: string): string | null {
  for (const venv of [".venv", "venv"]) {
    const candidate = path.join(root, venv, "bin", name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export class MarimoNotFoundError extends Error {
  constructor() {
    super(
      "marimo was not found. Install it (`uv pip install marimo` in the project's .venv, `uv tool install marimo`, or `pip install marimo`), or set the plugin's `marimoCommand` setting.",
    );
    this.name = "MarimoNotFoundError";
  }
}

export function resolveMarimoCommand(
  root: string,
  override: string,
): ResolvedCommand {
  const trimmed = override.trim();
  if (trimmed !== "") {
    const argv = splitCommand(trimmed);
    if (argv.length === 0) throw new MarimoNotFoundError();
    return { argv, source: "setting" };
  }
  const venv = venvBin(root, "marimo");
  if (venv !== null) return { argv: [venv], source: "venv" };
  const onPath = findOnPath("marimo");
  if (onPath !== null) return { argv: [onPath], source: "path" };
  const uvx = findOnPath("uvx");
  if (uvx !== null) return { argv: [uvx, "marimo"], source: "uvx" };
  throw new MarimoNotFoundError();
}

/** The interpreter used to run a notebook as a plain script. */
export function resolvePython(root: string, marimo: ResolvedCommand): string[] {
  const venv = venvBin(root, "python");
  if (venv !== null) return [venv];
  const bin = marimo.argv[0] ?? "";
  if (bin.endsWith(`${path.sep}marimo`)) {
    const sibling = path.join(path.dirname(bin), "python");
    if (isExecutable(sibling)) return [sibling];
  }
  const python = findOnPath("python3") ?? findOnPath("python");
  if (python !== null) return [python];
  const uv = findOnPath("uv");
  if (uv !== null) return [uv, "run", "python"];
  throw new Error("No Python interpreter found on PATH.");
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const OUTPUT_CAP = 200_000;

function cap(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  return `${text.slice(0, OUTPUT_CAP)}\n… [truncated ${text.length - OUTPUT_CAP} characters]`;
}

/** Run a command to completion with a timeout and bounded output. */
export function runCommand(
  argv: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  const [file, ...args] = argv;
  if (file === undefined) return Promise.reject(new Error("Empty command"));
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: childEnv(),
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        killSignal: "SIGKILL",
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error !== null && "killed" in error && error.killed === true) {
          timedOut = true;
        }
        if (error !== null && !("code" in error) && !("killed" in error)) {
          reject(error);
          return;
        }
        const code =
          error !== null && typeof error.code === "number"
            ? error.code
            : error === null
              ? 0
              : null;
        resolve({
          exitCode: code,
          stdout: cap(String(stdout)),
          stderr: cap(String(stderr)),
          timedOut,
        });
      },
    );
    child.on("error", reject);
  });
}

export function rootExistsLocally(root: string): boolean {
  return existsSync(root);
}
