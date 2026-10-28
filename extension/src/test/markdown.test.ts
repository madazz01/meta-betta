import { describe, it } from "node:test";
import assert from "node:assert/strict";

// markdown.js is shared with the webview, so the test requires it from media/.
const { renderMarkdown } = require("../../media/markdown.js") as {
  renderMarkdown: (source: string) => string;
};

describe("renderMarkdown", () => {
  it("renders bold, links, and inline code", () => {
    assert.equal(
      renderMarkdown("**Hi** [there](src/app.ts) and `code`"),
      '<strong>Hi</strong> <a href="src/app.ts">there</a> and <code>code</code>',
    );
  });

  it("renders fenced code blocks verbatim", () => {
    assert.equal(
      renderMarkdown("```js\nconst a = 1 < 2;\n```"),
      "<pre><code>const a = 1 &lt; 2;</code></pre>",
    );
  });

  it("renders bullet and numbered lists", () => {
    assert.equal(renderMarkdown("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
    assert.equal(renderMarkdown("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
  });

  it("breaks plain lines", () => {
    assert.equal(renderMarkdown("one\ntwo"), "one<br>two");
  });

  it("escapes HTML and neutralizes dangerous links", () => {
    assert.equal(renderMarkdown("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
    assert.equal(
      renderMarkdown("[x](javascript:alert(1))"),
      "[x](javascript:alert(1))",
    );
  });

  it("autolinks bare URLs", () => {
    assert.equal(
      renderMarkdown("see https://example.com/a"),
      'see <a href="https://example.com/a">https://example.com/a</a>',
    );
  });
});
