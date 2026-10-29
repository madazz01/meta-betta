import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanDayUsage,
  formatCost,
  formatStatusBar,
  formatTokens,
  recordDayUsage,
  sumDayUsage,
  todayKey,
} from "../lib/usage.js";

describe("formatTokens", () => {
  it("words counts plainly", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(12400), "12.4k");
    assert.equal(formatTokens(12000), "12k");
    assert.equal(formatTokens(1500000), "1.5M");
  });
});

describe("formatCost", () => {
  it("words dollars as an estimate", () => {
    assert.equal(formatCost(0.03), "~$0.03");
    assert.equal(formatCost(1.248), "~$1.25");
  });
});

describe("formatStatusBar", () => {
  it("shows tokens and cost for the session", () => {
    assert.equal(
      formatStatusBar({ promptTokens: 12400, outputTokens: 3100, totalTokens: 15500, usd: 0.03 }),
      "☕ Muse · 15.5k tokens · ~$0.03",
    );
  });

  it("omits the cost when unpriced, and stays quiet with no usage", () => {
    assert.equal(
      formatStatusBar({ promptTokens: 100, outputTokens: 50, totalTokens: 150 }),
      "☕ Muse · 150 tokens",
    );
    assert.equal(formatStatusBar(undefined), "☕ Muse");
  });
});

describe("day usage", () => {
  it("sums each session's latest totals for today", () => {
    const day = recordDayUsage(undefined, "2026-10-30", "s1", {
      promptTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      usd: 0.01,
    });
    const both = recordDayUsage(day, "2026-10-30", "s2", {
      promptTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      usd: 0.02,
    });
    assert.deepEqual(sumDayUsage(both), { totalTokens: 450, usd: 0.03 });
    // A newer total for s1 replaces the old one, not added twice.
    const updated = recordDayUsage(both, "2026-10-30", "s1", {
      promptTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      usd: 0.1,
    });
    assert.deepEqual(sumDayUsage(updated), { totalTokens: 1800, usd: 0.12 });
  });

  it("starts over on a new day", () => {
    const day = recordDayUsage(undefined, "2026-10-30", "s1", {
      promptTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    const next = recordDayUsage(day, "2026-10-31", "s1", {
      promptTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    assert.deepEqual(sumDayUsage(next), { totalTokens: 15, usd: 0 });
  });

  it("keys days locally", () => {
    assert.equal(todayKey(new Date(2026, 9, 30, 9, 41)), "2026-10-30");
  });

  it("forgets junk, keeps good rows", () => {
    assert.equal(cleanDayUsage(undefined), undefined);
    assert.equal(cleanDayUsage({ date: "2026-10-30" }), undefined);
    assert.deepEqual(
      cleanDayUsage({
        date: "2026-10-30",
        sessions: {
          s1: { promptTokens: 100, outputTokens: 50, totalTokens: 150, usd: 0.01, partial: true },
          s2: { promptTokens: "lots" },
        },
      }),
      {
        date: "2026-10-30",
        sessions: {
          s1: { promptTokens: 100, outputTokens: 50, totalTokens: 150, usd: 0.01, partial: true },
        },
      },
    );
  });
});
