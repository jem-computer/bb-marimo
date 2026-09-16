import { describe, expect, it } from "vitest";
import { buildMarimoCss, rewriteMarimoHtml } from "./theme";
import { startProxy } from "./proxy";
import { createServer } from "node:http";

describe("theme css", () => {
  it("maps BB tokens onto marimo variables with fallbacks", () => {
    const css = buildMarimoCss({
      mode: "dark",
      themeId: "catppuccin",
      tokens: { canvas: "#1e1e2e", ink: "#cdd6f4", primary: "oklch(0.7 0.1 250)", "font-mono": '"JetBrains Mono", monospace' },
    });
    expect(css).toContain("--background: #1e1e2e;");
    expect(css).toContain("--foreground: #cdd6f4;");
    expect(css).toContain("--link: oklch(0.7 0.1 250);");
    expect(css).toContain('--marimo-monospace-font: "JetBrains Mono", monospace;');
    expect(css).toContain("color-scheme: dark");
    expect(css).not.toContain("--muted:");
  });
  it("drops unsafe values and returns empty css for empty palettes", () => {
    expect(buildMarimoCss({ mode: "light", themeId: null, tokens: {} })).toBe("");
    const css = buildMarimoCss({ mode: "light", themeId: null, tokens: { canvas: "red; } body { display:none" } });
    expect(css).toBe("");
  });
  it("injects the stylesheet and flips marimo's theme", () => {
    const html = `<html><head><title>x</title></head><body><marimo-user-config data-config="{&quot;display&quot;: {&quot;theme&quot;: &quot;light&quot;, &quot;code_editor_font_size&quot;: 14}}" hidden></marimo-user-config></body></html>`;
    const out = rewriteMarimoHtml(html, "html:root{--background:#000}", "dark");
    expect(out).toContain('<style id="bb-marimo-theme">');
    expect(out).toContain("&quot;theme&quot;: &quot;dark&quot;");
    expect(out.indexOf("<style")).toBeLessThan(out.indexOf("</head>"));
  });
});

describe("proxy", () => {
  it("rewrites html, passes json through, and forwards headers", async () => {
    const upstream = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "healthy", token: request.headers["marimo-server-token"] ?? null }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<html><head></head><body>hi</body></html>`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    const targetPort = typeof address === "object" && address !== null ? address.port : 0;
    let mode: "light" | "dark" = "dark";
    const proxy = await startProxy({
      targetPort,
      basePort: 29000,
      theme: { current: () => ({ css: `html:root{--background:${mode}}`, mode }) },
    });
    try {
      const html = await (await fetch(`${proxy.url}/`)).text();
      expect(html).toContain("--background:dark");
      mode = "light";
      const html2 = await (await fetch(`${proxy.url}/?file=x.py`)).text();
      expect(html2).toContain("--background:light");
      const json = await (await fetch(`${proxy.url}/health`, { headers: { "Marimo-Server-Token": "abc" } })).json();
      expect(json).toEqual({ status: "healthy", token: "abc" });
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
