import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/markdown.js";

const ps = [{ id: "p1", name: "Claude" }, { id: "p2", name: "Paw" }];

describe("renderMarkdown", () => {
  it("renders markdown and escapes html", () => {
    const html = renderMarkdown("**bold** <script>alert(1)</script>", ps, []);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("highlights resolved mentions only", () => {
    const html = renderMarkdown("hi @claude and @nobody", ps, ["p1"]);
    expect(html).toContain('<span class="mention">@claude</span>');
    expect(html).toContain("@nobody");
    expect(html).not.toContain('class="mention">@nobody');
  });
  it("does not touch mentions inside code", () => {
    const html = renderMarkdown("`@Claude`", ps, ["p1"]);
    expect(html).toContain("<code>@Claude</code>");
    expect(html).not.toContain('class="mention"');
  });
  it("strips dangerous links", () => {
    const html = renderMarkdown("[x](javascript:alert(1))", ps, []);
    expect(html).not.toContain("javascript:");
  });
});
