Open marimo notebooks in marimo's own editor without leaving BB, and let
agents check, run, convert, and export them.

## What you get

- Click a `.py` or `.md` marimo notebook anywhere in BB and it renders in the
  marimo editor; switch to the read-only **App** view with one click.
- A **Marimo** sidebar page that shows each project's marimo server and the
  notebooks under it, with start, stop, and restart.
- A `bb marimo` command and `marimo_*` agent tools, plus a skill that teaches
  agents marimo's reactive-notebook rules.

## How it works

The plugin starts one `marimo edit` server per workspace root on the BB
machine, using the project's `.venv`, `marimo` on PATH, or `uvx` as a fallback.
Servers run headless on loopback and stop when idle. Nothing leaves the
machine and no account is needed.

## For agents

Agents edit the notebook file directly, lint it with `marimo_check`, verify
it executes with `marimo_run`, and hand the user an editor URL with
`marimo_open`.
