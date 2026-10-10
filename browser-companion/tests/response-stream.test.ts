import { expect, test } from "bun:test";
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown } from "../src/response-stream";

function katex(source: string, display = false): string {
  const escaped = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const math = '<span class="katex"><span class="katex-mathml"><math><semantics>'
    + `<annotation encoding="application/x-tex">${escaped}</annotation>`
    + '</semantics></math></span><span class="katex-html" aria-hidden="true">VISUAL</span></span>';
  return display ? `<span class="katex-display">${math}</span>` : math;
}

test("stable Markdown conversion preserves KaTeX source once and strips active controls", () => {
  const inline = String.raw`E = mc^2`;
  const display = String.raw`r_{\mathrm{eff}} = \exp(-x)`;
  expect(chatGptHtmlToMarkdown(`<p>Inline: ${katex(inline)}.</p>${katex(display, true)}<script>alert(1)</script><button>Copy</button>`))
    .toBe(`Inline: \\(${inline}\\).\n\n\\[\n${display}\n\\]`);
});

test("Markdown buffer emits append-only stable deltas and rejects rewritten committed blocks", () => {
  const first = { key:"a", tag:"p", html:"<p>First.</p>", text:"First.", streamable:true };
  const second = { key:"b", tag:"p", html:"<p>Second.</p>", text:"Second.", streamable:false };
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  expect(buffer.observe([first, second], 0)).toBe("First.");
  expect(buffer.observe([first, { ...second, streamable:true }], 1)).toBe("\n\nSecond.");
  expect(buffer.finish()).toEqual({ markdown:"First.\n\nSecond.", delta:"" });
  buffer.observe([{ ...first, html:"<p>Changed.</p>", text:"Changed." }, second], 2);
  expect(() => buffer.finish()).toThrow("changed a completed text block");
});

test("atomic commentary may settle to a revised draft without exposing hidden chain-of-thought", () => {
  const first = { key:"a", tag:"p", html:"<p>Earlier summary.</p>", text:"Earlier summary.", streamable:true };
  const final = { key:"a", tag:"p", html:"<p>Visible final summary.</p>", text:"Visible final summary.", streamable:true };
  const buffer = new ChatGptMarkdownBuffer(undefined, 0, "complete");
  expect(buffer.observe([first])).toBe("");
  expect(buffer.observe([final])).toBe("");
  expect(buffer.finish().markdown).toBe("Visible final summary.");
});

test("file paths become safe links while code and unsafe URL-shaped values stay literal", () => {
  expect(chatGptHtmlToMarkdown('<p>Created <code>src/report.json</code>. Keep <code>javascript:alert(1)</code>.</p>'))
    .toBe("Created [src/report.json](<src/report.json>). Keep `javascript:alert(1)`.");
});
