import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTranscript, cleanTranscript, decideSession } from "../lib/session.js";

describe("decideSession", () => {
  it("starts fresh with no saved id", () => {
    assert.equal(decideSession(undefined, false), "start-fresh");
    assert.equal(decideSession("", false), "start-fresh");
    assert.equal(decideSession("   ", true), "start-fresh");
  });

  it("resumes when the saved session reopens", () => {
    assert.equal(decideSession("abc", true), "resume-saved");
  });

  it("restarts with a notice when the resume fails", () => {
    assert.equal(decideSession("abc", false), "restart-after-failed-resume");
  });
});

describe("buildTranscript", () => {
  it("keeps user and assistant text only", () => {
    assert.deepEqual(
      buildTranscript([
        { type: "user", text: "hi" },
        { type: "thinking", text: "hmm" },
        { type: "assistant", text: "hello" },
        { type: "tool", text: "Ran tests" },
        { type: "notice", text: "Stopped." },
      ]),
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
    );
  });

  it("caps entries and text length", () => {
    const events = Array.from({ length: 30 }, (_, index) => ({ type: "user", text: `m${index}` }));
    const transcript = buildTranscript(events);
    assert.equal(transcript.length, 20);
    assert.equal(transcript[0]?.text, "m10");
    assert.equal(buildTranscript([{ type: "user", text: "x".repeat(5000) }])[0]?.text.length, 4000);
  });
});

describe("cleanTranscript", () => {
  it("accepts a well-formed list", () => {
    assert.deepEqual(cleanTranscript([{ role: "user", text: "hi" }]), [{ role: "user", text: "hi" }]);
  });

  it("drops anything else", () => {
    assert.deepEqual(cleanTranscript(undefined), []);
    assert.deepEqual(cleanTranscript({}), []);
    assert.deepEqual(
      cleanTranscript([{ role: "user", text: "hi" }, null, { role: "tool", text: "x" }, { role: "user" }]),
      [{ role: "user", text: "hi" }],
    );
  });
});
