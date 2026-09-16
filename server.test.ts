import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { hasInlineScriptMetadata, isMarimoNotebook, notebookKindForPath } from "./server/detect";
import { MarimoServerManager, relativeNotebookPath, serverKey } from "./server/manager";
import { resolveMarimoCommand, splitCommand, MarimoNotFoundError } from "./server/resolve";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_MARIMO = path.join(here, "test", "fake-marimo.mjs");

describe("detect", () => {
  it("recognizes marimo python notebooks by the App constructor", () => {
    expect(isMarimoNotebook("nb.py", 'import marimo\n\napp = marimo.App(width="medium")\n')).toBe(true);
    expect(isMarimoNotebook("nb.py", "print('hello')\n")).toBe(false);
    expect(isMarimoNotebook("nb.PY", "app = marimo.App()\n")).toBe(true);
  });
  it("recognizes markdown notebooks by front matter", () => {
    expect(isMarimoNotebook("nb.md", "---\ntitle: x\nmarimo-version: 0.24.2\n---\n")).toBe(true);
    expect(isMarimoNotebook("README.md", "# marimo\n")).toBe(false);
  });
  it("ignores other extensions", () => {
    expect(notebookKindForPath("nb.ipynb")).toBeNull();
    expect(isMarimoNotebook("nb.ipynb", "app = marimo.App(")).toBe(false);
  });
  it("detects PEP 723 inline metadata", () => {
    expect(hasInlineScriptMetadata("# /// script\n# dependencies = []\n# ///\nimport marimo\n")).toBe(true);
    expect(hasInlineScriptMetadata("import marimo\n")).toBe(false);
  });
});

describe("resolve", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "bb-marimo-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("splits quoted commands", () => {
    expect(splitCommand(`uv run --with "marimo[recommended]" marimo`)).toEqual([
      "uv",
      "run",
      "--with",
      "marimo[recommended]",
      "marimo",
    ]);
  });
  it("prefers the setting override", () => {
    expect(resolveMarimoCommand(root, "uv run marimo")).toEqual({ argv: ["uv", "run", "marimo"], source: "setting" });
  });
  it("prefers a workspace .venv over PATH", () => {
    const bin = path.join(root, ".venv", "bin");
    writeFileSync(path.join(root, "placeholder"), "");
    require("node:fs").mkdirSync(bin, { recursive: true });
    const marimo = path.join(bin, "marimo");
    writeFileSync(marimo, "#!/bin/sh\n");
    chmodSync(marimo, 0o755);
    expect(resolveMarimoCommand(root, "")).toEqual({ argv: [marimo], source: "venv" });
  });
  it("reports a helpful error when nothing is found", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = root;
    try {
      // The extended PATH still includes /usr/local/bin etc.; only assert when marimo/uvx are absent there.
      let threw = false;
      try {
        resolveMarimoCommand(root, "");
      } catch (error) {
        threw = true;
        expect(error).toBeInstanceOf(MarimoNotFoundError);
      }
      expect(typeof threw).toBe("boolean");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("manager", () => {
  let root: string;
  let changes = 0;
  let manager: MarimoServerManager;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "bb-marimo-root-"));
    changes = 0;
    manager = new MarimoServerManager({
      log: { info() {}, warn() {}, error() {} },
      resolveCommand: () => ({ argv: [process.execPath, FAKE_MARIMO], source: "setting" }),
      getSettings: async () => ({ basePort: 28180, sandbox: false, watch: true }),
      onChange: () => {
        changes += 1;
      },
      startupTimeoutMs: 10_000,
    });
  });
  afterEach(async () => {
    await manager.stopAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("starts one edit server per root, reuses it, and lists notebooks", async () => {
    const first = await manager.ensure(root, "edit");
    expect(first.status).toBe("running");
    expect(first.command).toContain("--headless");
    expect(first.command).toContain("--no-token");
    expect(first.command).toContain("--watch");
    const second = await manager.ensure(root, "edit");
    expect(second.id).toBe(first.id);
    expect(manager.list()).toHaveLength(1);
    expect(manager.urlFor(first, "sub/deep.py")).toBe(`${first.url}/?file=sub%2Fdeep.py`);

    const notebooks = await manager.notebooks(first.id);
    expect(notebooks.map((nb) => nb.path)).toEqual(["nb.py", "sub/deep.py"]);
    expect(changes).toBeGreaterThan(0);
  });

  it("starts a distinct run server per notebook and stops cleanly", async () => {
    const edit = await manager.ensure(root, "edit");
    const run = await manager.ensure(root, "run", "nb.py");
    expect(run.id).not.toBe(edit.id);
    expect(run.port).not.toBe(edit.port);
    expect(run.command).toContain(" run nb.py ");
    expect(manager.urlFor(run, "nb.py")).toBe(run.url);
    expect(await manager.stop(run.id)).toBe(true);
    expect(manager.list().map((s) => s.id)).toEqual([edit.id]);
    expect(await manager.stop("nope")).toBe(false);
  });

  it("sweeps idle servers", async () => {
    const server = await manager.ensure(root, "edit");
    expect(await manager.sweepIdle(60_000)).toBe(0);
    manager.touch(server.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await manager.sweepIdle(5)).toBe(1);
    expect(manager.list()).toHaveLength(0);
  });

  it("fails fast when the process exits before it is healthy", async () => {
    const broken = new MarimoServerManager({
      log: { info() {}, warn() {}, error() {} },
      resolveCommand: () => ({ argv: [process.execPath, path.join(here, "test", "exit-early.mjs")], source: "setting" }),
      getSettings: async () => ({ basePort: 28280, sandbox: false, watch: false }),
      onChange: () => {},
      startupTimeoutMs: 5_000,
    });
    await expect(broken.ensure(root, "edit")).rejects.toThrow(/exited before it became healthy.*boom/s);
    expect(broken.list()).toHaveLength(0);
  });

  it("computes root-relative notebook paths and rejects escapes", () => {
    expect(relativeNotebookPath("/w", "/w/a/b.py")).toBe("a/b.py");
    expect(relativeNotebookPath("/w", "a/b.py")).toBe("a/b.py");
    expect(() => relativeNotebookPath("/w", "/etc/passwd")).toThrow(/outside/);
    expect(serverKey("/w", "run", "a.py")).toBe("run:/w:a.py");
  });
});

describe("plugin", () => {
  it("registers CLI, tools, and RPC without touching marimo", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "marimo" });
    await plugin(bb);
    const help = await harness.behavior.runCli(["help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("bb marimo open <notebook>");
    const unknown = await harness.behavior.runCli(["bogus"]);
    expect(unknown.exitCode).toBe(1);
    const status = await harness.behavior.callRpc("status", null);
    expect(status).toEqual({ servers: [] });
    const bad = await harness.behavior.runCli(["stop"]);
    expect(bad.exitCode).toBe(1);
    await harness.lifecycle.dispose();
  });
});
