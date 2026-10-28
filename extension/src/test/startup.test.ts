import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifySpawnError, parseSandboxReady, shortReason } from "../lib/startup.js";

describe("parseSandboxReady", () => {
  it("accepts status=ready", () => {
    assert.equal(parseSandboxReady("backend=windows_elevated\nstatus=ready\n"), true);
  });

  it("accepts spacing and casing variants", () => {
    assert.equal(parseSandboxReady("Status = Ready"), true);
  });

  it("rejects anything else", () => {
    assert.equal(parseSandboxReady("status=not_ready"), false);
    assert.equal(parseSandboxReady("status=missing"), false);
    assert.equal(parseSandboxReady(""), false);
    assert.equal(parseSandboxReady("no status here"), false);
  });
});

describe("classifySpawnError", () => {
  it("spots a missing binary from a raw ENOENT", () => {
    assert.equal(classifySpawnError(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })), "missing");
  });

  it("spots a missing binary from the SDK's typed spawnFailed arm", () => {
    const error = new Error("host lost before handshake");
    (error as unknown as Record<string, unknown>).failure = {
      kind: "spawnFailed",
      error: Object.assign(new Error("spawn muse ENOENT"), { code: "ENOENT" }),
    };
    assert.equal(classifySpawnError(error), "missing");
  });

  it("spots a login problem from the message or stderr tail", () => {
    assert.equal(classifySpawnError(new Error("not logged in, run `muse` once")), "login");
    const error = new Error("host exited");
    (error as unknown as Record<string, unknown>).stderrTail = ["error: auth required"];
    assert.equal(classifySpawnError(error), "login");
  });

  it("looks through cause chains (the manual spawn path wraps errors)", () => {
    const missing = new Error("handshake failed", {
      cause: Object.assign(new Error("spawn muse ENOENT"), { code: "ENOENT" }),
    });
    assert.equal(classifySpawnError(missing), "missing");
    const login = new Error("host exited", { cause: new Error("not logged in") });
    assert.equal(classifySpawnError(login), "login");
  });

  it("calls everything else other", () => {
    assert.equal(classifySpawnError(new Error("connection reset")), "other");
    assert.equal(classifySpawnError(undefined), "other");
  });
});

describe("shortReason", () => {
  it("keeps one short line", () => {
    assert.equal(shortReason(new Error("quota exhausted")), "quota exhausted");
  });

  it("folds whitespace and bounds the length", () => {
    assert.equal(shortReason(new Error("line one\nline two")), "line one line two");
    assert.equal(shortReason(new Error("x".repeat(200)), 10), "xxxxxxxxx…");
  });

  it("never comes back empty", () => {
    assert.equal(shortReason(undefined), "it didn't say why");
    assert.equal(shortReason(new Error("")), "it didn't say why");
  });
});
