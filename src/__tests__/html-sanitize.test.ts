/**
 * HTML sanitizer — defense-in-depth for the Quill 2.0.3 XSS
 * (CVE-2025-15056). Editor-field values pass through `sanitizeHtml` on every
 * write; this test pins the expected behaviour.
 */
import { describe, expect, it } from "bun:test";
import { sanitizeHtml } from "../core/html-sanitize.ts";

describe("sanitizeHtml — script vectors", () => {
  it("strips <script> tags and their contents", () => {
    const out = sanitizeHtml(`<p>hi</p><script>alert(1)</script>`);
    expect(out).toBe(`<p>hi</p>`);
  });

  it("strips <iframe>", () => {
    const out = sanitizeHtml(`<p>x</p><iframe src="javascript:alert(1)"></iframe>`);
    expect(out).toBe(`<p>x</p>`);
  });

  it("strips <svg> with embedded scripts", () => {
    const out = sanitizeHtml(`<p>x</p><svg><script>alert(1)</script></svg>`);
    expect(out).toBe(`<p>x</p>`);
  });

  it("strips <object> and <embed>", () => {
    expect(sanitizeHtml(`<object data="evil.swf"></object>`)).toBe(``);
    expect(sanitizeHtml(`<embed src="evil.swf">`)).toBe(``);
  });

  it("strips <style> tags", () => {
    const out = sanitizeHtml(`<style>body{background:url('javascript:alert(1)')}</style><p>x</p>`);
    expect(out).toBe(`<p>x</p>`);
  });
});

describe("sanitizeHtml — event handlers", () => {
  it("strips inline onclick", () => {
    const out = sanitizeHtml(`<p onclick="alert(1)">x</p>`);
    expect(out).toBe(`<p>x</p>`);
  });

  it("strips onerror on <img>", () => {
    const out = sanitizeHtml(`<img src="x" onerror="alert(1)">`);
    expect(out).toBe(`<img src="x">`);
  });

  it("strips ALL on* handlers regardless of casing", () => {
    const out = sanitizeHtml(`<p onMouseOver="alert(1)" ONLOAD="alert(2)">x</p>`);
    expect(out).toBe(`<p>x</p>`);
  });
});

describe("sanitizeHtml — URL schemes", () => {
  it("strips javascript: href", () => {
    const out = sanitizeHtml(`<a href="javascript:alert(1)">click</a>`);
    expect(out).toBe(`<a>click</a>`);
  });

  it("strips data: src on <img>", () => {
    const out = sanitizeHtml(`<img src="data:text/html,<script>alert(1)</script>">`);
    expect(out).toBe(`<img>`);
  });

  it("permits https:// href", () => {
    const out = sanitizeHtml(`<a href="https://example.com" title="ok">x</a>`);
    expect(out).toBe(`<a href="https://example.com" title="ok">x</a>`);
  });

  it("permits mailto:", () => {
    const out = sanitizeHtml(`<a href="mailto:a@b.c">x</a>`);
    expect(out).toBe(`<a href="mailto:a@b.c">x</a>`);
  });

  it("permits relative #fragment", () => {
    const out = sanitizeHtml(`<a href="#section">x</a>`);
    expect(out).toBe(`<a href="#section">x</a>`);
  });
});

describe("sanitizeHtml — attribute hygiene", () => {
  it("strips style attribute (CSS expression / url() exfil)", () => {
    const out = sanitizeHtml(`<p style="background: url('javascript:alert(1)')">x</p>`);
    expect(out).toBe(`<p>x</p>`);
  });

  it("keeps allowed attrs and drops unknown", () => {
    const out = sanitizeHtml(`<a href="https://x" target="_blank" data-bad="y">x</a>`);
    expect(out).toContain(`href="https://x"`);
    expect(out).toContain(`target="_blank"`);
    expect(out).not.toContain(`data-bad`);
  });

  it("auto-adds rel=noopener noreferrer when target=_blank", () => {
    const out = sanitizeHtml(`<a href="https://x" target="_blank">x</a>`);
    expect(out).toMatch(/rel="noopener noreferrer"/);
  });
});

describe("sanitizeHtml — preserves Quill output shape", () => {
  it("keeps headings, lists, code blocks, blockquotes", () => {
    const html = `<h1>t</h1><h2>s</h2><p>x</p><ul><li>a</li></ul><ol><li>b</li></ol><pre><code>c</code></pre><blockquote>q</blockquote>`;
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("keeps inline marks", () => {
    const html = `<p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s> <code>c</code></p>`;
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("preserves text outside disallowed tags", () => {
    expect(sanitizeHtml(`<custom>hello</custom>`)).toBe(`hello`);
  });
});

describe("sanitizeHtml — edge cases", () => {
  it("returns empty for empty input", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  it("escapes stray < as text", () => {
    expect(sanitizeHtml(`a < b`)).toBe(`a &lt; b`);
  });

  it("strips comments", () => {
    expect(sanitizeHtml(`<!-- nasty --><p>x</p>`)).toBe(`<p>x</p>`);
  });

  it("strips DOCTYPE", () => {
    expect(sanitizeHtml(`<!DOCTYPE html><p>x</p>`)).toBe(`<p>x</p>`);
  });
});
