import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reasoningText, toolRowText } from "../lib/items.js";

describe("toolRowText", () => {
  it("renders a running tool call with its active label", () => {
    assert.deepEqual(
      toolRowText({
        kind: "toolCall",
        tool: "edit",
        displayLabel: { active: "Editing app.js", done: "Edited app.js", neutral: "Edit app.js" },
        status: "inProgress",
      }),
      { text: "📄 Editing app.js", done: false, failed: false },
    );
  });

  it("renders a finished tool call with its done label and a tick", () => {
    const row = toolRowText({
      kind: "toolCall",
      tool: "bash",
      displayLabel: { active: "Running tests", done: "Ran tests", neutral: "Run tests" },
      status: "completed",
    });
    assert.equal(row.text, "▶ Ran tests ✓");
    assert.equal(row.done, true);
  });

  it("falls back to the tool name without a label", () => {
    assert.equal(
      toolRowText({ kind: "toolCall", tool: "mystery", status: "inProgress" }).text,
      "🔧 mystery",
    );
  });

  it("words failures plainly, never as a success", () => {
    const row = toolRowText({
      kind: "toolCall",
      tool: "edit",
      displayLabel: { active: "Editing app.js", done: "Edited app.js", neutral: "Edit app.js" },
      status: "failed",
      failureReason: "file not found",
    });
    assert.equal(row.text, "📄 Edit app.js (didn't work: file not found)");
    assert.equal(row.failed, true);
  });

  it("renders shell commands with their text", () => {
    assert.equal(
      toolRowText({ kind: "userShell", commandText: "npm test", status: "completed" }).text,
      "▶ npm test ✓",
    );
  });

  it("renders unknown kinds as a generic working row", () => {
    assert.equal(
      toolRowText({ kind: "subagent", status: "inProgress", fallbackText: "helper running" }).text,
      "Working… — helper running",
    );
    assert.equal(toolRowText({ kind: "weird", status: "inProgress" }).text, "Working…");
  });
});

describe("reasoningText", () => {
  it("joins summary parts", () => {
    assert.equal(reasoningText(["Thinking ", "hard."], undefined), "Thinking hard.");
  });

  it("falls back to raw text, then empty", () => {
    assert.equal(reasoningText([], "raw thoughts"), "raw thoughts");
    assert.equal(reasoningText(undefined, undefined), "");
  });
});
