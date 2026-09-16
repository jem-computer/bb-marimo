// bb-plugin-marimo — backend entry.
//
// Starts and supervises marimo servers for BB workspaces, exposes them to the
// frontend (file opener + Marimo page) over RPC, and gives agents a `bb marimo`
// command plus native tools for checking, running, converting, and exporting
// notebooks. v1 runs marimo on the BB server machine only.
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isMarimoNotebook, hasInlineScriptMetadata, MAX_SNIFF_BYTES, notebookKindForPath } from "./server/detect.js";
import {
  MarimoServerManager,
  relativeNotebookPath,
  type ServerInfo,
  type ServerMode,
} from "./server/manager.js";
import { buildMarimoCss, BB_TOKENS, isSafeCssValue, type BbPalette } from "./server/theme.js";
import {
  MarimoNotFoundError,
  resolveMarimoCommand,
  resolvePython,
  rootExistsLocally,
  runCommand,
  findOnPath,
} from "./server/resolve.js";

const serverModeSchema = z.enum(["edit", "run"]);
const serverInfoSchema = z.object({
  id: z.string(),
  root: z.string(),
  mode: serverModeSchema,
  file: z.string().nullable(),
  port: z.number(),
  url: z.string(),
  upstreamUrl: z.string(),
  pid: z.number().nullable(),
  status: z.enum(["starting", "running", "exited"]),
  command: z.string(),
  startedAt: z.number(),
  lastUsedAt: z.number(),
  exitCode: z.number().nullable(),
});
const notebookSchema = z.object({ path: z.string(), name: z.string() });
const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  root: z.string().nullable(),
  environmentId: z.string().nullable(),
  server: serverInfoSchema.nullable(),
});
const paletteSchema = z.object({
  mode: z.enum(["light", "dark"]),
  themeId: z.string().nullable(),
  tokens: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/), z.string().max(400)),
});
const themeStateSchema = z.object({
  enabled: z.boolean(),
  palette: paletteSchema.nullable(),
  updatedAt: z.number().nullable(),
  css: z.string(),
});
const marimoStatusSchema = z.object({
  command: z.string().nullable(),
  source: z.string().nullable(),
  version: z.string().nullable(),
  error: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  /** Resolve a file to a notebook URL, starting a server when needed. */
  open: {
    input: z.object({
      sourceKind: z.enum(["workspace", "host", "thread-storage"]),
      path: z.string().min(1),
      environmentId: z.string().nullable(),
      projectId: z.string().nullable(),
      hostId: z.string().nullable().optional(),
      mode: serverModeSchema,
    }),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("notebook"),
        url: z.string(),
        server: serverInfoSchema,
        relativePath: z.string(),
      }),
      z.object({ kind: z.literal("not-notebook") }),
      z.object({ kind: z.literal("unsupported"), reason: z.string() }),
    ]),
  },
  status: {
    input: z.null(),
    output: z.object({ servers: z.array(serverInfoSchema) }),
  },
  marimo_info: {
    input: z.object({ projectId: z.string().nullable() }),
    output: marimoStatusSchema,
  },
  projects: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSummarySchema) }),
  },
  start: {
    input: z.object({ projectId: z.string() }),
    output: serverInfoSchema,
  },
  stop: {
    input: z.object({ id: z.string() }),
    output: z.object({ stopped: z.boolean() }),
  },
  restart: {
    input: z.object({ id: z.string() }),
    output: serverInfoSchema,
  },
  notebooks: {
    input: z.object({ serverId: z.string() }),
    output: z.object({ notebooks: z.array(notebookSchema) }),
  },
  logs: {
    input: z.object({ id: z.string() }),
    output: z.object({ lines: z.array(z.string()) }),
  },
  /** The frontend pushes BB's resolved palette here whenever it changes. */
  theme_set: {
    input: paletteSchema,
    output: themeStateSchema,
  },
  theme_get: {
    input: z.null(),
    output: themeStateSchema,
  },
});

