import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FoldedItem, TurnOutcome } from "@muse-code/sdk";
import type { ApprovalRequestParams, Notification } from "@muse-code/sdk/dist/src/msp.js";
import { acquire as acquireTurn, current as lockHolder, release as releaseTurn, TurnBusyError } from "../muse/turnLock.js";
import {
  chainNotifications,
  createCommandId,
  MuseHost,
  serveArgs,
  serveEnv,
  type ApprovalAnswer,
  type PickerEvent,
  type HostClient,
  type HostConnection,
  type HostSession,
  type HostTurn,
  type MuseHostEvent,
  type SetupNeededInfo,
} from "../muse/museHost.js";

describe("MuseHost", () => {
  it("shows the install card when the binary is missing", async () => {
    const events: MuseHostEvent[] = [];
    const host = new MuseHost({
      museBin: "meta-betta-definitely-not-a-real-binary",
      version: "0.0.1",
      trustWorkspace: false,
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

  it("offers the setup again instead of notices when asked", async () => {
    const events: MuseHostEvent[] = [];
    const setups: SetupNeededInfo[] = [];
    const host = new MuseHost({
      museBin: "meta-betta-definitely-not-a-real-binary",
      version: "0.0.1",
      trustWorkspace: false,
      onSetupNeeded: (info) => {
        setups.push(info);
      },
      emit: (event) => {
        events.push(event);
      },
      askApproval: () => Promise.resolve(undefined),
    });
    await host.send("hello", process.cwd());
    await host.dispose();

    assert.equal(setups.length, 1);
    assert.equal(setups[0]?.problem, "missing");
    assert.ok((setups[0]?.reason ?? "").length > 0);
    assert.ok(!events.some((event) => event.type === "notice"));
    assert.ok(events.some((event) => event.type === "turn" && event.state === "done"));
    assert.ok(events.some((event) => event.type === "status" && event.text === "Ready"));
  });

  it("stops the running turn with turn/interrupt", async () => {
    const fake = fakeRunningTurn((method, params, f) => {
      f.commands.push({ method, params });
      f.finishTurn(terminalOutcome("cancelled"));
      return { turnId: "turn-1" };
    });
    const sending = fake.host.send("hello", process.cwd());
    await fake.submitted;
    await new Promise((r) => setTimeout(r, 10));
    await fake.host.stop();
    await sending;
    await fake.host.dispose();

    assert.deepEqual(fake.commands, [
      { method: "turn/interrupt", params: { sessionId: "session-1", turnId: "turn-1" } },
    ]);
    assert.ok(fake.events.some((event) => event.type === "notice" && event.text === "Stopped."));
    assert.ok(fake.events.some((event) => event.type === "turn" && event.state === "done"));
    assert.ok(fake.events.some((event) => event.type === "status" && event.text === "Ready"));
  });

  it("falls back to a panel-side stop when the interrupt throws", async () => {
    const fake = fakeRunningTurn((method, params, f) => {
      f.commands.push({ method, params });
      throw new Error("turn already settled");
    });
    const sending = fake.host.send("hello", process.cwd());
    await fake.submitted;
    await new Promise((r) => setTimeout(r, 10));
    await fake.host.stop();

    // The fallback reports at once, without waiting for a terminal.
    assert.equal(fake.commands.length, 1);
    const stopped = () => fake.events.filter((event) => event.type === "notice" && event.text === "Stopped.");
    assert.equal(stopped().length, 1);

    // A late terminal after the fallback is ignored, not reported twice.
    fake.finishTurn(terminalOutcome("completed"));
    await sending;
    await fake.host.dispose();
    assert.equal(stopped().length, 1);
    assert.ok(fake.events.some((event) => event.type === "turn" && event.state === "done"));
  });

  it("resumes the saved session and shows its history", async () => {
    const fake = fakeStoredSession({
      savedId: "saved-1",
      history: [
        { kind: "userMessage", itemId: "u1", revision: 1, status: "completed", text: "first question" },
        { kind: "agentMessage", itemId: "a1", revision: 2, status: "completed", text: "first answer" },
        { kind: "reasoning", itemId: "r1", revision: 1, status: "completed", summary: ["hmm"] },
        { kind: "toolCall", itemId: "t1", revision: 1, status: "completed", tool: "read" },
      ],
    });
    const shown = await fake.host.prepare(process.cwd());
    assert.equal(shown, 3);
    assert.deepEqual(
      fake.events.filter((event) => event.type === "user" || event.type === "assistant"),
      [
        { type: "user", text: "first question" },
        { type: "assistant", id: "a1", text: "first answer" },
      ],
    );
    assert.ok(fake.events.some((event) => event.type === "thinking" && event.text === "hmm"));
    assert.deepEqual(fake.savedIds, ["saved-1"]);
    assert.equal(fake.startedFresh, false);

    const sending = fake.host.send("follow-up", process.cwd());
    await fake.submitted;
    fake.finishTurn(terminalOutcome("completed"));
    await sending;
    await fake.host.dispose();
  });

  it("starts fresh with one line when resume fails", async () => {
    const fake = fakeStoredSession({ savedId: "gone", resumeThrows: true });
    const shown = await fake.host.prepare(process.cwd());
    assert.equal(shown, 0);
    assert.ok(
      fake.events.some(
        (event) => event.type === "notice" && event.text === "Couldn't reopen yesterday's chat, so I've started a fresh one.",
      ),
    );
    assert.equal(fake.cleared, true);
    assert.deepEqual(fake.savedIds, ["fresh-1"]);
    assert.equal(fake.startedFresh, true);
    await fake.host.dispose();
  });

  it("shows the sandbox-bug line once per session", async () => {
    const failure = (itemId: string): FoldedItem => ({
      kind: "toolCall",
      itemId,
      revision: 1,
      status: "failed",
      tool: "bash",
      failureReason: "sandbox enforcement unavailable: windows_elevated setup_required",
    });
    const fake = fakeItemTurns([[failure("t1"), failure("t2")], [failure("t3")]]);

    await fake.host.send("run the tests", process.cwd());
    const first = toolTexts(fake.events);
    assert.equal(first.length, 2);
    assert.ok(first[0]?.includes("Muse can't run commands from Meta Betta yet"));
    assert.ok(!first[0]?.includes("windows_elevated"));
    assert.equal(first[1], "▶ Running a command (didn't work)");

    await fake.host.newSession(process.cwd());
    await fake.host.send("run them again", process.cwd());
    const second = toolTexts(fake.events).slice(2);
    assert.equal(second.length, 1);
    assert.ok(second[0]?.includes("Muse can't run commands from Meta Betta yet"));

    await fake.host.dispose();
  });
});

function toolTexts(events: MuseHostEvent[]): string[] {
  return events.filter((event) => event.type === "tool").map((event) => event.text);
}

interface ScriptedFake {
  host: MuseHost;
  events: MuseHostEvent[];
  requests: { method: string; params: Record<string, unknown> | undefined }[];
  commands: { method: string; params: Record<string, unknown> }[];
  logs: string[];
  emit(notification: { method: string; params?: Record<string, unknown> }): void;
}

/** Scripted request/command results plus a notification feed. */
function fakeCommands(options: {
  requests?: Record<string, Record<string, unknown>>;
  commands?: Record<string, Record<string, unknown>>;
  sessions?: Record<string, HostSession>;
  failCommands?: string[];
  hostOptions?: {
    sandboxWorkaround?: boolean;
    platform?: string;
    turnOwner?: string;
    approvalMode?: "ask" | "auto";
    approvalAllLeftOn?: string;
    onApprovalAllReverted?: () => void;
    sessionStore?: { loadId: () => string | undefined; saveId: (id: string) => void; clear: () => void };
  };
}): ScriptedFake {
  const events: MuseHostEvent[] = [];
  const requests: ScriptedFake["requests"] = [];
  const commands: ScriptedFake["commands"] = [];
  const logs: string[] = [];
  let notify: ((notification: Notification) => void) | undefined;
  const mainSession: HostSession = {
    sessionId: "session-1",
    sendUserTurn: async () => cannedTurn([]),
    onApproval: () => undefined,
    onApprovalError: () => undefined,
    fold: { items: { list: () => [] } },
  };
  const sessionFor = (sessionId: string): HostSession => options.sessions?.[sessionId] ?? mainSession;
  const client: HostClient = {
    startSession: async () => mainSession,
    resumeSession: async ({ sessionId }) => sessionFor(sessionId),
    close: async () => undefined,
  };
  const connection: HostConnection = {
    command: async (method, params) => {
      commands.push({ method, params });
      if (options.failCommands?.includes(method)) {
        throw new Error(`${method} failed`);
      }
      return options.commands?.[method] ?? { status: "accepted", commandId: "cmd-1" };
    },
    request: async (method, params) => {
      requests.push({ method, params });
      return options.requests?.[method] ?? {};
    },
    onNotification: (handler) => {
      notify = handler;
    },
  };
  return {
    host: new MuseHost({
      museBin: "unused",
      version: "0.0.1",
      trustWorkspace: false,
      ...(options.hostOptions ?? {}),
      emit: (event) => {
        events.push(event);
      },
      askApproval: () => Promise.resolve(undefined),
      createHost: async () => ({ client, connection }),
      log: (message) => {
        logs.push(message);
      },
    }),
    events,
    requests,
    commands,
    logs,
    emit: (notification) => notify?.({ jsonrpc: "2.0", ...notification }),
  };
}

function cannedTurn(items: FoldedItem[], terminal = "completed"): HostTurn {
  return {
    turnId: "turn-1",
    items: async function* () {
      yield* items;
    },
    deltas: async function* () {},
    completed: Promise.resolve(terminalOutcome(terminal)),
  };
}

function historySession(sessionId: string, history: FoldedItem[]): HostSession {
  return {
    sessionId,
    sendUserTurn: async () => cannedTurn([]),
    onApproval: () => undefined,
    onApprovalError: () => undefined,
    fold: { items: { list: () => history } },
  };
}

describe("work log", () => {
  it("ends the turn with counts, line and final id", async () => {
    const fake = fakeItemTurns([
      [
        { kind: "agentMessage", itemId: "a1", revision: 1, status: "completed", text: "looking…" },
        { kind: "toolCall", itemId: "t1", revision: 1, status: "completed", tool: "read" },
        { kind: "userShell", itemId: "t2", revision: 1, status: "completed", commandText: "npm test" },
        { kind: "toolCall", itemId: "t3", revision: 1, status: "completed", tool: "edit" },
        { kind: "agentMessage", itemId: "a2", revision: 2, status: "completed", text: "done!" },
      ],
    ]);
    await fake.host.send("do it", process.cwd());
    await fake.host.dispose();
    const done = fake.events.find((event) => event.type === "turn" && event.state === "done");
    assert.ok(done && done.type === "turn");
    assert.equal(done.finalId, "a2");
    assert.match(done.line ?? "", /read 1 file · ran 1 command · edited 1 file/);
  });

  it("skips the final id when no message ends the turn", async () => {
    const fake = fakeItemTurns([
      [{ kind: "toolCall", itemId: "t1", revision: 1, status: "completed", tool: "read" }],
    ]);
    await fake.host.send("look", process.cwd());
    await fake.host.dispose();
    const done = fake.events.find((event) => event.type === "turn" && event.state === "done");
    assert.ok(done && done.type === "turn");
    assert.equal(done.finalId, undefined);
    assert.match(done.line ?? "", /read 1 file/);
  });

  it("regroups resumed history into spans with derived lines", async () => {
    const fake = fakeStoredSession({
      savedId: "saved-1",
      history: [
        {
          kind: "userMessage",
          itemId: "u1",
          revision: 1,
          status: "completed",
          text: "first",
          recordedAt: "2026-10-30T10:00:00.000Z",
        },
        {
          kind: "agentMessage",
          itemId: "a1",
          revision: 2,
          status: "completed",
          text: "working on it",
          recordedAt: "2026-10-30T10:00:10.000Z",
        },
        {
          kind: "agentMessage",
          itemId: "a2",
          revision: 3,
          status: "completed",
          text: "first answer",
          recordedAt: "2026-10-30T10:01:00.000Z",
        },
        {
          kind: "userMessage",
          itemId: "u2",
          revision: 4,
          status: "completed",
          text: "second",
          recordedAt: "2026-10-30T10:02:00.000Z",
        },
        {
          kind: "agentMessage",
          itemId: "a3",
          revision: 5,
          status: "completed",
          text: "second answer",
          recordedAt: "2026-10-30T10:02:05.000Z",
        },
      ],
    });
    const shown = await fake.host.prepare(process.cwd());
    await fake.host.dispose();
    assert.equal(shown, 5);
    const turns = fake.events.filter((event) => event.type === "turn");
    assert.deepEqual(
      turns.map((event) => (event.type === "turn" ? [event.state, event.replay] : [])),
      [
        ["started", true],
        ["done", true],
        ["started", true],
        ["done", true],
      ],
    );
    const dones = turns.filter((event) => event.type === "turn" && event.state === "done");
    assert.equal(dones[0]?.type === "turn" ? dones[0].finalId : undefined, "a2");
    assert.equal(dones[0]?.type === "turn" ? dones[0].line : undefined, "Worked 1m");
    assert.equal(dones[1]?.type === "turn" ? dones[1].finalId : undefined, "a3");
    assert.equal(dones[1]?.type === "turn" ? dones[1].line : undefined, "Worked 5s");
  });
});

describe("steer", () => {
  it("steers into the running turn with a command id", async () => {
    const fake = fakeRunningTurn((method, params, f) => {
      f.commands.push({ method, params });
      return { status: "accepted", commandId: "cmd-1" };
    });
    const sending = fake.host.send("hello", process.cwd());
    await fake.submitted;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await fake.host.steer("actually, do it twice"), true);
    fake.finishTurn(terminalOutcome("completed"));
    await sending;
    await fake.host.dispose();
    const steered = fake.commands.find((entry) => entry.method === "turn/steer");
    assert.ok(steered);
    assert.equal(steered.params.sessionId, "session-1");
    assert.equal(steered.params.expectedTurnId, "turn-1");
    assert.deepEqual(steered.params.input, [{ type: "text", text: "actually, do it twice" }]);
    assert.match(
      String(steered.params.commandId),
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("fails softly with no running turn, or a refused steer", async () => {
    const idle = fakeCommands({});
    assert.equal(await idle.host.steer("hello?"), false);
    await idle.host.dispose();
    const refusing = fakeRunningTurn((method, params, f) => {
      f.commands.push({ method, params });
      throw new Error("turn settled");
    });
    const sending = refusing.host.send("hello", process.cwd());
    await refusing.submitted;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await refusing.host.steer("too late"), false);
    refusing.finishTurn(terminalOutcome("completed"));
    await sending;
    await refusing.host.dispose();
  });
});

describe("createCommandId", () => {
  it("makes UUIDv7 handles, deterministic on the seam", () => {
    const rand = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const first = createCommandId(0, rand);
    assert.equal(first, createCommandId(0, rand));
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(first.startsWith("00000000-0000-7"));
    assert.match(createCommandId(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("chainNotifications", () => {
  it("fires every handler, newest first, on the single slot", () => {
    let slot: ((notification: Notification) => void) | undefined;
    const connection: HostConnection = {
      command: async () => ({}),
      request: async () => ({}),
      onNotification: (handler) => {
        slot = handler;
      },
    };
    chainNotifications(connection);
    const seen: string[] = [];
    connection.onNotification(() => {
      seen.push("facade");
    });
    connection.onNotification(() => {
      seen.push("ours");
    });
    slot?.({ jsonrpc: "2.0", method: "session/tokenUsage", params: {} });
    assert.deepEqual(seen, ["ours", "facade"]);
  });

  it("keeps delivering after a handler throws", () => {
    let slot: ((notification: Notification) => void) | undefined;
    const connection: HostConnection = {
      command: async () => ({}),
      request: async () => ({}),
      onNotification: (handler) => {
        slot = handler;
      },
    };
    const failures: unknown[] = [];
    chainNotifications(connection, (error) => {
      failures.push(error);
    });
    const seen: string[] = [];
    connection.onNotification(() => {
      seen.push("first");
    });
    connection.onNotification(() => {
      throw new Error("boom");
    });
    connection.onNotification(() => {
      seen.push("last");
    });
    slot?.({ jsonrpc: "2.0", method: "session/tokenUsage", params: {} });
    assert.deepEqual(seen, ["last", "first"]);
    assert.equal(failures.length, 1);
  });
});

describe("serveArgs", () => {
  it("adds --disable-sandbox on Windows while the workaround is on", () => {
    assert.deepEqual(serveArgs("win32", true, true), ["serve", "--trust-workspace", "--disable-sandbox"]);
    assert.deepEqual(serveArgs("win32", false, true), ["serve", "--disable-sandbox"]);
  });

  it("leaves other platforms and the setting-off path alone", () => {
    assert.deepEqual(serveArgs("win32", true, false), ["serve", "--trust-workspace"]);
    assert.deepEqual(serveArgs("darwin", true, true), ["serve", "--trust-workspace"]);
    assert.deepEqual(serveArgs("linux", false, true), ["serve"]);
  });
});

describe("serveEnv", () => {
  it("leaves the env alone without a key", () => {
    assert.equal(serveEnv(undefined), undefined);
    assert.equal(serveEnv("   "), undefined);
  });

  it("adds META_API_KEY over a copy of the process env", () => {
    const before = process.env.META_API_KEY;
    const env = serveEnv("  test-key-1  ");
    assert.ok(env);
    assert.equal(env.META_API_KEY, "test-key-1");
    assert.notEqual(env, process.env);
    for (const key of Object.keys(process.env)) {
      if (key !== "META_API_KEY") {
        assert.equal(env[key], process.env[key]);
      }
    }
    assert.equal(process.env.META_API_KEY, before);
  });
});

describe("turn lock", () => {
  it("refuses a send while another tab holds the lock, emitting nothing", async () => {
    const fake = fakeCommands({ hostOptions: { turnOwner: "tab-a" } });
    assert.equal(acquireTurn("tab-b"), true);
    try {
      await assert.rejects(fake.host.send("hi", process.cwd()), TurnBusyError);
    } finally {
      releaseTurn("tab-b");
    }
    assert.deepEqual(fake.events, []);
    await fake.host.dispose();
  });

  it("releases the lock when the turn ends", async () => {
    const fake = fakeCommands({ hostOptions: { turnOwner: "tab-a" } });
    await fake.host.send("hi", process.cwd());
    assert.equal(lockHolder(), undefined);
    assert.equal(acquireTurn("tab-b"), true);
    releaseTurn("tab-b");
    await fake.host.dispose();
  });

  it("lets a side question run while a main turn holds the lock", async () => {
    const fake = fakeCommands({
      commands: { "session/sideChat": { session: { sessionId: "side-1" } } },
      sessions: {
        "side-1": {
          sessionId: "side-1",
          sendUserTurn: async () =>
            cannedTurn([
              { kind: "agentMessage", itemId: "a1", revision: 1, status: "completed", text: "Side." },
            ]),
          onApproval: () => undefined,
          onApprovalError: () => undefined,
          fold: { items: { list: () => [] } },
        },
      },
    });
    assert.equal(acquireTurn("tab-b"), true);
    try {
      assert.equal(await fake.host.sideAsk(process.cwd(), "Why?"), "Side.");
    } finally {
      releaseTurn("tab-b");
    }
    await fake.host.dispose();
  });
});

describe("turn lock logging", () => {
  it("logs each acquire and release with the tab id", async () => {
    const fake = fakeCommands({ hostOptions: { turnOwner: "tab-b" } });
    await fake.host.send("hello", process.cwd());
    await fake.host.dispose();
    assert.ok(
      fake.logs.some((line) => line.includes("tab-b") && /acquir/i.test(line)),
      `no acquire line for tab-b in: ${fake.logs.join(" | ")}`,
    );
    assert.ok(
      fake.logs.some((line) => line.includes("tab-b") && /releas/i.test(line)),
      `no release line for tab-b in: ${fake.logs.join(" | ")}`,
    );
  });

  it("logs a lost lock race with both tab ids", async () => {
    const fake = fakeCommands({ hostOptions: { turnOwner: "tab-b" } });
    assert.equal(acquireTurn("main"), true);
    try {
      await assert.rejects(fake.host.send("hello", process.cwd()), TurnBusyError);
    } finally {
      releaseTurn("main");
    }
    await fake.host.dispose();
    assert.ok(
      fake.logs.some((line) => line.includes("tab-b") && line.includes("main")),
      `no busy line naming both tabs in: ${fake.logs.join(" | ")}`,
    );
  });
});

describe("prompt mode", () => {
  const SAFE_LINE = "I couldn't make Muse ask before running commands, so I've stopped to be safe.";

  it("confirms promptUnmatched once after opening, then runs the turn", async () => {
    const fake = fakeCommands({
      commands: {
        "session/setApprovalMode": {
          status: "accepted",
          commandId: "cmd-1",
          effectiveMode: { mode: "promptUnmatched", source: "approvalReconfigure", lastCommandId: "cmd-1" },
        },
      },
      hostOptions: { sandboxWorkaround: true, platform: "win32" },
    });
    await fake.host.send("run node --version", process.cwd());
    assert.deepEqual(
      fake.commands.filter((entry) => entry.method === "session/setApprovalMode"),
      [{ method: "session/setApprovalMode", params: { sessionId: "session-1", mode: "promptUnmatched" } }],
    );
    assert.ok(fake.events.some((event) => event.type === "status" && event.text === "Muse is thinking…"));
    assert.ok(fake.events.some((event) => event.type === "turn" && event.state === "done"));
    assert.ok(fake.events.some((event) => event.type === "status" && event.text === "Ready"));
    await fake.host.dispose();
  });

  it("blocks the turn when setApprovalMode fails", async () => {
    const fake = fakeCommands({
      failCommands: ["session/setApprovalMode"],
      hostOptions: { sandboxWorkaround: true, platform: "win32" },
    });
    await fake.host.send("run node --version", process.cwd());
    assert.ok(fake.events.some((event) => event.type === "notice" && event.text === SAFE_LINE));
    assert.ok(!fake.events.some((event) => event.type === "status" && event.text === "Muse is thinking…"));
    assert.ok(fake.events.some((event) => event.type === "turn" && event.state === "done"));
    assert.ok(fake.events.some((event) => event.type === "status" && event.text === "Ready"));
    assert.ok(fake.logs.some((line) => line.startsWith("approval mode: setApprovalMode failed")));
    await fake.host.dispose();
  });

  it("blocks the turn when the server confirms another mode", async () => {
    const fake = fakeCommands({
      commands: {
        "session/setApprovalMode": {
          status: "accepted",
          commandId: "cmd-1",
          effectiveMode: { mode: "onRequest", source: "startup", lastCommandId: null },
        },
      },
      hostOptions: { sandboxWorkaround: true, platform: "win32" },
    });
    await fake.host.send("run node --version", process.cwd());
    assert.ok(fake.events.some((event) => event.type === "notice" && event.text === SAFE_LINE));
    assert.ok(!fake.events.some((event) => event.type === "status" && event.text === "Muse is thinking…"));
    assert.ok(fake.events.some((event) => event.type === "turn" && event.state === "done"));
    assert.ok(fake.events.some((event) => event.type === "status" && event.text === "Ready"));
    assert.ok(fake.logs.some((line) => line.includes("expected promptUnmatched, got onRequest")));
    await fake.host.dispose();
  });

  it("sends no setApprovalMode when the workaround is off or off Windows", async () => {
    const off = fakeCommands({ hostOptions: { sandboxWorkaround: false, platform: "win32" } });
    await off.host.send("hi", process.cwd());
    assert.ok(off.commands.every((entry) => entry.method !== "session/setApprovalMode"));
    await off.host.dispose();
    const mac = fakeCommands({ hostOptions: { sandboxWorkaround: true, platform: "darwin" } });
    await mac.host.send("hi", process.cwd());
    assert.ok(mac.commands.every((entry) => entry.method !== "session/setApprovalMode"));
    await mac.host.dispose();
  });
});

const SHELL_COMMAND = "New-Item mb-probe-dir; Remove-Item mb-probe-dir; Write-Output sandbox-ok";

const SHELL_CHOICES = [
  { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
  {
    choiceId: "allow_local_prefix",
    decision: "approvedPolicyAmendment",
    label: "Always allow in this workspace: New-Item ...",
    scope: "localPersistent",
  },
  { choiceId: "abort", decision: "abort", label: "Reject", scope: "once", acceptsFeedback: true },
];

/** Recorded shape: shell stages, Muse's own three choices, at one step. */
function shellRequest(
  sourceIndex = 1,
  options?: {
    approvalId?: string;
    command?: string;
    stages?: string[][];
    choices?: typeof SHELL_CHOICES;
  },
): ApprovalRequestParams {
  const argvList = options?.stages ?? [
    ["New-Item", "mb-probe-dir"],
    ["Remove-Item", "mb-probe-dir"],
    ["Write-Output", "sandbox-ok"],
  ];
  const approvalId = options?.approvalId ?? "appr-1";
  return {
    approvalId,
    availableChoices: options?.choices ?? SHELL_CHOICES,
    currentRequirementId: { approvalId, sourceIndex },
    subject: {
      kind: "shell",
      command: options?.command ?? SHELL_COMMAND,
      stages: argvList.map((argv, index) => ({ argv, position: index + 1, totalStages: argvList.length })),
    },
    toolName: "bash",
    rawArgs: "{}",
  } as unknown as ApprovalRequestParams;
}

function toolRowTexts(events: MuseHostEvent[]): string[] {
  return events.filter((event) => event.type === "tool").map((event) => event.text);
}

describe("approval picker", () => {
  it("picks a shell request with its title, stages, labels and hints", async () => {
    const fake = fakeApprovalHost({ choiceId: "abort", feedback: "use mkdir instead" });
    await fake.host.prepare(process.cwd());
    assert.deepEqual(await fake.decide(shellRequest()), { choiceId: "abort", feedback: "use mkdir instead" });
    assert.equal(fake.pickers.length, 1);
    const picker = fake.pickers[0];
    assert.equal(picker?.type, "picker");
    assert.equal(picker?.kind, "shell");
    assert.equal(picker?.title, "Delete mb-probe-dir?");
    assert.equal(picker?.detail, SHELL_COMMAND);
    assert.deepEqual(picker?.stages, [
      "New-Item mb-probe-dir",
      "Remove-Item mb-probe-dir",
      "Write-Output sandbox-ok",
    ]);
    assert.deepEqual(
      picker?.choices.map((choice) => choice.label),
      ["Allow once", "Always allow in this workspace: New-Item ...", "Reject"],
    );
    assert.equal(
      picker?.choices[1]?.hint,
      "Muse won't ask again for commands starting with this, in this project only.",
    );
    assert.equal(picker?.choices[0]?.hint, undefined);
    assert.equal(picker?.choices[2]?.isReject, true);
    assert.equal(picker?.choices[0]?.isReject, false);
    assert.ok(fake.events.some((event) => event.type === "approvalDone" && event.id === "appr-1"));
    assert.ok(
      toolRowTexts(fake.events).includes("✗ Rejected: delete mb-probe-dir, told Muse: use mkdir instead"),
    );
    await fake.host.dispose();
  });

  it("drops feedback for a choice that doesn't take it", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once", feedback: "whatever" });
    await fake.host.prepare(process.cwd());
    assert.deepEqual(await fake.decide(shellRequest()), { choiceId: "allow_once" });
    await fake.host.dispose();
  });

  it("falls back to the safest choice when the panel can't ask", async () => {
    const fake = fakeApprovalHost(undefined);
    await fake.host.prepare(process.cwd());
    assert.deepEqual(await fake.decide(shellRequest()), { choiceId: "abort" });
    assert.ok(toolRowTexts(fake.events).includes("✗ Rejected: delete mb-probe-dir"));
    await fake.host.dispose();
  });

  it("asks once per command and answers every stage from memory", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" });
    await fake.host.prepare(process.cwd());
    const stages = [
      ["Remove-Item", "a.txt"],
      ["Remove-Item", "b.txt"],
    ];
    assert.deepEqual(
      await fake.decide(shellRequest(0, { approvalId: "cmd-1", stages })),
      { choiceId: "allow_once" },
    );
    assert.equal(fake.pickers.length, 1);
    assert.deepEqual(
      await fake.decide(shellRequest(1, { approvalId: "cmd-1", stages })),
      { choiceId: "allow_once" },
    );
    assert.equal(fake.pickers.length, 1);
    assert.deepEqual(
      toolRowTexts(fake.events).filter((text) => text.startsWith("✓ Allowed once")),
      ["✓ Allowed once: delete a.txt"],
    );
    await fake.host.dispose();
  });

  it("applies each stage's own always-allow choice", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_local_prefix" });
    await fake.host.prepare(process.cwd());
    const stages = [
      ["New-Item", "-ItemType", "File", "a.txt"],
      ["Remove-Item", "a.txt"],
    ];
    assert.deepEqual(await fake.decide(shellRequest(0, { approvalId: "cmd-2", stages })), {
      choiceId: "allow_local_prefix",
    });
    const later = SHELL_CHOICES.map((choice) =>
      choice.choiceId === "allow_local_prefix"
        ? { ...choice, choiceId: "allow_local_prefix_rm", label: "Always allow in this workspace: Remove-Item" }
        : choice,
    );
    assert.deepEqual(await fake.decide(shellRequest(1, { approvalId: "cmd-2", stages, choices: later })), {
      choiceId: "allow_local_prefix_rm",
    });
    assert.equal(fake.pickers.length, 1);
    assert.ok(toolRowTexts(fake.events).includes("✓ Always allowed here: New-Item"));
    await fake.host.dispose();
  });

  it("auto-allows read-only stages with one quiet row", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" });
    await fake.host.prepare(process.cwd());
    const stages = [["Get-ChildItem"], ["Select-Object", "Name"], ["Remove-Item", "todo.txt"]];
    assert.deepEqual(await fake.decide(shellRequest(0, { approvalId: "cmd-3", stages })), {
      choiceId: "allow_once",
    });
    assert.deepEqual(await fake.decide(shellRequest(1, { approvalId: "cmd-3", stages })), {
      choiceId: "allow_once",
    });
    assert.equal(fake.pickers.length, 0);
    await fake.decide(shellRequest(2, { approvalId: "cmd-3", stages }));
    assert.equal(fake.pickers.length, 1);
    assert.ok(toolRowTexts(fake.events).includes("✓ Looked at: Get-ChildItem, Select-Object"));
    await fake.host.dispose();
  });

  it("flushes quiet rows when the turn ends", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" });
    await fake.host.prepare(process.cwd());
    await fake.decide(shellRequest(0, { approvalId: "cmd-4", stages: [["node", "--version"]] }));
    assert.equal(fake.pickers.length, 0);
    await fake.host.send("run node --version", process.cwd());
    assert.ok(toolRowTexts(fake.events).includes("✓ Looked at: node --version"));
    await fake.host.dispose();
  });

  it("auto-allows rule-9 backups, quietly for mkdir", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" });
    await fake.host.prepare(process.cwd());
    const stages = [
      ["New-Item", "-ItemType", "Directory", ".backups/today"],
      ["Copy-Item", "todo.txt", ".backups/today/todo.txt"],
      ["Remove-Item", "todo.txt"],
    ];
    await fake.decide(shellRequest(0, { approvalId: "cmd-5", stages }));
    await fake.decide(shellRequest(1, { approvalId: "cmd-5", stages }));
    assert.equal(fake.pickers.length, 0);
    await fake.decide(shellRequest(2, { approvalId: "cmd-5", stages }));
    assert.equal(fake.pickers.length, 1);
    const rows = toolRowTexts(fake.events);
    assert.ok(rows.includes("✓ Backed up todo.txt"));
    assert.ok(rows.includes("✓ Allowed once: delete todo.txt"));
    assert.ok(rows.indexOf("✓ Backed up todo.txt") < rows.indexOf("✓ Allowed once: delete todo.txt"));
    await fake.host.dispose();
  });

  it("asks when a copy leaves the backup rules", async () => {
    const fake = fakeApprovalHost({ choiceId: "abort" });
    await fake.host.prepare(process.cwd());
    await fake.decide(
      shellRequest(0, { approvalId: "cmd-6", stages: [["Copy-Item", "todo.txt", "elsewhere/todo.txt"]] }),
    );
    assert.equal(fake.pickers.length, 1);
    await fake.host.dispose();
  });

  it("asks when the full command redirects, though the stage looks clean", async () => {
    const fake = fakeApprovalHost({ choiceId: "abort" });
    await fake.host.prepare(process.cwd());
    await fake.decide(
      shellRequest(0, {
        approvalId: "cmd-7",
        command: "Write-Output hello > mb-probe.txt",
        stages: [["Write-Output", "hello"]],
      }),
    );
    assert.equal(fake.pickers.length, 1);
    await fake.host.dispose();
  });

  it("asks for variable reads but auto-allows plain workspace reads", async () => {
    const fake = fakeApprovalHost({ choiceId: "abort" });
    await fake.host.prepare(process.cwd());
    await fake.decide(
      shellRequest(0, {
        approvalId: "cmd-8",
        command: "Get-Content $HOME\\.gitconfig",
        stages: [["Get-Content", "$HOME", "\\.gitconfig"]],
      }),
    );
    assert.equal(fake.pickers.length, 1);
    await fake.decide(
      shellRequest(0, {
        approvalId: "cmd-9",
        command: "Get-Content notes.txt",
        stages: [["Get-Content", "notes.txt"]],
      }),
    );
    assert.equal(fake.pickers.length, 1);
    await fake.host.send("hi", process.cwd());
    assert.ok(toolRowTexts(fake.events).includes("✓ Looked at: Get-Content"));
    await fake.host.dispose();
  });
});

describe("approval auto mode", () => {
  it("auto-answers passing stages with auto-allowed rows", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" }, { approvalMode: "auto" });
    await fake.host.prepare(process.cwd());
    assert.deepEqual(
      await fake.decide(
        shellRequest(0, { approvalId: "auto-1", command: "npm test", stages: [["npm", "test"]] }),
      ),
      { choiceId: "allow_once" },
    );
    assert.equal(fake.pickers.length, 0);
    const rows = fake.events.filter(
      (event): event is Extract<MuseHostEvent, { type: "tool" }> => event.type === "tool",
    );
    assert.deepEqual(
      rows.map((row) => row.text),
      ["✓ auto-allowed: run npm test"],
    );
    assert.equal(rows[0]?.group, "command");
    await fake.host.dispose();
  });

  it("asks when any stage fails the Auto rules", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" }, { approvalMode: "auto" });
    await fake.host.prepare(process.cwd());
    await fake.decide(
      shellRequest(0, { approvalId: "auto-2", command: "git push", stages: [["git", "push"]] }),
    );
    assert.equal(fake.pickers.length, 1);
    assert.ok(!toolRowTexts(fake.events).some((text) => text.startsWith("✓ auto-allowed")));
    await fake.host.dispose();
  });

  it("checks every stage, with read-only riding quietly", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" }, { approvalMode: "auto" });
    await fake.host.prepare(process.cwd());
    const stages = [
      ["Get-ChildItem"],
      ["npm", "test"],
    ];
    assert.deepEqual(
      await fake.decide(shellRequest(0, { approvalId: "auto-3", stages })),
      { choiceId: "allow_once" },
    );
    assert.deepEqual(
      await fake.decide(shellRequest(1, { approvalId: "auto-3", stages })),
      { choiceId: "allow_once" },
    );
    assert.equal(fake.pickers.length, 0);
    await fake.host.send("hi", process.cwd());
    assert.ok(toolRowTexts(fake.events).includes("✓ Looked at: Get-ChildItem"));
    assert.ok(toolRowTexts(fake.events).includes("✓ auto-allowed: run npm test"));
    await fake.host.dispose();
  });

  it("auto-allows file changes inside the workspace", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" }, { approvalMode: "auto" });
    await fake.host.prepare(process.cwd());
    const request = {
      approvalId: "auto-4",
      availableChoices: SHELL_CHOICES,
      currentRequirementId: { approvalId: "auto-4", sourceIndex: 0 },
      subject: { kind: "fileAccess", access: "write", path: "todo.txt" },
      toolName: "edit",
      rawArgs: "{}",
    } as unknown as ApprovalRequestParams;
    assert.deepEqual(await fake.decide(request), { choiceId: "allow_once" });
    assert.equal(fake.pickers.length, 0);
    assert.ok(toolRowTexts(fake.events).includes("✓ auto-allowed: change todo.txt"));
    await fake.host.dispose();
  });

  it("stays quiet in Ask mode for the same stages", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" });
    await fake.host.prepare(process.cwd());
    await fake.decide(
      shellRequest(0, { approvalId: "ask-1", command: "npm test", stages: [["npm", "test"]] }),
    );
    assert.equal(fake.pickers.length, 1);
    assert.ok(!toolRowTexts(fake.events).some((text) => text.startsWith("✓ auto-allowed")));
    await fake.host.dispose();
  });

  it("rides throwaway redirects quietly, without a picker", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" }, { approvalMode: "auto" });
    await fake.host.prepare(process.cwd());
    assert.deepEqual(
      await fake.decide(
        shellRequest(0, {
          approvalId: "auto-null",
          command: "Get-ChildItem brain 2>$null",
          stages: [["Get-ChildItem", "brain"]],
        }),
      ),
      { choiceId: "allow_once" },
    );
    assert.deepEqual(
      await fake.decide(
        shellRequest(1, {
          approvalId: "auto-null",
          command: "Get-ChildItem brain | Out-Null",
          stages: [["Get-ChildItem", "brain"], ["Out-Null"]],
        }),
      ),
      { choiceId: "allow_once" },
    );
    assert.equal(fake.pickers.length, 0);
    await fake.host.send("hi", process.cwd());
    assert.ok(toolRowTexts(fake.events).includes("✓ Looked at: Get-ChildItem"));
    assert.ok(!toolRowTexts(fake.events).some((text) => text.includes("Out-Null")));
    await fake.host.dispose();
  });

  it("passes sink stages quietly in Ask mode too", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" });
    await fake.host.prepare(process.cwd());
    const options = {
      approvalId: "ask-null",
      command: "Get-ChildItem brain | Out-Null",
      stages: [["Get-ChildItem", "brain"], ["Out-Null"]],
    };
    assert.deepEqual(await fake.decide(shellRequest(0, options)), { choiceId: "allow_once" });
    assert.deepEqual(await fake.decide(shellRequest(1, options)), { choiceId: "allow_once" });
    assert.equal(fake.pickers.length, 0);
    await fake.host.send("hi", process.cwd());
    assert.ok(toolRowTexts(fake.events).includes("✓ Looked at: Get-ChildItem"));
    await fake.host.dispose();
  });
});

