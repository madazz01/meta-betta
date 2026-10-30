import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { acquire, current, release, subscribeLock } from "../muse/turnLock.js";

describe("turnLock", () => {
  afterEach(() => {
    release("a");
    release("b");
  });

  it("holds for one tab at a time across holders", () => {
    assert.equal(acquire("a"), true);
    assert.equal(current(), "a");
    assert.equal(acquire("b"), false);
    assert.equal(current(), "a");
    release("a");
    assert.equal(current(), undefined);
    assert.equal(acquire("b"), true);
    assert.equal(current(), "b");
  });

  it("is non-reentrant and ignores strangers", () => {
    assert.equal(acquire("a"), true);
    assert.equal(acquire("a"), false);
    release("b");
    assert.equal(current(), "a");
    release("a");
    assert.equal(current(), undefined);
  });

  it("notifies subscribers on holder changes only", () => {
    const seen: (string | undefined)[] = [];
    const stop = subscribeLock((holder) => {
      seen.push(holder);
    });
    try {
      assert.equal(acquire("a"), true);
      assert.equal(acquire("b"), false);
      release("b");
      release("a");
      assert.deepEqual(seen, ["a", undefined]);
    } finally {
      stop();
    }
    assert.equal(acquire("a"), true);
    release("a");
    assert.deepEqual(seen, ["a", undefined]);
  });

  it("survives a throwing subscriber", () => {
    const stopBad = subscribeLock(() => {
      throw new Error("boom");
    });
    const seen: (string | undefined)[] = [];
    const stop = subscribeLock((holder) => {
      seen.push(holder);
    });
    try {
      assert.equal(acquire("a"), true);
      release("a");
      assert.deepEqual(seen, ["a", undefined]);
    } finally {
      stopBad();
      stop();
    }
  });
});
