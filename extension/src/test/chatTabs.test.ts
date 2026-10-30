import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanTabRecords,
  createTabUid,
  MessageQueue,
  reviveSeed,
  tabTitle,
} from "../lib/chatTabs.js";

describe("tabTitle", () => {
  it("shows the topic, else the product name", () => {
    assert.equal(tabTitle("todo"), "todo");
    assert.equal(tabTitle("  todo  "), "todo");
    assert.equal(tabTitle(""), "Meta Betta");
    assert.equal(tabTitle("   "), "Meta Betta");
  });
});

describe("createTabUid", () => {
  it("mints unique tab ids", () => {
    const first = createTabUid();
    const second = createTabUid();
    assert.ok(first.startsWith("tab-"));
    assert.notEqual(first, second);
  });
});

describe("reviveSeed", () => {
  it("resumes each tab from its own record", () => {
    const records = {
      main: { session: "s-main", labelId: "l1", topic: "todo" },
      "tab-x": { session: "s-x", labelId: "l2", topic: "bread" },
    };
    assert.deepEqual(reviveSeed("main", records), { session: "s-main", labelId: "l1", topic: "todo" });
    assert.deepEqual(reviveSeed("tab-x", records), { session: "s-x", labelId: "l2", topic: "bread" });
  });

  it("gives the first tab the pre-tabs keys, others fresh", () => {
    const legacy = { session: "s-old", label: { id: "l0", topic: "old" } };
    assert.deepEqual(reviveSeed("main", {}, legacy), { session: "s-old", labelId: "l0", topic: "old" });
    assert.equal(reviveSeed("tab-x", {}, legacy), undefined);
    assert.equal(reviveSeed("main", {}), undefined);
  });
});

describe("cleanTabRecords", () => {
  it("keeps shaped records and forgets the rest", () => {
    assert.deepEqual(
      cleanTabRecords({
        main: { session: "s", labelId: "l", topic: "t", extra: 1 },
        broken: "nope",
        empty: {},
      }),
      { main: { session: "s", labelId: "l", topic: "t" } },
    );
    assert.deepEqual(cleanTabRecords(undefined), {});
  });
});

describe("MessageQueue", () => {
  it("holds five in order, then refuses", () => {
    const queue = new MessageQueue();
    for (let index = 0; index < 5; index += 1) {
      assert.equal(queue.push(`m${index}`), true);
    }
    assert.equal(queue.full, true);
    assert.equal(queue.push("m5"), false);
    assert.equal(queue.size, 5);
    assert.equal(queue.shift(), "m0");
    assert.equal(queue.full, false);
    assert.equal(queue.push("m5"), true);
    assert.deepEqual([queue.shift(), queue.shift(), queue.shift(), queue.shift(), queue.shift()], [
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
    assert.equal(queue.shift(), undefined);
  });
});
