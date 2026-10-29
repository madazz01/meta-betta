import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTranscript,
  cleanTranscript,
  cleanUndos,
  dayLabel,
  decideSession,
  dividerBefore,
  sameDay,
  timeLabel,
  UndoReplayer,
} from "../lib/session.js";

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

  it("keeps undo buttons by id, drops id-less ones", () => {
    assert.deepEqual(cleanTranscript([{ role: "undo", text: "", id: "undo-1" }]), [
      { role: "undo", text: "", id: "undo-1" },
    ]);
    assert.deepEqual(cleanTranscript([{ role: "undo", text: "" }]), []);
    assert.deepEqual(cleanTranscript([{ role: "undoDone", text: "" }]), []);
  });
});

describe("undo transcript round trip", () => {
  it("keeps undo events inline, drops undoDone", () => {
    assert.deepEqual(
      buildTranscript([
        { type: "user", text: "hi" },
        { type: "assistant", text: "hello", id: "a1" },
        { type: "undo", id: "undo-1" },
        { type: "undoDone", id: "undo-1" },
        { type: "thinking", text: "hmm" },
      ]),
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
        { role: "undo", text: "", id: "undo-1" },
      ],
    );
  });
});

describe("message times", () => {
  it("words the time like 9:41 AM", () => {
    assert.equal(timeLabel(new Date(2026, 9, 29, 9, 41).getTime()), "9:41 AM");
    assert.equal(timeLabel(new Date(2026, 9, 29, 14, 5).getTime()), "2:05 PM");
    assert.equal(timeLabel(new Date(2026, 9, 29, 0, 0).getTime()), "12:00 AM");
    assert.equal(timeLabel(new Date(2026, 9, 29, 12, 0).getTime()), "12:00 PM");
  });

  it("words the day like Thu 29 Oct", () => {
    assert.equal(dayLabel(new Date(2026, 9, 29, 9, 41).getTime()), "Thu 29 Oct");
  });

  it("divides days, not hours", () => {
    assert.equal(sameDay(new Date(2026, 9, 29, 9, 0).getTime(), new Date(2026, 9, 29, 23, 59).getTime()), true);
    assert.equal(sameDay(new Date(2026, 9, 29, 23, 59).getTime(), new Date(2026, 9, 30, 0, 1).getTime()), false);
  });

  it("labels the first message and every new day", () => {
    const thu = new Date(2026, 9, 29, 9, 41).getTime();
    const thuLate = new Date(2026, 9, 29, 22, 10).getTime();
    const fri = new Date(2026, 9, 30, 8, 0).getTime();
    const week = new Date(2026, 10, 5, 8, 0).getTime();
    assert.equal(dividerBefore(undefined, thu), "Thu 29 Oct");
    assert.equal(dividerBefore(thu, thuLate), undefined);
    assert.equal(dividerBefore(thuLate, fri), "Fri 30 Oct");
    assert.equal(dividerBefore(fri, week), "Thu 5 Nov");
  });
});

describe("transcript times", () => {
  it("stores message times with the history", () => {
    assert.deepEqual(
      buildTranscript([
        { type: "user", text: "hi", at: 1000 },
        { type: "assistant", text: "hello", id: "a1", at: 2000 },
      ]),
      [
        { role: "user", text: "hi", at: 1000 },
        { role: "assistant", text: "hello", at: 2000 },
      ],
    );
    assert.deepEqual(cleanTranscript([{ role: "user", text: "hi", at: 1000 }]), [
      { role: "user", text: "hi", at: 1000 },
    ]);
  });

  it("keeps the message when its time is junk", () => {
    assert.deepEqual(cleanTranscript([{ role: "user", text: "hi", at: "soon" }]), [
      { role: "user", text: "hi" },
    ]);
  });

  it("keeps nudge answers by id, drops answer-less ones", () => {
    assert.deepEqual(buildTranscript([{ type: "nudgeAnswered", id: "a1", answer: "notnow" }]), [
      { role: "nudge", text: "", id: "a1", answer: "notnow" },
    ]);
    assert.deepEqual(cleanTranscript([{ role: "nudge", text: "", id: "a1", answer: "show" }]), [
      { role: "nudge", text: "", id: "a1", answer: "show" },
    ]);
    assert.deepEqual(cleanTranscript([{ role: "nudge", text: "", id: "a1" }]), []);
    assert.deepEqual(cleanTranscript([{ role: "nudge", text: "", id: "a1", answer: "maybe" }]), []);
  });
});

