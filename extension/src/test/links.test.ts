import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFileLink } from "../lib/links.js";

const ROOT = "C:\\work\\demo";

describe("parseFileLink", () => {
  it("resolves relative paths against the workspace", () => {
    assert.deepEqual(parseFileLink("src/app.ts", ROOT), { fsPath: `${ROOT}\\src\\app.ts` });
  });

  it("reads line and column suffixes", () => {
    assert.deepEqual(parseFileLink("src/app.ts:12", ROOT), {
      fsPath: `${ROOT}\\src\\app.ts`,
      line: 12,
    });
    assert.deepEqual(parseFileLink("src/app.ts:12:4", ROOT), {
      fsPath: `${ROOT}\\src\\app.ts`,
      line: 12,
      column: 4,
    });
  });

  it("accepts file URIs and absolute paths", () => {
    assert.deepEqual(parseFileLink("file:///C:/work/demo/src/app.ts", ROOT), {
      fsPath: `${ROOT}\\src\\app.ts`,
    });
    assert.deepEqual(parseFileLink("C:\\work\\demo\\src\\app.ts", ROOT), {
      fsPath: `${ROOT}\\src\\app.ts`,
    });
  });

  it("rejects URLs, other schemes, and empties", () => {
    assert.equal(parseFileLink("https://example.com/x.ts", ROOT), undefined);
    assert.equal(parseFileLink("vscode:extension/x", ROOT), undefined);
    assert.equal(parseFileLink("", ROOT), undefined);
    assert.equal(parseFileLink("   ", ROOT), undefined);
  });
});
