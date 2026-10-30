import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSessionRows, formatAge } from "../sidebar/sessions.js";
import { usageViewData } from "../sidebar/usage.js";

describe("formatAge", () => {
  const now = new Date("2026-10-30T12:00:00").getTime();

  it("says just now, minutes, hours, days, weeks", () => {
    assert.equal(formatAge(now - 10_000, now), "just now");
    assert.equal(formatAge(now - 5 * 60_000, now), "5m");
    assert.equal(formatAge(now - 2 * 3_600_000, now), "2h");
    assert.equal(formatAge(now - 3 * 86_400_000, now), "3d");
    assert.equal(formatAge(now - 9 * 86_400_000, now), "1w");
  });

  it("shows nothing for unknown clocks", () => {
    assert.equal(formatAge(undefined, now), "");
    assert.equal(formatAge(0, now), "");
    assert.equal(formatAge(Number.NaN, now), "");
  });
});

describe("buildSessionRows", () => {
  const now = new Date("2026-10-30T12:00:00").getTime();
  const hour = 3_600_000;

  it("lists open and recent chats newest first with ages", () => {
    const rows = buildSessionRows({
      records: {
        main: { session: "s1", labelId: "58f2", topic: "todo" },
        "tab-old": { session: "s2", labelId: "66ab", topic: "bread" },
      },
      liveUids: ["main"],
      clocks: { main: now - 2 * hour, "tab-old": now - 26 * hour },
      holder: undefined,
      now,
    });
    assert.deepEqual(
      rows.map((row) => [row.uid, row.label, row.age, row.open, row.working]),
      [
        ["main", "Session 58f2 · todo", "2h", true, false],
        ["tab-old", "Session 66ab · bread", "1d", false, false],
      ],
    );
  });

  it("marks the working chat and unnamed ones", () => {
    const rows = buildSessionRows({
      records: {
        main: { session: "s1", labelId: "58f2", topic: "todo" },
        "tab-fresh": {},
      },
      liveUids: ["main", "tab-fresh"],
      clocks: { main: now - hour },
      holder: "main",
      now,
    });
    assert.equal(rows[0]?.working, true);
    assert.deepEqual(
      rows[1],
      { uid: "tab-fresh", label: "New chat", age: "", open: true, working: false },
    );
  });

  it("skips empty records and shows bare topics", () => {
    const rows = buildSessionRows({
      records: { main: { topic: "untitled" }, ghost: {} },
      liveUids: [],
      clocks: {},
      holder: undefined,
      now,
    });
    assert.deepEqual(
      rows.map((row) => row.label),
      ["untitled"],
    );
  });
});

describe("usageViewData", () => {
  const now = new Date("2026-10-30T12:00:00").getTime();

  it("shapes today, session and allowance lines like /usage", () => {
    const data = usageViewData(
      {
        session: { totalTokens: 2100, promptTokens: 1500, outputTokens: 600, usd: 0.02 },
        today: { totalTokens: 15500, usd: 0.11 },
        window: { usedPercent: 16, resetsAtMs: now + 3_600_000 },
      },
      now,
    );
    assert.equal(data.today, "15.5k tokens today · ~$0.11");
    assert.equal(data.session, "This chat: 2.1k total · ~$0.02");
    assert.ok(data.allowance?.label.startsWith("Free credits: 16% used"));
    assert.equal(data.allowance?.usedPercent, 16);
  });

  it("falls back to weekly, and copes with no usage at all", () => {
    const weekly = usageViewData(
      { today: { totalTokens: 0, usd: 0 }, weekly: { usedPercent: 4, resetsAtMs: now } },
      now,
    );
    assert.equal(weekly.today, "0 tokens today");
    assert.equal(weekly.session, "This chat: no usage yet");
    assert.ok(weekly.allowance?.label.startsWith("Free credits: 4% used"));

    const bare = usageViewData({ today: { totalTokens: 100, usd: 0 } }, now);
    assert.equal(bare.allowance, undefined);
    assert.equal(bare.today, "100 tokens today");
  });
});
