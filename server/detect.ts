// Notebook detection, mirroring marimo's own editor heuristics: a `.py` file
// is a marimo notebook when it constructs `marimo.App(`; a `.md` file when its
// front matter carries `marimo-version`.

const PY_MARKERS = ["app = marimo.App(", "marimo.App("];
const MD_MARKER = "marimo-version";

/** Bytes beyond which we do not bother sniffing (notebooks are small). */
export const MAX_SNIFF_BYTES = 4 * 1024 * 1024;

export type NotebookKind = "python" | "markdown";

export function notebookKindForPath(path: string): NotebookKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".md")) return "markdown";
  return null;
}

export function isMarimoNotebook(path: string, content: string): boolean {
  const kind = notebookKindForPath(path);
  if (kind === null) return false;
  if (kind === "python") {
    return PY_MARKERS.some((marker) => content.includes(marker));
  }
  return content.includes(MD_MARKER);
}

/** Inline script metadata (PEP 723) — marimo's `--sandbox` notebooks carry it. */
export function hasInlineScriptMetadata(content: string): boolean {
  return /^# \/\/\/ script\s*$/m.test(content);
}
