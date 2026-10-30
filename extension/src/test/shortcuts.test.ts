import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approvalsMenu,
  cleanShortcutSlots,
  DEFAULT_SHORTCUT_SLOTS,
  effortMenu,
  SHORTCUT_IDS,
  SHORTCUT_SLOT_COUNT,
  shortcutDefs,
  shortcutDispatch,
  swapShortcutSlot,
} from "../commands/shortcuts.js";

describe("shortcutDefs", () => {
  it("lists every pill shortcut with id, label, description and a dispatch", () => {
    const defs = shortcutDefs();
    assert.deepEqual(
      defs.map((def) => def.id),
      SHORTCUT_IDS,
    );
    assert.equal(SHORTCUT_IDS.length, 14);
    for (const def of defs) {
      assert.ok(def.label.length > 0, `${def.id} has no label`);
      assert.ok(def.description.length > 0, `${def.id} has no description`);
      assert.ok(shortcutDispatch(def.id) !== undefined, `${def.id} has no dispatch`);
    }
    assert.equal(defs.find((def) => def.id === "save")?.label, "Save my day");
    assert.equal(defs.find((def) => def.id === "goal")?.label, "Goal");
  });

  it("sends Goal to the goal box, everything else to its slash command", () => {
    assert.equal(shortcutDispatch("goal"), "askGoal");
    assert.equal(shortcutDispatch("usage"), "slash");
    assert.equal(shortcutDispatch("save"), "slash");
    assert.equal(shortcutDispatch("nope"), undefined);
  });
});

describe("cleanShortcutSlots", () => {
  it("keeps four known ids and fills gaps with defaults", () => {
    assert.deepEqual(cleanShortcutSlots(["recap", "model", "effort", "tasks"]), ["recap", "model", "effort", "tasks"]);
    assert.deepEqual(cleanShortcutSlots(undefined), DEFAULT_SHORTCUT_SLOTS);
    assert.deepEqual(cleanShortcutSlots([]), DEFAULT_SHORTCUT_SLOTS);
    assert.deepEqual(cleanShortcutSlots(["recap", "nope", "recap"]), ["recap", "goal", "side", "fork"]);
    assert.deepEqual(cleanShortcutSlots(["a", "b", "c", "d", "e", "usage"]), ["usage", "goal", "side", "fork"]);
    assert.equal(cleanShortcutSlots(["usage"]).length, SHORTCUT_SLOT_COUNT);
  });
});

describe("swapShortcutSlot", () => {
  it("swaps when the pick sits on another pill", () => {
    assert.deepEqual(swapShortcutSlot(["goal", "side", "fork", "usage"], 0, "usage"), ["usage", "side", "fork", "goal"]);
  });

  it("sets directly otherwise, and ignores bad picks", () => {
    assert.deepEqual(swapShortcutSlot(["goal", "side", "fork", "usage"], 2, "recap"), ["goal", "side", "recap", "usage"]);
    assert.deepEqual(swapShortcutSlot(["goal", "side", "fork", "usage"], 1, "side"), ["goal", "side", "fork", "usage"]);
    assert.deepEqual(swapShortcutSlot(["goal", "side", "fork", "usage"], 1, "nope"), ["goal", "side", "fork", "usage"]);
    assert.deepEqual(swapShortcutSlot(["goal", "side", "fork", "usage"], 9, "recap"), ["goal", "side", "fork", "usage"]);
  });
});

describe("effortMenu", () => {
  it("reflects the supported levels with the current one ticked", () => {
    assert.deepEqual(effortMenu("normal"), [
      { id: "quick", label: "Quick", ticked: false },
      { id: "normal", label: "Normal", ticked: true },
      { id: "deep", label: "Deep", ticked: false },
    ]);
    assert.ok(effortMenu("deep").find((row) => row.id === "deep")?.ticked);
  });
});

describe("approvalsMenu", () => {
  it("offers Ask, Auto and All with the current one ticked", () => {
    assert.deepEqual(approvalsMenu("auto"), [
      { id: "ask", label: "Ask", ticked: false },
      { id: "auto", label: "Auto", ticked: true },
      { id: "all", label: "All", ticked: false },
    ]);
    assert.ok(approvalsMenu("all").find((row) => row.id === "all")?.ticked);
  });
});
