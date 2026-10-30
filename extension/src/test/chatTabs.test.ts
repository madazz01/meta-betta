import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adoptsStoredLabel,
  clearedKeysOnFailedResume,
  cleanTabRecords,
  createTabUid,
  findPeekTarget,
  formatPeekBackground,
  MAIN_TAB_UID,
  MessageQueue,
  queueRetryNote,
  reviveSeed,
  tabStorageKey,
  tabTitle,
  type PeekCandidate,
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

describe("tabStorageKey", () => {
  it("keeps the pre-tabs key for the first tab, suffixes the rest", () => {
    assert.equal(tabStorageKey("metaBetta.transcript", MAIN_TAB_UID), "metaBetta.transcript");
    assert.equal(tabStorageKey("metaBetta.transcript", "tab-x"), "metaBetta.transcript.tab-x");
  });
});

describe("clearedKeysOnFailedResume", () => {
  it("forgets only the dead session id, never the transcript or clock", () => {
    assert.deepEqual(clearedKeysOnFailedResume(MAIN_TAB_UID), ["metaBetta.sessionId"]);
    assert.deepEqual(clearedKeysOnFailedResume("tab-x"), []);
  });
});

describe("adoptsStoredLabel", () => {
  it("lets only the first tab adopt the stored label, and only unseeded", () => {
    assert.equal(adoptsStoredLabel(MAIN_TAB_UID, undefined), true);
    assert.equal(adoptsStoredLabel("tab-x", undefined), false);
    assert.equal(adoptsStoredLabel(MAIN_TAB_UID, { labelId: "l1" }), false);
    assert.equal(adoptsStoredLabel("tab-x", { labelId: "l1" }), false);
  });
});

describe("findPeekTarget", () => {
  const chats: PeekCandidate[] = [
    { uid: MAIN_TAB_UID, id: "66ab", label: "Session 66ab · todo", topic: "todo" },
    { uid: "tab-x", id: "58f2", label: "Session 58f2 · bread", topic: "bread" },
  ];

  it("matches an explicit session id or topic", () => {
    assert.equal(findPeekTarget("like we did in session 58f2", MAIN_TAB_UID, chats)?.uid, "tab-x");
    assert.equal(findPeekTarget("the bread chat said otherwise", MAIN_TAB_UID, chats)?.uid, "tab-x");
  });

  it("matches the other tab only when there is exactly one", () => {
    assert.equal(findPeekTarget("ask the other tab", MAIN_TAB_UID, chats)?.uid, "tab-x");
    assert.equal(findPeekTarget("ask the other tab", MAIN_TAB_UID, [...chats, { uid: "tab-y", id: "99aa", label: "Session 99aa · jam", topic: "jam" }]), undefined);
  });

  it("matches yesterday's chat to the first chat, never itself", () => {
    assert.equal(findPeekTarget("as in yesterday's chat", "tab-x", chats)?.uid, MAIN_TAB_UID);
    assert.equal(findPeekTarget("as in yesterday's chat", MAIN_TAB_UID, chats), undefined);
    assert.equal(findPeekTarget("carry on", "tab-x", chats), undefined);
  });

  it("ignores short topics and partial ids", () => {
    assert.equal(findPeekTarget("to do this now", "tab-x", chats), undefined);
    assert.equal(findPeekTarget("mention 58f nearby", "tab-x", chats), undefined);
  });
});

describe("formatPeekBackground", () => {
  it("renders the other chat as You/Muse lines under a background note", () => {
    const block = formatPeekBackground("Session 66ab · todo", [
      { role: "user", text: "delete todo.txt" },
      { role: "assistant", text: "Done." },
      { role: "undo", text: "", id: "undo-1" },
    ]);
    assert.ok(block.includes("[Also relevant: the last messages of 'Session 66ab · todo'."));
    assert.ok(block.includes("You: delete todo.txt"));
    assert.ok(block.includes("Muse: Done."));
    assert.ok(!block.includes("undo-1"));
  });

  it("keeps the newest lines when over budget", () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({ role: "user" as const, text: `message ${index} `.padEnd(300, "x") }));
    const block = formatPeekBackground("Session 66ab · todo", entries);
    assert.ok(block.length <= 4600);
    assert.ok(block.includes("message 29"));
    assert.ok(!block.includes("message 0 "));
  });
});

describe("queueRetryNote", () => {
  it("names the tab, the waiting count and the holder", () => {
    assert.equal(queueRetryNote("tab-x", 2, MAIN_TAB_UID), "queue: tab-x retrying (2 waiting, held by main)");
    assert.equal(queueRetryNote("tab-x", 1, undefined), "queue: tab-x retrying (1 waiting)");
  });
});
