import { expect, test } from "bun:test";
import { renderMd, safeUrl } from "../src/ui/md";

test("markdown drops script URLs and escapes raw HTML", () => {
  const html = renderMd(
    "[x](javascript:alert(1)) [y](JaVaScRiPt:alert(1)) ![p](data:image/svg+xml;base64,PHN2Zz4=) <script>alert(1)</script> <img src=x onerror=alert(1)>",
  );
  // The payloads survive only as inert, escaped text: no element and no attribute carries them.
  expect(html).not.toMatch(/<(a|img|script)\b|(href|src)="(javascript|data):/i);
  expect(html).toContain("&lt;script&gt;");
});

test("markdown keeps safe links and opens external ones in a new tab", () => {
  expect(renderMd("[a](/issue/ENG-1)")).toContain('href="/issue/ENG-1"');
  expect(renderMd("![i](/files/abc)")).toContain('src="/files/abc"');
  const ext = renderMd("see https://example.com");
  expect(ext).toContain('href="https://example.com"');
  expect(ext).toContain('target="_blank"');
  expect(ext).toContain('rel="noopener noreferrer"');
});

test("safeUrl refuses other origins in disguise", () => {
  for (const u of ["//evil.example", "/\\evil.example", "javascript:alert(1)", "data:text/html,x", " vbscript:x", 5]) expect(safeUrl(u)).toBeNull();
  for (const u of ["https://x.example/a", "/files/1", "#top"]) expect(safeUrl(u)).toBe(u);
});