describe("approval allow-all", () => {
  it("selects allowAll and checks it was confirmed", async () => {
    const fake = fakeCommands({
      commands: { "session/setApprovalMode": { effectiveMode: { mode: "allowAll" } } },
    });
    await fake.host.setApprovalAll(process.cwd());
    assert.deepEqual(fake.commands.at(-1), {
      method: "session/setApprovalMode",
      params: { sessionId: "session-1", mode: "allowAll" },
    });
    await fake.host.dispose();
  });

  it("refuses when the server doesn't confirm", async () => {
    const fake = fakeCommands({});
    await assert.rejects(() => fake.host.setApprovalAll(process.cwd()), /didn't take it/);
    await fake.host.dispose();
  });

  it("reverts to promptUnmatched and checks that too", async () => {
    const fake = fakeCommands({
      commands: { "session/setApprovalMode": { effectiveMode: { mode: "promptUnmatched" } } },
    });
    await fake.host.clearApprovalAll(process.cwd());
    assert.deepEqual(fake.commands.at(-1), {
      method: "session/setApprovalMode",
      params: { sessionId: "session-1", mode: "promptUnmatched" },
    });
    await fake.host.dispose();
  });

  it("reverts a leftover allowAll when the session resumes", async () => {
    let reverted = 0;
    const fake = fakeCommands({
      commands: { "session/setApprovalMode": { effectiveMode: { mode: "promptUnmatched" } } },
      sessions: {
        "session-9": {
          sessionId: "session-9",
          sendUserTurn: async () => cannedTurn([]),
          onApproval: () => undefined,
          onApprovalError: () => undefined,
          fold: { items: { list: () => [] } },
        },
      },
      hostOptions: {
        approvalAllLeftOn: "session-9",
        onApprovalAllReverted: () => {
          reverted += 1;
        },
        sessionStore: { loadId: () => "session-9", saveId: () => undefined, clear: () => undefined },
      },
    });
    await fake.host.prepare(process.cwd());
    assert.ok(
      fake.commands.some(
        (command) =>
          command.method === "session/setApprovalMode" &&
          (command.params as { mode?: string }).mode === "promptUnmatched",
      ),
    );
    assert.equal(reverted, 1);
    await fake.host.dispose();
  });
});

function fileRequest(
  approvalId: string,
  subject: { kind: string; access?: string; path?: string },
): ApprovalRequestParams {
  return {
    approvalId,
    availableChoices: SHELL_CHOICES,
    currentRequirementId: { approvalId, sourceIndex: 0 },
    subject,
    toolName: "read",
    rawArgs: "{}",
  } as unknown as ApprovalRequestParams;
}

describe("free reads", () => {
  it("auto-answers inside file reads in Ask mode, quietly", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" });
    await fake.host.prepare(process.cwd());
    assert.deepEqual(
      await fake.decide(
        fileRequest("read-1", { kind: "fileAccess", access: "read", path: "brain/me.md" }),
      ),
      { choiceId: "allow_once" },
    );
    assert.equal(fake.pickers.length, 0);
    await fake.host.send("hi", process.cwd());
    assert.ok(toolRowTexts(fake.events).includes("✓ Looked at: brain/me.md"));
    await fake.host.dispose();
  });

  it("still asks for outside reads and inside writes in Ask mode", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" });
    await fake.host.prepare(process.cwd());
    assert.deepEqual(
      await fake.decide(
        fileRequest("read-2", { kind: "fileAccess", access: "read", path: "..\\outside.txt" }),
      ),
      { choiceId: "allow_once" },
    );
    assert.deepEqual(
      await fake.decide(
        fileRequest("read-3", { kind: "fileAccess", access: "write", path: "todo.txt" }),
      ),
      { choiceId: "allow_once" },
    );
    assert.equal(fake.pickers.length, 2);
    await fake.host.dispose();
  });

  it("auto-answers inside file reads in Auto mode too", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" }, { approvalMode: "auto" });
    await fake.host.prepare(process.cwd());
    assert.deepEqual(
      await fake.decide(
        fileRequest("read-4", { kind: "fileAccess", access: "read", path: "brain/me.md" }),
      ),
      { choiceId: "allow_once" },
    );
    assert.equal(fake.pickers.length, 0);
    await fake.host.send("hi", process.cwd());
    assert.ok(toolRowTexts(fake.events).includes("✓ Looked at: brain/me.md"));
    await fake.host.dispose();
  });

  it("still asks for outside reads in Auto mode", async () => {
    const fake = fakeApprovalHost({ choiceId: "allow_once" }, { approvalMode: "auto" });
    await fake.host.prepare(process.cwd());
    assert.deepEqual(
      await fake.decide(
        fileRequest("read-5", { kind: "fileAccess", access: "read", path: "..\\outside.txt" }),
      ),
      { choiceId: "allow_once" },
    );
    assert.equal(fake.pickers.length, 1);
    await fake.host.dispose();
  });

  it("auto-answers everything in All mode, even outside reads", async () => {
    const fake = fakeApprovalHost(
      { choiceId: "allow_once" },
      { commands: { "session/setApprovalMode": { effectiveMode: { mode: "allowAll" } } } },
    );
    await fake.host.prepare(process.cwd());
    await fake.host.setApprovalAll(process.cwd());
    assert.deepEqual(
      await fake.decide(
        fileRequest("read-6", { kind: "fileAccess", access: "read", path: "..\\outside.txt" }),
      ),
      { choiceId: "allow_once" },
    );
    assert.equal(fake.pickers.length, 0);
    await fake.host.dispose();
  });
});

