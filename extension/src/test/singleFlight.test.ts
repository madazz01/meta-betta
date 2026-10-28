import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { singleFlight } from "../lib/singleFlight.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("singleFlight", () => {
  it("runs concurrent callers on one shared call", async () => {
    let calls = 0;
    const fn = singleFlight(async () => {
      calls += 1;
      await tick();
      return "done";
    });

    const [first, second] = await Promise.all([fn(), fn()]);
    assert.equal(first, "done");
    assert.equal(second, "done");
    assert.equal(calls, 1);
  });

  it("runs again after the shared call settles", async () => {
    let calls = 0;
    const fn = singleFlight(async () => {
      calls += 1;
      return calls;
    });

    assert.equal(await fn(), 1);
    assert.equal(await fn(), 2);
  });

  it("does not cache failures; every waiter sees the error", async () => {
    let calls = 0;
    const fn = singleFlight(async () => {
      calls += 1;
      await tick();
      throw new Error("boom");
    });

    await assert.rejects(Promise.all([fn(), fn()]), /boom/);
    assert.equal(calls, 1);
    await assert.rejects(fn(), /boom/);
    assert.equal(calls, 2);
  });
});
