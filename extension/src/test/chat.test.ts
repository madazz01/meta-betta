import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendMessage, canSend, formatEcho, parseNudgeAnswer, parseSendMessage } from "../lib/chat.js";
import { createNonce } from "../lib/nonce.js";

describe("canSend", () => {
  it("accepts plain text", () => {
    assert.equal(canSend("hi"), true);
  });

  it("rejects blank text", () => {
    assert.equal(canSend(""), false);
    assert.equal(canSend("   "), false);
    assert.equal(canSend("\n\t "), false);
  });
});

describe("appendMessage", () => {
  it("appends without mutating the input", () => {
    const before = [{ role: "user" as const, text: "hi" }];
    const after = appendMessage(before, { role: "assistant", text: "Echo: hi" });

    assert.equal(after.length, 2);
    assert.equal(before.length, 1);
    assert.deepEqual(after[1], { role: "assistant", text: "Echo: hi" });
  });
});

describe("formatEcho", () => {
  it("prefixes the text with Echo:", () => {
    assert.equal(formatEcho("hi"), "Echo: hi");
  });
});

describe("parseSendMessage", () => {
  it("accepts a send message", () => {
    assert.equal(parseSendMessage({ type: "send", text: "hi" }), "hi");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(parseSendMessage({ type: "send", text: "  hi\n" }), "hi");
  });

  it("rejects blank text", () => {
    assert.equal(parseSendMessage({ type: "send", text: "   " }), undefined);
  });

  it("rejects other shapes", () => {
    assert.equal(parseSendMessage(undefined), undefined);
    assert.equal(parseSendMessage(null), undefined);
    assert.equal(parseSendMessage("send"), undefined);
    assert.equal(parseSendMessage({ type: "reply", text: "hi" }), undefined);
    assert.equal(parseSendMessage({ type: "send" }), undefined);
    assert.equal(parseSendMessage({ type: "send", text: 42 }), undefined);
  });
});

describe("parseNudgeAnswer", () => {
  it("accepts a card button press", () => {
    assert.deepEqual(parseNudgeAnswer({ type: "nudgeAnswer", id: "a1", answer: "show", thing: "read photos" }), {
      id: "a1",
      answer: "show",
      thing: "read photos",
    });
    assert.deepEqual(parseNudgeAnswer({ type: "nudgeAnswer", id: "a1", answer: "notnow" }), {
      id: "a1",
      answer: "notnow",
      thing: "",
    });
  });

  it("rejects other shapes", () => {
    assert.equal(parseNudgeAnswer(undefined), undefined);
    assert.equal(parseNudgeAnswer({ type: "nudgeAnswer", id: "a1", answer: "maybe" }), undefined);
    assert.equal(parseNudgeAnswer({ type: "nudgeAnswer", id: "", answer: "show" }), undefined);
    assert.equal(parseNudgeAnswer({ type: "nudgeAnswer", answer: "show" }), undefined);
    assert.equal(parseNudgeAnswer({ type: "nudgeAnswer", id: "a1", answer: "show", thing: 42 }), undefined);
  });
});

describe("createNonce", () => {
  it("returns 32 alphanumeric characters by default", () => {
    assert.match(createNonce(), /^[A-Za-z0-9]{32}$/);
  });

  it("returns unique values", () => {
    assert.notEqual(createNonce(), createNonce());
  });
});