interface ApprovalFake {
  host: MuseHost;
  events: MuseHostEvent[];
  pickers: PickerEvent[];
  decide: (request: ApprovalRequestParams) => Promise<ApprovalAnswer>;
}

/** Captures the registered approval handler plus the picker it builds. */
function fakeApprovalHost(
  answer: ApprovalAnswer | undefined,
  options?: { approvalMode?: "ask" | "auto"; commands?: Record<string, unknown> },
): ApprovalFake {
  const events: MuseHostEvent[] = [];
  const pickers: PickerEvent[] = [];
  let handler: ((request: ApprovalRequestParams) => Promise<ApprovalAnswer>) | undefined;
  const session: HostSession = {
    sessionId: "session-1",
    sendUserTurn: async () => cannedTurn([]),
    onApproval: (candidate) => {
      handler = candidate as (request: ApprovalRequestParams) => Promise<ApprovalAnswer>;
    },
    onApprovalError: () => undefined,
    fold: { items: { list: () => [] } },
  };
  const client: HostClient = {
    startSession: async () => session,
    resumeSession: async () => session,
    close: async () => undefined,
  };
  const connection: HostConnection = {
    command: async (method): Promise<Record<string, unknown>> =>
      (options?.commands?.[method] ?? {}) as Record<string, unknown>,
    request: async () => ({}),
    onNotification: () => undefined,
  };
  return {
    host: new MuseHost({
      museBin: "unused",
      version: "0.0.1",
      trustWorkspace: false,
      ...(options?.approvalMode ? { approvalMode: options.approvalMode } : {}),
      emit: (event) => {
        events.push(event);
      },
      askApproval: (picker) => {
        pickers.push(picker);
        return Promise.resolve(answer);
      },
      createHost: async () => ({ client, connection }),
    }),
    events,
    pickers,
    decide: (request) => {
      if (!handler) {
        throw new Error("no approval handler registered");
      }
      return handler(request);
    },
  };
}

