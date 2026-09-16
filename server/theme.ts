// Translate BB's palette tokens into marimo's CSS custom properties.
//
// marimo defines its semantic colors on `.marimo, :root` with light-dark()
// polyfills and switches modes with a `.dark` class (on <html> or <body>).
// We emit higher-specificity rules so the palette wins regardless of when
// marimo's lazily loaded stylesheets attach.

export type ThemeMode = "light" | "dark";

export interface BbPalette {
  mode: ThemeMode;
  updatedAt?: number;
  /** BB token name (without `--`) → resolved CSS value. */
  tokens: Record<string, string>;
  /** BB theme id, for display only. */
  themeId: string | null;
}

/** BB tokens the frontend should read. Order matters only for readability. */
export const BB_TOKENS = [
  "canvas",
  "background",
  "ink",
  "foreground",
  "muted",
  "muted-foreground",
  "subtle-foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "secondary",
  "secondary-foreground",
  "primary",
  "primary-foreground",
  "accent",
  "accent-foreground",
  "state-hover",
  "state-active",
  "surface-selected",
  "surface-recessed-solid",
  "border",
  "border-hairline",
  "input",
  "ring",
  "success",
  "warning",
  "destructive",
  "destructive-text",
  "sidebar",
  "sidebar-foreground",
  "font-sans",
  "font-mono",
] as const;

type Pick = (tokens: Record<string, string>) => string | undefined;

const first =
  (...names: string[]): Pick =>
  (tokens) => {
    for (const name of names) {
      const value = tokens[name]?.trim();
      if (value !== undefined && value !== "") return value;
    }
    return undefined;
  };

/** marimo variable → which BB tokens feed it, in priority order. */
const COLOR_MAP: Record<string, Pick> = {
  background: first("canvas", "background"),
  foreground: first("foreground", "ink"),
  muted: first("muted", "secondary"),
  "muted-foreground": first("muted-foreground", "subtle-foreground"),
  card: first("card", "canvas", "background"),
  "card-foreground": first("card-foreground", "foreground", "ink"),
  popover: first("popover", "card", "canvas"),
  "popover-foreground": first("popover-foreground", "foreground", "ink"),
  secondary: first("secondary", "muted"),
  "secondary-foreground": first("secondary-foreground", "foreground", "ink"),
  primary: first("primary"),
  "primary-foreground": first("primary-foreground"),
  accent: first("state-hover", "surface-selected", "accent", "secondary"),
  "accent-foreground": first("accent-foreground", "foreground", "ink"),
  border: first("border", "border-hairline"),
  input: first("input", "border"),
  ring: first("ring", "primary"),
  link: first("primary"),
  destructive: first("destructive"),
  "destructive-hover": first("destructive"),
  "destructive-border": first("destructive-text", "destructive"),
  error: first("destructive"),
  success: first("success"),
  "success-hover": first("success"),
  "cm-background": first("surface-recessed-solid", "card", "canvas"),
};

const FONT_MAP: Record<string, Pick> = {
  "marimo-text-font": first("font-sans"),
  "marimo-heading-font": first("font-sans"),
  "marimo-monospace-font": first("font-mono"),
};

/** Reject values that could break out of a declaration. */
export function isSafeCssValue(value: string): boolean {
  return value.length <= 400 && !/[;{}<>]/.test(value) && !/url\(|expression\(|@import/i.test(value);
}

export function buildMarimoCss(palette: BbPalette): string {
  const declarations: string[] = [];
  for (const [name, pick] of Object.entries({ ...COLOR_MAP, ...FONT_MAP })) {
    const value = pick(palette.tokens);
    if (value !== undefined && isSafeCssValue(value)) {
      declarations.push(`  --${name}: ${value};`);
    }
  }
  if (declarations.length === 0) return "";
  const block = declarations.join("\n");
  // Both modes get BB's *current* palette; the proxy also flips marimo's own
  // theme to BB's mode so editor chrome and syntax colors follow along.
  return [
    `/* bb-plugin-marimo: BB theme ${palette.themeId ?? ""} (${palette.mode}) */`,
    `html:root, html .marimo, html:root:has(body.dark), html.dark:root, html.dark .marimo, html .dark .marimo {`,
    block,
    `}`,
    `html:root { color-scheme: ${palette.mode}; }`,
    "",
  ].join("\n");
}

const HEAD_CLOSE = /<\/head>/i;

/** Inject a stylesheet and force marimo's theme mode inside its embedded user config. */
export function rewriteMarimoHtml(html: string, css: string, mode: ThemeMode): string {
  let out = html;
  if (css !== "") {
    out = out.replace(HEAD_CLOSE, `<style id="bb-marimo-theme">\n${css}</style>\n</head>`);
  }
  // <marimo-user-config data-config="{ ... &quot;display&quot;: { ... &quot;theme&quot;: &quot;light&quot; ... }">
  out = out.replace(
    /(<marimo-user-config[^>]*data-config="[^"]*?&quot;theme&quot;:\s*&quot;)(light|dark|system)(&quot;)/,
    `$1${mode}$3`,
  );
  return out;
}
