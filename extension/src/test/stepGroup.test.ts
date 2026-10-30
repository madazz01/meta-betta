import { describe, it } from "node:test";
import assert from "node:assert/strict";

// stepGroup.js is shared with the webview, so the test requires it from media/.
const { stepClass, summarizeSteps, createGrouper } = require("../../media/stepGroup.js") as {
  stepClass: (type: string, failed?: boolean) => string;
  summarizeSteps: (counts: Record<string, number>) => string;
  createGrouper: () => {
    summary: () => string;
    isOpen: () => boolean;
    push: (type: string, failed: boolean | undefined, id: string, group?: string) => {
      action: string;
      summary: string;
    };
    close: () => void;
  };
};

describe("stepClass", () => {
  it("folds ok tool rows and thinking, solos everything else", () => {
    assert.equal(stepClass("tool", false), "step");
    assert.equal(stepClass("tool", undefined), "step");
    assert.equal(stepClass("thinking", false), "step");
    assert.equal(stepClass("tool", true), "solo");
    for (const type of ["user", "assistant", "notice", "card", "picker", "memory", "undo", "day"]) {
      assert.equal(stepClass(type, false), "solo");
    }
  });
});

describe("summarizeSteps", () => {
  const empty = { read: 0, command: 0, edit: 0, search: 0, other: 0 };

  it("words the counts like the panel", () => {
    assert.equal(
      summarizeSteps({ ...empty, read: 8, command: 3, edit: 2 }),
      "▸ Read 8 files · ran 3 commands · edited 2 files",
    );
    assert.equal(summarizeSteps({ ...empty, read: 1 }), "▸ Read 1 file");
    assert.equal(summarizeSteps({ ...empty, search: 2 }), "▸ Searched 2 times");
    assert.equal(summarizeSteps({ ...empty, other: 1 }), "▸ 1 other step");
    assert.equal(summarizeSteps(empty), "▸ Thinking…");
  });
});

describe("createGrouper", () => {
  it("folds consecutive steps and counts each row once", () => {
    const grouper = createGrouper();
    assert.deepEqual(grouper.push("thinking", false, "t1", undefined), {
      action: "fold",
      summary: "▸ Thinking…",
    });
    assert.deepEqual(grouper.push("tool", false, "r1", "read"), {
      action: "fold",
      summary: "▸ Read 1 file",
    });
    // A repaint of the same row doesn't count again.
    assert.deepEqual(grouper.push("tool", false, "r1", "read"), {
      action: "fold",
      summary: "▸ Read 1 file",
    });
    assert.deepEqual(grouper.push("tool", false, "r2", "command"), {
      action: "fold",
      summary: "▸ Read 1 file · ran 1 command",
    });
    assert.equal(grouper.isOpen(), true);
  });

  it("breaks the group on messages and failed rows", () => {
    const grouper = createGrouper();
    grouper.push("tool", false, "r1", "read");
    assert.deepEqual(grouper.push("assistant", false, "a1", undefined), { action: "solo", summary: "" });
    assert.equal(grouper.isOpen(), false);
    // Each text message starts a new group after it.
    assert.deepEqual(grouper.push("tool", false, "r2", "edit"), {
      action: "fold",
      summary: "▸ Edited 1 file",
    });
    assert.deepEqual(grouper.push("tool", true, "r3", "edit"), { action: "solo", summary: "" });
    assert.equal(grouper.isOpen(), false);
  });

  it("moves a failed update out but keeps the group open", () => {
    const grouper = createGrouper();
    grouper.push("tool", false, "r1", "read");
    grouper.push("tool", false, "r2", "read");
    assert.deepEqual(grouper.push("tool", true, "r1", "read"), {
      action: "solo",
      summary: "▸ Read 1 file",
    });
    assert.equal(grouper.isOpen(), true);
    assert.deepEqual(grouper.push("tool", false, "r3", "command"), {
      action: "fold",
      summary: "▸ Read 1 file · ran 1 command",
    });
  });

  it("closes the group at the turn boundary", () => {
    const grouper = createGrouper();
    grouper.push("tool", false, "r1", "read");
    grouper.close();
    assert.equal(grouper.isOpen(), false);
    assert.equal(grouper.summary(), "");
  });
});