describe("prepare status", () => {
  it("says Ready once the host is up", async () => {
    const fake = fakeCommands({});
    await fake.host.prepare(process.cwd());
    const statuses = fake.events.filter((event) => event.type === "status");
    assert.equal(statuses.at(-1)?.text, "Ready");
    await fake.host.dispose();
  });
});

describe("slash notifications", () => {
  it("routes usage, goal, model and effort to events", async () => {
    const fake = fakeCommands({});
    await fake.host.prepare(process.cwd());
    fake.emit({
      method: "session/tokenUsage",
      params: {
        sessionId: "session-1",
        cumulative: {
          promptTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cost: { usd: 0.02, partial: true },
        },
      },
    });
    fake.emit({ method: "session/tokenUsage", params: { sessionId: "other", cumulative: {} } });
    fake.emit({
      method: "session/goalChanged",
      params: {
        sessionId: "session-1",
        goal: { objective: "Ship it", percentComplete: 45, status: "active", currentWork: "Tests" },
      },
    });
    fake.emit({ method: "session/modelChanged", params: { sessionId: "session-1", modelId: "m-2" } });
    fake.emit({
      method: "session/reasoningEffortChanged",
      params: { sessionId: "session-1", reasoningEffort: "high" },
    });
    fake.emit({
      method: "session/reasoningEffortChanged",
      params: { sessionId: "session-1", reasoningEffort: "bogus" },
    });
    assert.deepEqual(
      fake.events.filter((event) => event.type === "usage"),
      [
        {
          type: "usage",
          usage: { promptTokens: 100, outputTokens: 50, totalTokens: 150, usd: 0.02, partial: true },
        },
      ],
    );
    assert.deepEqual(
      fake.events.filter((event) => event.type === "goal"),
      [
        {
          type: "goal",
          goal: { objective: "Ship it", percentComplete: 45, status: "active", currentWork: "Tests" },
        },
      ],
    );
    assert.deepEqual(
      fake.events.filter((event) => event.type === "model" || event.type === "effort"),
      [
        { type: "model", modelId: "m-2" },
        { type: "effort", level: "deep" },
      ],
    );
    await fake.host.dispose();
  });

  it("clears the goal on null, ignores malformed payloads", async () => {
    const fake = fakeCommands({});
    await fake.host.prepare(process.cwd());
    fake.emit({ method: "session/goalChanged", params: { sessionId: "session-1", goal: null } });
    fake.emit({ method: "session/goalChanged", params: { sessionId: "session-1", goal: { nope: true } } });
    fake.emit({ method: "session/goalChanged", params: { sessionId: "session-1" } });
    assert.deepEqual(
      fake.events.filter((event) => event.type === "goal"),
      [{ type: "goal", goal: null }],
    );
    await fake.host.dispose();
  });

  it("recaps through recap/completed, matched by command id", async () => {
    const fake = fakeCommands({ commands: { "recap/request": { commandId: "cmd-9", status: "accepted" } } });
    const pending = fake.host.recap(process.cwd());
    await new Promise((resolve) => setImmediate(resolve));
    fake.emit({ method: "recap/completed", params: { commandId: "cmd-other", outcome: "completed", text: "Wrong" } });
    fake.emit({
      method: "recap/completed",
      params: { commandId: "cmd-9", outcome: "completed", text: "We shipped.", title: "Shipped" },
    });
    assert.deepEqual(await pending, { text: "We shipped.", title: "Shipped" });
    await fake.host.dispose();
  });

  it("fails a recap plainly when the side-call fails", async () => {
    const fake = fakeCommands({ commands: { "recap/request": { commandId: "cmd-9", status: "accepted" } } });
    const pending = fake.host.recap(process.cwd());
    await new Promise((resolve) => setImmediate(resolve));
    fake.emit({ method: "recap/completed", params: { commandId: "cmd-9", outcome: "failed" } });
    await assert.rejects(pending, /didn't come back/);
    await fake.host.dispose();
  });
});

describe("slash commands", () => {
  it("lists sessions, models, tasks, skills and plugins defensively", async () => {
    const fake = fakeCommands({
      requests: {
        "session/list": {
          sessions: [
            { sessionId: "session-1", name: "Live one", updatedAt: "2026-10-30T09:00:00Z", turnCount: 5 },
            { sessionId: "s2", name: "Old one", updatedAt: "2026-10-29T09:00:00Z", turnCount: 12 },
            { nope: true },
          ],
        },
        "model/list": {
          models: [
            { modelId: "m-1", displayLabel: "Spark", isActive: true },
            { nope: true },
          ],
        },
        "task/list": {
          tasks: [
            { taskId: "t1", tool: "npm test", executionMode: "background", startedAt: "2026-10-30T09:00:00Z" },
            { taskId: "t2", kind: "workflow" },
          ],
        },
        "skill/list": { skills: [{ selector: "fix-bug", displayName: "Fix bug", description: "Fixes." }] },
        "plugin/list": { plugins: [{ id: "acme", version: "1.2", enabled: true }] },
        "usage/read": {
          usage: {
            weekly: { usedPercent: 45, resetsAtMs: 456 },
            window: { usedPercent: 12, resetsAtMs: 123 },
          },
        },
      },
    });
    assert.deepEqual(await fake.host.listSessions(process.cwd()), [
      { id: "s2", name: "Old one", updatedAt: "2026-10-29T09:00:00Z", turnCount: 12 },
    ]);
    assert.deepEqual(await fake.host.listModels(process.cwd()), [
      { modelId: "m-1", label: "Spark", active: true },
    ]);
    const tasks = await fake.host.listTasks(process.cwd());
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]?.label, "npm test");
    assert.ok((tasks[0]?.detail ?? "").startsWith("background"));
    assert.equal(tasks[1]?.label, "workflow");
    assert.deepEqual(await fake.host.listSkills(process.cwd()), [
      { selector: "fix-bug", name: "Fix bug", description: "Fixes." },
    ]);
    assert.deepEqual(await fake.host.listPlugins(process.cwd()), [{ id: "acme", version: "1.2", enabled: true }]);
    assert.deepEqual(await fake.host.readSubscription(process.cwd()), {
      weekly: { usedPercent: 45, resetsAtMs: 456 },
      window: { usedPercent: 12, resetsAtMs: 123 },
    });
    assert.deepEqual(
      fake.requests.map((entry) => entry.method),
      ["session/list", "model/list", "task/list", "skill/list", "plugin/list", "usage/read"],
    );
    await fake.host.dispose();
  });

  it("sends set, stop and install commands with the right shape", async () => {
    const fake = fakeCommands({
      commands: {
        "session/compact": { status: "noop" },
        "plugin/install": { status: "accepted", id: "acme", version: "1.2" },
      },
    });
    await fake.host.setModel(process.cwd(), "m-2");
    assert.deepEqual(fake.commands.at(-1), {
      method: "session/setModel",
      params: { sessionId: "session-1", model: { modelId: "m-2" } },
    });
    assert.equal(await fake.host.compact(process.cwd()), "noop");
    await fake.host.goalCommand(process.cwd(), "set", "Ship it");
    assert.deepEqual(fake.commands.at(-1), {
      method: "goal/set",
      params: { sessionId: "session-1", objective: "Ship it" },
    });
    await fake.host.goalCommand(process.cwd(), "pause");
    assert.deepEqual(fake.commands.at(-1)?.params, { sessionId: "session-1" });
    await fake.host.stopTask(process.cwd(), "t1");
    await fake.host.stopAllTasks(process.cwd());
    await fake.host.setSkill(process.cwd(), "fix-bug", false);
    assert.deepEqual(fake.commands.at(-1), {
      method: "skill/setActivation",
      params: { sessionId: "session-1", selector: "fix-bug", scope: "project", activation: "off" },
    });
    assert.deepEqual(await fake.host.installPlugin(process.cwd(), { marketplace: "acme", name: "deploy" }), {
      id: "acme",
      version: "1.2",
    });
    await fake.host.setEffort(process.cwd(), "deep");
    assert.deepEqual(fake.commands.at(-1), {
      method: "session/setReasoningEffort",
      params: { sessionId: "session-1", reasoningEffort: "high" },
    });
    await fake.host.dispose();
  });

  it("asks a side question without touching the main chat", async () => {
    const fake = fakeCommands({
      commands: { "session/sideChat": { session: { sessionId: "side-1" } } },
      sessions: {
        "side-1": {
          sessionId: "side-1",
          sendUserTurn: async () =>
            cannedTurn([
              { kind: "agentMessage", itemId: "a1", revision: 1, status: "completed", text: "First." },
              { kind: "agentMessage", itemId: "a2", revision: 2, status: "completed", text: "Second." },
            ]),
          onApproval: () => undefined,
          onApprovalError: () => undefined,
          fold: { items: { list: () => [] } },
        },
      },
    });
    assert.equal(await fake.host.sideAsk(process.cwd(), "Why?"), "First.\n\nSecond.");
    assert.ok(
      fake.events.every(
        (event) => event.type !== "assistant" && event.type !== "user",
      ),
    );
    await fake.host.dispose();
  });

  it("logs each side step and reports progress", async () => {
    const fake = fakeCommands({
      commands: { "session/sideChat": { session: { sessionId: "side-1" } } },
      sessions: {
        "side-1": {
          sessionId: "side-1",
          sendUserTurn: async () =>
            cannedTurn([
              { kind: "reasoning", itemId: "r1", revision: 1, status: "completed", text: "hmm" },
              { kind: "agentMessage", itemId: "a1", revision: 1, status: "completed", text: "Done." },
            ]),
          onApproval: () => undefined,
          onApprovalError: () => undefined,
          fold: { items: { list: () => [] } },
        },
      },
    });
    const progress: string[] = [];
    assert.equal(await fake.host.sideAsk(process.cwd(), "Why?", (line) => progress.push(line)), "Done.");
    assert.deepEqual(progress, ["Chat opened", "Asking…", "Reading the answer…"]);
    assert.ok(fake.logs.some((line) => line.startsWith("side: opened side-1")));
    assert.ok(fake.logs.some((line) => line.startsWith("side: resumed")));
    assert.ok(fake.logs.some((line) => line.startsWith("side: turn turn-1 sent")));
    assert.ok(fake.logs.includes("side: first reasoning"));
    assert.ok(fake.logs.includes("side: first agentMessage"));
    assert.ok(fake.logs.includes("side: terminal completed"));
    await fake.host.dispose();
  });

  it("forks and switches sessions", async () => {
    const fake = fakeCommands({
      commands: { "session/fork": { session: { sessionId: "fork-1" } } },
      sessions: {
        "target-1": historySession("target-1", [
          { kind: "userMessage", itemId: "u1", revision: 1, status: "completed", text: "old question" },
          { kind: "agentMessage", itemId: "a1", revision: 2, status: "completed", text: "old answer" },
        ]),
      },
    });
    assert.equal(await fake.host.forkSession(process.cwd()), "fork-1");
    assert.equal(await fake.host.switchSession("target-1", process.cwd()), 2);
    assert.deepEqual(
      fake.events.filter((event) => event.type === "user" || event.type === "assistant"),
      [
        { type: "user", text: "old question" },
        { type: "assistant", id: "a1", text: "old answer" },
      ],
    );
    await fake.host.dispose();
  });
});