describe("cleanUndos", () => {
  const valid = {
    id: "undo-1",
    before: "aaa",
    after: "bbb",
    at: 1000,
    files: [{ path: "a.txt", change: "modified" }],
    anchor: 2,
    undone: false,
  };

  it("accepts well-formed targets", () => {
    assert.deepEqual(cleanUndos([valid]), [valid]);
  });

  it("drops junk and caps the list", () => {
    assert.deepEqual(cleanUndos(undefined), []);
    assert.deepEqual(
      cleanUndos([valid, null, { ...valid, id: "" }, { ...valid, files: [] }, { ...valid, files: [{ path: "x", change: "moved" }] }, { ...valid, undone: "yes" }]),
      [valid],
    );
    const many = Array.from({ length: 120 }, (_, index) => ({ ...valid, id: `undo-${index}` }));
    const kept = cleanUndos(many);
    assert.equal(kept.length, 100);
    assert.equal(kept[0]?.id, "undo-20");
  });

  it("keeps a session tag, drops a junk one", () => {
    assert.deepEqual(cleanUndos([{ ...valid, session: "s1" }]), [{ ...valid, session: "s1" }]);
    assert.deepEqual(cleanUndos([{ ...valid, session: 42 }]), [valid]);
  });
});

describe("UndoReplayer", () => {
  const undos = [
    { id: "undo-1", anchor: 1 },
    { id: "undo-2", anchor: 3 },
    { id: "undo-99", anchor: 99 },
  ];

  it("lands each button under its own reply", () => {
    const replay = new UndoReplayer(undos);
    assert.deepEqual(replay.userArrived(), []); // user 1
    assert.deepEqual(replay.assistantArrived(), ["undo-1"]);
    assert.deepEqual(replay.userArrived(), []); // user 2, no undo
    assert.deepEqual(replay.assistantArrived(), []);
    assert.deepEqual(replay.userArrived(), []); // user 3
    assert.deepEqual(replay.assistantArrived(), ["undo-2"]);
    assert.deepEqual(replay.finish(), []); // anchor 99 never arrived: dropped
  });

  it("a trailing reply keeps its button at the end", () => {
    const replay = new UndoReplayer([{ id: "undo-1", anchor: 1 }]);
    assert.deepEqual(replay.userArrived(), []);
    assert.deepEqual(replay.finish(), ["undo-1"]);
  });

  it("a reply with no assistant text still gets its button", () => {
    const replay = new UndoReplayer([{ id: "undo-1", anchor: 1 }]);
    assert.deepEqual(replay.userArrived(), []);
    assert.deepEqual(replay.userArrived(), ["undo-1"]); // next user flushes it first
    assert.deepEqual(replay.assistantArrived(), []);
    assert.deepEqual(replay.finish(), []);
  });

  it("stale buttons never fire twice", () => {
    const replay = new UndoReplayer([{ id: "undo-1", anchor: 1 }]);
    assert.deepEqual(replay.userArrived(), []);
    assert.deepEqual(replay.assistantArrived(), ["undo-1"]);
    assert.deepEqual(replay.assistantArrived(), []);
    assert.deepEqual(replay.finish(), []);
  });

  it("reports who matched and how many users replayed", () => {
    const replay = new UndoReplayer(undos);
    replay.userArrived();
    replay.assistantArrived();
    replay.userArrived();
    replay.assistantArrived();
    replay.userArrived();
    replay.assistantArrived();
    replay.finish();
    assert.deepEqual(replay.firedIds(), ["undo-1", "undo-2"]);
    assert.equal(replay.userCount(), 3);
  });

  it("only arms undos from the resumed session", () => {
    const replay = new UndoReplayer(
      [
        { id: "undo-old", anchor: 1, session: "aaa" },
        { id: "undo-new", anchor: 1, session: "bbb" },
        { id: "undo-legacy", anchor: 2 },
      ],
      "bbb",
    );
    assert.deepEqual(replay.userArrived(), []);
    assert.deepEqual(replay.assistantArrived(), ["undo-new"]);
    assert.deepEqual(replay.userArrived(), []);
    assert.deepEqual(replay.assistantArrived(), ["undo-legacy"]);
    assert.deepEqual(replay.firedIds(), ["undo-new", "undo-legacy"]);
  });
});
