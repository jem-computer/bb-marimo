---
name: marimo
description: Create, edit, run, lint, convert, and export marimo notebooks (.py files built on `marimo.App`) in this workspace. Use when the user mentions marimo, a reactive/notebook-as-script Python notebook, converting a Jupyter .ipynb, or when a .py file contains `app = marimo.App(`.
---

# marimo notebooks

marimo notebooks are plain Python files: `import marimo`, `app = marimo.App()`,
one `@app.cell` function per cell, and `if __name__ == "__main__": app.run()`.
Cells form a dataflow graph by the variables they define and read, so a
variable may be defined in only one cell, and cells must not form cycles.
Markdown notebooks (`.md` with `marimo-version` front matter) also exist.

The Marimo plugin runs marimo servers on the BB machine. When the user opens a
notebook file in BB it renders in marimo's editor; the same server is what
`marimo_open` and `bb marimo open` return URLs for.

## Tools (preferred)

| Tool | Use it to |
| --- | --- |
| `marimo_check` | Lint after every edit: `{"paths": ["nb.py"]}`. Fix `MB*` breaking rules before running. `fix: true` applies safe formatting fixes. |
| `marimo_run` | Execute a notebook headlessly as a script and read stdout/stderr. Verifies it runs end to end. |
| `marimo_open` | Get the editor URL (`mode: "edit"`) or app URL (`mode: "run"`) for a notebook. Tell the user they can also click the file in BB. |
| `marimo_convert` | Turn `.ipynb`, `.md` with `{python}` fences, or py:percent `.py` into a marimo notebook. |
| `marimo_export` | Produce `html` (executes the notebook), `html-wasm`, `ipynb`, `md`, `pdf`, or `script`. |
| `marimo_status` | See running servers and how marimo was resolved. |

Equivalent CLI: `bb marimo status | start | open <nb> [--run] | notebooks | stop <id|all> | restart <id> | logs <id> | check <files> | convert <in> -o <out> | export <fmt> <nb> -o <out>`.

## Writing notebooks

- Edit the `.py` file directly with normal file tools; marimo picks up changes
  (the plugin passes `--watch`). Keep the `@app.cell` structure; each cell
  function returns the names other cells use (marimo rewrites `return` lines
  on save, so a bare `return` is fine).
- Prefer `import marimo as mo` in its own cell. UI: `mo.ui.slider`,
  `mo.ui.dropdown`, `mo.md(f"...")`, `mo.ui.table(df)`; the last expression of
  a cell is its output.
- Never define the same top-level name in two cells. Never reassign a name
  from another cell; use a new name or `_private` (underscore names are local).
- Create a new notebook with `marimo new <name>.py` via the CLI passthrough or
  by writing the skeleton above.
- Dependencies: for `--sandbox` notebooks add PEP 723 inline metadata
  (`# /// script` … `# ///`) at the top; otherwise install into the
  project's `.venv`.

## Procedure

1. Edit the notebook file.
2. `marimo_check` on it; fix errors (multiple definitions, cycles, syntax).
3. `marimo_run` to make sure it executes; read the traceback if not.
4. If the user wants to see it, `marimo_open` and share the URL, or tell them
   to click the file in BB.

## Constraints

- marimo pages are served through a plugin proxy that injects BB's theme. The
  `url` from `marimo_open` is the proxied one; `upstreamUrl` in `bb marimo
  status --json` is marimo itself.

- v1 runs marimo only on the BB server machine (local environments). Remote
  environments return an "unsupported" error.
- marimo resolution order: plugin `marimoCommand` setting → `.venv/bin/marimo`
  under the workspace → `marimo` on PATH → `uvx marimo`. If none exist, ask the
  user to install it (`uv pip install marimo`).