describe("history times", () => {
  it("replays the recorded time with resumed messages", async () => {
    const fake = fakeStoredSession({
      savedId: "saved-1",
      history: [
        {
          kind: "userMessage",
          itemId: "u1",
          revision: 1,
          status: "completed",
          text: "first question",
          recordedAt: "2026-10-28T09:41:00.000Z",
        },
        {
          kind: "agentMessage",
          itemId: "a1",
          revision: 2,
          status: "completed",
          text: "first answer",
          recordedAt: "2026-10-28T09:42:00.000Z",
        },
      ],
    });
    await fake.host.prepare(process.cwd());
    assert.deepEqual(
      fake.events.filter((event) => event.type === "user" || event.type === "assistant"),
      [
        { type: "user", text: "first question", at: Date.parse("2026-10-28T09:41:00.000Z") },
        { type: "assistant", id: "a1", text: "first answer", at: Date.parse("2026-10-28T09:42:00.000Z") },
      ],
    );
    await fake.host.dispose();
  });
});

type CompletedParams = Extract<TurnOutcome, { kind: "completed" }>["params"];

function terminalOutcome(terminal: string): TurnOutcome {
  return {
    kind: "completed",
    observedStart: true,
    params: { terminal, sessionId: "session-1", turnId: "turn-1" } as CompletedParams,
  };
}

