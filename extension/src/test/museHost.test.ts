import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MuseHost, type MuseHostEvent } from "../muse/museHost.js";

describe("MuseHost", () => {
  it("shows the install card when the binary is missing", async () => {
    const events: MuseHostEvent[] = [];
    const host = new MuseHost({
      museBin: "meta-betta-definitely-not-a-real-binary",
      version: "0.0.1",
      emit: (event) => {
        events.push(event);
      },
      askApproval: () => Promise.resolve(undefined),
    });
    // Exercises the real dynamic import of the ESM SDK plus spawn failure.
    await host.send("hello", process.cwd());
    await host.dispose();

    const notice = events.find((event) => event.type === "notice");
    assert.ok(notice && notice.type === "notice");
    assert.match(notice.text, /can't find Muse Code/);
    assert.equal(notice.copy, "irm https://dev.meta.ai/install.ps1 | iex");
    assert.ok(events.some((event) => event.type === "turn" && event.state === "done"));
    assert.ok(events.some((event) => event.type === "status" && event.text === "Ready"));
  });
});
