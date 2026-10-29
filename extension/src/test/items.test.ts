import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  historyEvent,
  isSandboxBugFailure,
  reasoningText,
  SANDBOX_BUG_TEXT,
  toolRowText,
} from "../lib/items.js";

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

  it("falls back to friendly words from the tool and path", () => {
    assert.equal(
      toolRowText({
        kind: "toolCall",
        tool: "write_file",
        args: JSON.stringify({ path: "hello.txt" }),
        status: "inProgress",
      }).text,
      "📄 Writing hello.txt",
    );
    assert.equal(
      toolRowText({
        kind: "toolCall",
        tool: "write_file",
        args: JSON.stringify({ path: "hello.txt" }),
        status: "completed",
      }).text,
      "📄 Wrote hello.txt ✓",
    );
  });

  it("names shell tools from their command", () => {
    assert.equal(
      toolRowText({
        kind: "toolCall",
        tool: "bash",
        args: JSON.stringify({ command: "npm test" }),
        status: "completed",
      }).text,
      "▶ Ran npm test ✓",
    );
  });

  it("prettifies unknown tools instead of showing the raw id", () => {
    assert.equal(
      toolRowText({ kind: "toolCall", tool: "mystery_box", status: "inProgress" }).text,
      "🔧 Mystery box",
    );
    assert.equal(
      toolRowText({ kind: "toolCall", tool: "mystery_box", args: "not json", status: "completed" }).text,
      "🔧 Mystery box ✓",
    );
  });

  it("words fallback failures without implying success", () => {
    assert.equal(
      toolRowText({
        kind: "toolCall",
        tool: "write_file",
        args: JSON.stringify({ path: "hello.txt" }),
        status: "failed",
        failureReason: "denied",
      }).text,
      "📄 Writing hello.txt (didn't work: denied)",
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

  it("spots the Windows sandbox bug in a failure reason", () => {
    assert.equal(
      isSandboxBugFailure("sandbox enforcement unavailable: windows_elevated setup_required"),
      true,
    );
    assert.equal(isSandboxBugFailure("denied"), false);
    assert.equal(isSandboxBugFailure(undefined), false);
  });

  it("shows one plain line for the sandbox bug, never the raw error", () => {
    const row = toolRowText({
      kind: "toolCall",
      tool: "bash",
      args: JSON.stringify({ command: "npm test" }),
      status: "failed",
      failureReason: "sandbox enforcement unavailable: windows_elevated setup_required",
    });
    assert.equal(
      row.text,
      `▶ Running npm test (didn't work: ${SANDBOX_BUG_TEXT})`,
    );
    assert.equal(row.failed, true);
  });

  it("keeps later sandbox failures short once the line has shown", () => {
    const row = toolRowText(
      {
        kind: "toolCall",
        tool: "bash",
        args: JSON.stringify({ command: "npm test" }),
        status: "failed",
        failureReason: "sandbox enforcement unavailable: windows_elevated setup_required",
      },
      true,
    );
    assert.equal(row.text, "▶ Running npm test (didn't work)");
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

describe("historyEvent", () => {
  it("keeps user and agent messages", () => {
    assert.deepEqual(
      historyEvent({ kind: "userMessage", itemId: "u1", text: "hi" }),
      { type: "user", text: "hi" },
    );
    assert.deepEqual(
      historyEvent({ kind: "agentMessage", itemId: "a1", text: "hello" }),
      { type: "assistant", id: "a1", text: "hello" },
    );
  });

  it("keeps thinking with its item id", () => {
    assert.deepEqual(
      historyEvent({ kind: "reasoning", itemId: "r1", summary: ["hmm"] }),
      { type: "thinking", id: "r1", text: "hmm" },
    );
  });

  it("skips tools, internals, and empty messages", () => {
    assert.equal(historyEvent({ kind: "toolCall", itemId: "t1", text: "x" }), undefined);
    assert.equal(historyEvent({ kind: "reminderChild", itemId: "r2" }), undefined);
    assert.equal(historyEvent({ kind: "agentMessage", itemId: "a2" }), undefined);
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