export type BbPaletteInput = z.infer<typeof paletteSchema>;
export type ThemeState = z.infer<typeof themeStateSchema>;
export { BB_TOKENS };

export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type MarimoInfo = z.infer<typeof marimoStatusSchema>;
export type { ServerInfo, ServerMode };

/** Realtime channel: any server started, became healthy, exited, or stopped. */
export const SERVERS_CHANGED = "servers-changed";
/** Realtime channel: the injected theme stylesheet changed; iframes should reload. */
export const THEME_CHANGED = "theme-changed";

const TOOL_OUTPUT_CAP = 60_000;
function capText(text: string): string {
  return text.length <= TOOL_OUTPUT_CAP
    ? text
    : `${text.slice(0, TOOL_OUTPUT_CAP)}\n… [truncated]`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    marimoCommand: {
      type: "string",
      label: "marimo command (blank = auto-detect: project .venv → PATH → uvx)",
      default: "",
    },
    basePort: {
      type: "number",
      label: "First port to try for marimo servers",
      experimental_schema: z.number().int().min(1024).max(65000),
      default: 2818,
    },
    sandbox: {
      type: "boolean",
      label: "Run notebooks with --sandbox (isolated uv environment per notebook)",
      default: false,
    },
    watch: {
      type: "boolean",
      label: "Pass --watch so external edits (e.g. by an agent) reload in the editor",
      default: true,
    },
    idleMinutes: {
      type: "number",
      label: "Stop a marimo server after this many idle minutes (0 = never)",
      experimental_schema: z.number().int().min(0).max(24 * 60),
      default: 120,
    },
    syncTheme: {
      type: "boolean",
      label: "Restyle marimo with BB's active theme (colors, fonts, light/dark)",
      default: true,
    },
  });

  // ---- theme bridge ------------------------------------------------------

  const THEME_KEY = "theme-palette";
  let palette: BbPalette | null = (await bb.storage.kv.get<BbPalette>(THEME_KEY)) ?? null;
  let themeEnabled = (await settings.get()).syncTheme;
  let themeCss = palette === null ? "" : buildMarimoCss(palette);
  const themeSource = {
    current: () => (themeEnabled && palette !== null && themeCss !== "" ? { css: themeCss, mode: palette.mode } : null),
  };
  function themeState(): ThemeState {
    return { enabled: themeEnabled, palette, updatedAt: palette?.updatedAt ?? null, css: themeCss };
  }
  settings.onChange((next) => {
    if (next.syncTheme !== themeEnabled) {
      themeEnabled = next.syncTheme;
      bb.realtime.publish(THEME_CHANGED, { at: Date.now() });
    }
  });

  const manager = new MarimoServerManager({
    log: bb.log,
    resolveCommand: (root) => resolveMarimoCommand(root, currentCommandOverride),
    getSettings: async () => {
      const { basePort, sandbox, watch } = await settings.get();
      return { basePort, sandbox, watch };
    },
    onChange: () => bb.realtime.publish(SERVERS_CHANGED, { at: Date.now() }),
    theme: themeSource,
  });

  let currentCommandOverride = (await settings.get()).marimoCommand;
  settings.onChange((next) => {
    currentCommandOverride = next.marimoCommand;
  });

  // ---- workspace resolution --------------------------------------------

  interface Root {
    root: string;
    hostId: string | null;
    environmentId: string | null;
  }

  function assertLocal(root: string): void {
    if (!rootExistsLocally(root)) {
      throw new Error(
        `${root} is not on this machine. The Marimo plugin currently runs marimo only on the BB server host.`,
      );
    }
  }

  async function rootForEnvironment(environmentId: string): Promise<Root> {
    const environment = await bb.sdk.environments.get({ environmentId });
    if (environment.path === null) {
      throw new Error(`Environment ${environmentId} has no workspace path yet.`);
    }
    return { root: environment.path, hostId: environment.hostId, environmentId };
  }

  async function rootForProject(projectId: string): Promise<Root> {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
    if (source === undefined) {
      throw new Error(`Project ${project.name} has no local source path.`);
    }
    const environments = await bb.sdk.environments.list({ projectId, limit: 50 });
    const match =
      environments.find((env) => env.path === source.path && env.status === "ready") ??
      environments.find((env) => env.path === source.path) ??
      null;
    return { root: source.path, hostId: source.hostId, environmentId: match?.id ?? null };
  }

  async function rootForThread(threadId: string, projectId: string): Promise<Root> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId !== null) return rootForEnvironment(thread.environmentId);
    return rootForProject(projectId);
  }

  async function readForSniff(absolutePath: string, hostId: string | null): Promise<string | null> {
    const file = await bb.sdk.files.read({
      path: absolutePath,
      ...(hostId === null ? {} : { hostId }),
    });
    if (file.sizeBytes > MAX_SNIFF_BYTES) return null;
    if (file.contentEncoding === "base64") {
      return Buffer.from(file.content, "base64").toString("utf8");
    }
    return file.content;
  }

  // ---- marimo probe -----------------------------------------------------

  const versionCache = new Map<string, string>();
  async function marimoInfo(root: string): Promise<MarimoInfo> {
    try {
      const resolved = resolveMarimoCommand(root, currentCommandOverride);
      const key = resolved.argv.join(" ");
      let version = versionCache.get(key) ?? null;
      if (version === null) {
        const result = await runCommand([...resolved.argv, "--version"], {
          cwd: root,
          timeoutMs: 30_000,
        });
        version = result.exitCode === 0 ? result.stdout.trim().split("\n").pop() ?? null : null;
        if (version !== null) versionCache.set(key, version);
        if (result.exitCode !== 0) {
          return {
            command: key,
            source: resolved.source,
            version: null,
            error: (result.stderr || result.stdout).trim().slice(-500) || `exit ${String(result.exitCode)}`,
          };
        }
      }
      return { command: key, source: resolved.source, version, error: null };
    } catch (error) {
      return {
        command: null,
        source: null,
        version: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ---- core operations --------------------------------------------------

  async function openNotebook(
    target: Root,
    filePath: string,
    mode: ServerMode,
  ): Promise<{ url: string; server: ServerInfo; relativePath: string }> {
    assertLocal(target.root);
    const relativePath = relativeNotebookPath(target.root, filePath);
    const server =
      mode === "edit"
        ? await manager.ensure(target.root, "edit")
        : await manager.ensure(target.root, "run", relativePath);
    return { url: manager.urlFor(server, relativePath), server, relativePath };
  }

  function describeServer(server: ServerInfo): string {
    const what = server.mode === "run" ? `app ${server.file ?? ""}` : "editor";
    return `${server.id}  ${server.status.padEnd(8)}  ${what}  ${server.url}  root=${server.root}`;
  }

  // ---- RPC (frontend) ---------------------------------------------------

  bb.rpc.register(rpcContract, {
    open: async ({ sourceKind, path: filePath, environmentId, projectId, hostId, mode }) => {
      if (notebookKindForPath(filePath) === null) return { kind: "not-notebook" as const };
      let target: Root;
      if (sourceKind === "workspace") {
        if (environmentId !== null) target = await rootForEnvironment(environmentId);
        else if (projectId !== null) target = await rootForProject(projectId);
        else return { kind: "unsupported" as const, reason: "No environment or project for this file." };
      } else if (sourceKind === "host") {
        target = { root: path.dirname(filePath), hostId: hostId ?? null, environmentId: null };
      } else {
        return { kind: "unsupported" as const, reason: "Thread storage files are not supported yet." };
      }
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(target.root, filePath);
      const content = await readForSniff(absolute, target.hostId);
      if (content === null || !isMarimoNotebook(filePath, content)) {
        return { kind: "not-notebook" as const };
      }
      if (!rootExistsLocally(target.root)) {
        return {
          kind: "unsupported" as const,
          reason: "This workspace is not on the BB server machine; remote marimo servers are not supported yet.",
        };
      }
      const opened = await openNotebook(target, absolute, mode);
      return { kind: "notebook" as const, ...opened };
    },
    status: async () => ({ servers: manager.list() }),
    marimo_info: async ({ projectId }) => {
      let root = process.cwd();
      if (projectId !== null) {
        try {
          root = (await rootForProject(projectId)).root;
        } catch {
          // fall back to the server cwd
        }
      }
      return marimoInfo(root);
    },
    projects: async () => {
      const projects = await bb.sdk.projects.list();
      const summaries: ProjectSummary[] = [];
      for (const project of projects) {
        const source = project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
        const root = source?.path ?? null;
        let environmentId: string | null = null;
        if (root !== null) {
          try {
            environmentId = (await rootForProject(project.id)).environmentId;
          } catch {
            environmentId = null;
          }
        }
        summaries.push({
          id: project.id,
          name: project.name,
          root,
          environmentId,
          server: root === null ? null : manager.find(root, "edit", null),
        });
      }
      return { projects: summaries };
    },
    start: async ({ projectId }) => {
      const target = await rootForProject(projectId);
      assertLocal(target.root);
      return manager.ensure(target.root, "edit");
    },
    stop: async ({ id }) => ({ stopped: await manager.stop(id) }),
    restart: ({ id }) => manager.restart(id),
    notebooks: async ({ serverId }) => ({ notebooks: await manager.notebooks(serverId) }),
    logs: ({ id }) => ({ lines: manager.logs(id) }),
    theme_get: async () => themeState(),
    theme_set: async (input) => {
      const tokens: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.tokens)) {
        if (isSafeCssValue(value) && value.trim() !== "") tokens[name] = value.trim();
      }
      const next: BbPalette = { mode: input.mode, themeId: input.themeId, tokens, updatedAt: Date.now() };
      const nextCss = buildMarimoCss(next);
      const changed = nextCss !== themeCss || next.mode !== palette?.mode;
      palette = next;
      themeCss = nextCss;
      await bb.storage.kv.set(THEME_KEY, next);
      if (changed) bb.realtime.publish(THEME_CHANGED, { at: Date.now() });
      return themeState();
    },
  });

  // ---- agent tools ------------------------------------------------------

  const pathParam = z
    .string()
    .min(1)
    .describe("Notebook path, relative to the workspace root or absolute.");

  bb.agents.registerTool({
    name: "marimo_open",
    description:
      "Start (or reuse) a marimo server for the current workspace and return the URL of a notebook in the editor or as a read-only app. The user can also see it by opening the .py file in BB's file panel.",
    presentation: { label: { pending: "Opening marimo notebook", completed: "Opened marimo notebook" } },
    parameters: z.object({
      path: pathParam,
      mode: serverModeSchema.default("edit").describe("edit = full editor, run = read-only app view"),
    }),
    async execute({ path: filePath, mode }, { threadId, projectId }) {
      const target = await rootForThread(threadId, projectId);
      const opened = await openNotebook(target, filePath, mode);
      return `${mode === "edit" ? "Editor" : "App"} URL: ${opened.url}\nServer ${opened.server.id} (${opened.server.status}) serving ${opened.server.root}`;
    },
  });

  bb.agents.registerTool({
    name: "marimo_status",
    description: "List marimo servers this plugin is running and how marimo is resolved for the current workspace.",
    presentation: { label: { pending: "Checking marimo servers", completed: "Checked marimo servers" } },
    parameters: z.object({}),
    async execute(_input, { threadId, projectId }) {
      const target = await rootForThread(threadId, projectId).catch(() => null);
      const info = await marimoInfo(target?.root ?? process.cwd());
      const servers = manager.list();
      const lines = [
        `marimo: ${info.command ?? "not found"}${info.version === null ? "" : ` (v${info.version}, via ${info.source ?? "?"})`}`,
        ...(info.error === null ? [] : [`error: ${info.error}`]),
        servers.length === 0 ? "No marimo servers running." : servers.map(describeServer).join("\n"),
      ];
      return lines.join("\n");
    },
  });

  bb.agents.registerTool({
    name: "marimo_check",
    description:
      "Lint marimo notebooks with `marimo check` (multiple definitions, cycles, unparsable cells, formatting). Use after editing a notebook file. Returns diagnostics as JSON.",
    presentation: { label: { pending: "Checking marimo notebooks", completed: "Checked marimo notebooks" } },
    parameters: z.object({
      paths: z.array(pathParam).min(1),
      fix: z.boolean().default(false).describe("Apply safe fixes in place."),
    }),
    async execute({ paths, fix }, { threadId, projectId, signal }) {
      const target = await rootForThread(threadId, projectId);
      assertLocal(target.root);
      const marimo = resolveMarimoCommand(target.root, currentCommandOverride);
      const args = [...marimo.argv, "check", "--format", "json", ...(fix ? ["--fix"] : []), ...paths];
      const result = await runCommand(args, { cwd: target.root, timeoutMs: 120_000, signal });
      const out = `${result.stdout}\n${result.stderr}`.trim();
      return {
        content: [{ type: "text" as const, text: capText(out === "" ? `exit ${String(result.exitCode)} with no output` : out) }],
        isError: result.exitCode !== 0 && result.exitCode !== 1,
      };
    },
  });

  bb.agents.registerTool({
    name: "marimo_run",
    description:
      "Execute a marimo notebook headlessly as a script (marimo notebooks are valid Python programs) and return stdout, stderr, and the exit code. Use it to verify a notebook runs end to end. Notebooks with inline script metadata run under `uv run`.",
    presentation: { label: { pending: "Running marimo notebook", completed: "Ran marimo notebook" } },
    parameters: z.object({
      path: pathParam,
      timeoutSeconds: z.number().int().min(1).max(1800).default(300),
    }),
    async execute({ path: filePath, timeoutSeconds }, { threadId, projectId, signal }) {
      const target = await rootForThread(threadId, projectId);
      assertLocal(target.root);
      const relative = relativeNotebookPath(target.root, filePath);
      const absolute = path.join(target.root, relative);
      const content = (await readForSniff(absolute, target.hostId)) ?? "";
      const uv = findOnPath("uv");
      const marimo = resolveMarimoCommand(target.root, currentCommandOverride);
      const argv =
        hasInlineScriptMetadata(content) && uv !== null
          ? [uv, "run", "--script", relative]
          : [...resolvePython(target.root, marimo), relative];
      const result = await runCommand(argv, { cwd: target.root, timeoutMs: timeoutSeconds * 1000, signal });
      const text = [
        `$ ${argv.join(" ")}`,
        `exit code: ${String(result.exitCode)}${result.timedOut ? " (timed out)" : ""}`,
        result.stdout === "" ? "" : `--- stdout ---\n${result.stdout}`,
        result.stderr === "" ? "" : `--- stderr ---\n${result.stderr}`,
      ]
        .filter((line) => line !== "")
        .join("\n");
      return { content: [{ type: "text" as const, text: capText(text) }], isError: result.exitCode !== 0 };
    },
  });

  bb.agents.registerTool({
    name: "marimo_convert",
    description:
      "Convert a Jupyter notebook (.ipynb), a Markdown file with {python} fences, or a py:percent script into a marimo notebook with `marimo convert`.",
    presentation: { label: { pending: "Converting to marimo", completed: "Converted to marimo" } },
    parameters: z.object({
      input: pathParam.describe("Source file (.ipynb, .md, or .py)."),
      output: z.string().min(1).optional().describe("Destination .py path. Defaults to the input with a .py extension."),
    }),
    async execute({ input, output }, { threadId, projectId, signal }) {
      const target = await rootForThread(threadId, projectId);
      assertLocal(target.root);
      const marimo = resolveMarimoCommand(target.root, currentCommandOverride);
      const destination = output ?? input.replace(/\.[^./]+$/, "") + ".py";
      const result = await runCommand([...marimo.argv, "convert", input, "-o", destination], {
        cwd: target.root,
        timeoutMs: 120_000,
        signal,
      });
      const out = `${result.stdout}\n${result.stderr}`.trim();
      return {
        content: [{ type: "text" as const, text: capText(result.exitCode === 0 ? `Wrote ${destination}\n${out}` : out) }],
        isError: result.exitCode !== 0,
      };
    },
  });

  bb.agents.registerTool({
    name: "marimo_export",
    description:
      "Export a marimo notebook with `marimo export`: html (runs the notebook), html-wasm, ipynb, md, pdf, or script.",
    presentation: { label: { pending: "Exporting marimo notebook", completed: "Exported marimo notebook" } },
    parameters: z.object({
      format: z.enum(["html", "html-wasm", "ipynb", "md", "pdf", "script"]),
      path: pathParam,
      output: z.string().min(1).optional().describe("Destination path; marimo picks one when omitted."),
    }),
    async execute({ format, path: filePath, output }, { threadId, projectId, signal }) {
      const target = await rootForThread(threadId, projectId);
      assertLocal(target.root);
      const marimo = resolveMarimoCommand(target.root, currentCommandOverride);
      const args = [...marimo.argv, "export", format, filePath, ...(output === undefined ? [] : ["-o", output, "--force"])];
      const result = await runCommand(args, { cwd: target.root, timeoutMs: 600_000, signal });
      const out = `${result.stdout}\n${result.stderr}`.trim();
      return { content: [{ type: "text" as const, text: capText(out) }], isError: result.exitCode !== 0 };
    },
  });

  // ---- CLI ---------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb marimo status                      Servers and how marimo is resolved",
    "  bb marimo start [dir]                 Start an editor server for a workspace",
    "  bb marimo open <notebook> [--run]     URL for a notebook (editor, or --run for the app view)",
    "  bb marimo notebooks [server-id]       Notebooks marimo sees under a running editor server",
    "  bb marimo stop <server-id|all>        Stop a server",
    "  bb marimo restart <server-id>         Restart a server",
    "  bb marimo logs <server-id>            Recent server output",
    "  bb marimo check <files...> [--fix]    Lint notebooks",
    "  bb marimo convert <in> [-o out]       Convert .ipynb/.md/.py to a marimo notebook",
    "  bb marimo export <format> <nb> [-o out]  Export html|html-wasm|ipynb|md|pdf|script",
    "Add --json for machine-readable output where applicable.",
  ].join("\n");

  bb.cli.register({
    name: "marimo",
    summary: "Run, inspect, lint, convert, and export marimo notebooks",
    commands: [
      { name: "status", summary: "List marimo servers", usage: "bb marimo status [--json]" },
      { name: "start", summary: "Start an editor server", usage: "bb marimo start [dir] [--json]" },
      { name: "open", summary: "Get a notebook URL", usage: "bb marimo open <notebook> [--run] [--json]" },
      { name: "notebooks", summary: "List notebooks under a server", usage: "bb marimo notebooks [server-id] [--json]" },
      { name: "stop", summary: "Stop a server", usage: "bb marimo stop <server-id|all>" },
      { name: "restart", summary: "Restart a server", usage: "bb marimo restart <server-id>" },
      { name: "logs", summary: "Show server output", usage: "bb marimo logs <server-id>" },
      { name: "check", summary: "Lint notebooks", usage: "bb marimo check <files...> [--fix]" },
      { name: "convert", summary: "Convert to marimo", usage: "bb marimo convert <input> [-o output]" },
      { name: "export", summary: "Export a notebook", usage: "bb marimo export <format> <notebook> [-o output]" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const ok = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value, null, 2) : text });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });

      const resolveCwdRoot = async (explicit?: string): Promise<Root> => {
        if (explicit !== undefined) {
          const root = path.resolve(ctx.cwd ?? process.cwd(), explicit);
          return { root, hostId: null, environmentId: null };
        }
        if (ctx.threadId !== undefined && ctx.projectId !== undefined) {
          return rootForThread(ctx.threadId, ctx.projectId);
        }
        if (ctx.projectId !== undefined) return rootForProject(ctx.projectId);
        return { root: ctx.cwd ?? process.cwd(), hostId: null, environmentId: null };
      };

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "status": {
            const target = await resolveCwdRoot();
            const info = await marimoInfo(target.root);
            const servers = manager.list();
            return ok(
              { marimo: info, servers },
              [
                `marimo: ${info.command ?? "not found"}${info.version === null ? "" : ` (v${info.version}, via ${info.source ?? "?"})`}`,
                ...(info.error === null ? [] : [`error: ${info.error}`]),
                servers.length === 0 ? "No marimo servers running." : servers.map(describeServer).join("\n"),
              ].join("\n"),
            );
          }
          case "start": {
            const target = await resolveCwdRoot(rest[0]);
            assertLocal(target.root);
            const server = await manager.ensure(target.root, "edit");
            return ok(server, describeServer(server));
          }
          case "open": {
            const run = rest.includes("--run");
            const file = rest.find((arg) => !arg.startsWith("--"));
            if (file === undefined) return fail(usage);
            const target = await resolveCwdRoot();
            const opened = await openNotebook(target, path.resolve(ctx.cwd ?? target.root, file), run ? "run" : "edit");
            return ok(opened, opened.url);
          }
          case "notebooks": {
            let id: string | undefined = rest[0];
            if (id === undefined) {
              const target = await resolveCwdRoot();
              id = manager.find(target.root, "edit", null)?.id ?? undefined;
            }
            if (id === undefined) return fail("No running editor server for this workspace. Run `bb marimo start` first.");
            const notebooks = await manager.notebooks(id);
            return ok(notebooks, notebooks.length === 0 ? "No notebooks found." : notebooks.map((nb) => nb.path).join("\n"));
          }
          case "stop": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            if (id === "all") {
              await manager.stopAll();
              return ok({ stopped: "all" }, "Stopped all marimo servers.");
            }
            const stopped = await manager.stop(id);
            return stopped ? ok({ stopped: id }, `Stopped ${id}`) : fail(`No marimo server with id ${id}`);
          }
          case "restart": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const server = await manager.restart(id);
            return ok(server, describeServer(server));
          }
          case "logs": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const lines = manager.logs(id);
            return ok(lines, lines.join("\n"));
          }
          case "check":
          case "convert":
          case "export": {
            const target = await resolveCwdRoot();
            assertLocal(target.root);
            const marimo = resolveMarimoCommand(target.root, currentCommandOverride);
            const passthrough = command === "check" && !rest.includes("--format") ? [...rest] : rest;
            const result = await runCommand([...marimo.argv, command, ...passthrough], {
              cwd: ctx.cwd ?? target.root,
              timeoutMs: 600_000,
              signal: ctx.signal,
            });
            return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
          }
          default:
            return fail(`Unknown command "${String(command)}".\n${usage}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(error instanceof MarimoNotFoundError ? message : `marimo: ${message}`);
      }
    },
  });

  // ---- idle sweep + cleanup -------------------------------------------

  bb.background.service("idle-sweeper", {
    async start(signal) {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (signal.aborted) break;
        const { idleMinutes } = await settings.get();
        try {
          await manager.sweepIdle(idleMinutes * 60_000);
        } catch (error) {
          bb.log.warn(`idle sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  });

  bb.onDispose(async () => {
    await manager.stopAll();
    bb.log.info("stopped all marimo servers");
  });

  bb.log.info("loaded");
}