async function* settledAfter(done: Promise<unknown>): AsyncGenerator<never> {
  await done;
}

interface FakeHost {
  host: MuseHost;
  events: MuseHostEvent[];
  commands: { method: string; params: Record<string, unknown> }[];
  submitted: Promise<void>;
  finishTurn: (outcome: TurnOutcome) => void;
}

function fakeRunningTurn(
  onCommand: (method: string, params: Record<string, unknown>, fake: FakeHost) => Record<string, unknown>,
): FakeHost {
  const events: MuseHostEvent[] = [];
  const commands: FakeHost["commands"] = [];
  let markSubmitted!: () => void;
  const submitted = new Promise<void>((resolve) => {
    markSubmitted = resolve;
  });
  let finishTurn!: (outcome: TurnOutcome) => void;
  const completed = new Promise<TurnOutcome>((resolve) => {
    finishTurn = resolve;
  });
  const turn: HostTurn = {
    turnId: "turn-1",
    items: () => settledAfter(completed),
    deltas: () => settledAfter(completed),
    completed,
  };
  const session: HostSession = {
    sessionId: "session-1",
    sendUserTurn: async () => {
      markSubmitted();
      return turn;
    },
    onApproval: () => undefined,
    onApprovalError: () => undefined,
    fold: { items: { list: () => [] } },
  };
  const client: HostClient = {
    startSession: async () => session,
    resumeSession: async () => {
      throw new Error("no saved session in this test");
    },
    close: async () => undefined,
  };
  const connection: HostConnection = {
    command: async (method, params) => onCommand(method, params, fake),
    request: async () => ({}),
    onNotification: () => undefined,
  };
  const fake: FakeHost = {
    host: new MuseHost({
      museBin: "unused",
      version: "0.0.1",
      trustWorkspace: false,
      emit: (event) => {
        events.push(event);
      },
      askApproval: () => Promise.resolve(undefined),
      createHost: async () => ({ client, connection }),
    }),
    events,
    commands,
    submitted,
    finishTurn,
  };
  return fake;
}

interface ItemTurnsFake {
  host: MuseHost;
  events: MuseHostEvent[];
}

/** Each sendUserTurn yields the next list of items, then completes. */
function fakeItemTurns(turnItems: FoldedItem[][]): ItemTurnsFake {
  const events: MuseHostEvent[] = [];
  let calls = 0;
  const session: HostSession = {
    sessionId: "session-1",
    sendUserTurn: async () => {
      calls += 1;
      const items = turnItems[calls - 1] ?? [];
      const turn: HostTurn = {
        turnId: `turn-${calls}`,
        items: async function* () {
          yield* items;
        },
        deltas: async function* () {},
        completed: Promise.resolve(terminalOutcome("completed")),
      };
      return turn;
    },
    onApproval: () => undefined,
    onApprovalError: () => undefined,
    fold: { items: { list: () => [] } },
  };
  const client: HostClient = {
    startSession: async () => session,
    resumeSession: async () => {
      throw new Error("no saved session in this test");
    },
    close: async () => undefined,
  };
  const connection: HostConnection = {
    command: async () => ({}),
    request: async () => ({}),
    onNotification: () => undefined,
  };
  return {
    host: new MuseHost({
      museBin: "unused",
      version: "0.0.1",
      trustWorkspace: false,
      emit: (event) => {
        events.push(event);
      },
      askApproval: () => Promise.resolve(undefined),
      createHost: async () => ({ client, connection }),
    }),
    events,
  };
}

interface StoredFake extends FakeHost {
  savedIds: string[];
  cleared: boolean;
  startedFresh: boolean;
}

function fakeStoredSession(options: {
  savedId: string | undefined;
  history?: FoldedItem[];
  resumeThrows?: boolean;
}): StoredFake {
  const events: MuseHostEvent[] = [];
  const commands: FakeHost["commands"] = [];
  const savedIds: string[] = [];
  let cleared = false;
  let startedFresh = false;
  let markSubmitted!: () => void;
  const submitted = new Promise<void>((resolve) => {
    markSubmitted = resolve;
  });
  let finishTurn!: (outcome: TurnOutcome) => void;
  const completed = new Promise<TurnOutcome>((resolve) => {
    finishTurn = resolve;
  });
  const turn: HostTurn = {
    turnId: "turn-1",
    items: () => settledAfter(completed),
    deltas: () => settledAfter(completed),
    completed,
  };
  const makeSession = (sessionId: string, history: FoldedItem[]): HostSession => ({
    sessionId,
    sendUserTurn: async () => {
      markSubmitted();
      return turn;
    },
    onApproval: () => undefined,
    onApprovalError: () => undefined,
    fold: { items: { list: () => history } },
  });
  const resumed = makeSession(options.savedId ?? "saved-1", options.history ?? []);
  const fresh = makeSession("fresh-1", []);
  const client: HostClient = {
    startSession: async () => {
      startedFresh = true;
      return fresh;
    },
    resumeSession: async () => {
      if (options.resumeThrows) {
        throw new Error("session gone");
      }
      return resumed;
    },
    close: async () => undefined,
  };
  const connection: HostConnection = {
    command: async (method, params) => {
      commands.push({ method, params });
      return {};
    },
    request: async () => ({}),
    onNotification: () => undefined,
  };
  return {
    host: new MuseHost({
      museBin: "unused",
      version: "0.0.1",
      trustWorkspace: false,
      emit: (event) => {
        events.push(event);
      },
      askApproval: () => Promise.resolve(undefined),
      createHost: async () => ({ client, connection }),
      sessionStore: {
        loadId: () => options.savedId,
        saveId: (id) => {
          savedIds.push(id);
        },
        clear: () => {
          cleared = true;
        },
      },
    }),
    events,
    commands,
    submitted,
    finishTurn,
    savedIds,
    get cleared() {
      return cleared;
    },
    get startedFresh() {
      return startedFresh;
    },
  };
}
