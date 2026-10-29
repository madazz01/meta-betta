import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FoldedItem, TurnOutcome } from "@muse-code/sdk";
import {
  MuseHost,
  type HostClient,
  type HostConnection,
  type HostSession,
  type HostTurn,
  type MuseHostEvent,
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
    assert.equal(first[1], "▶ Running (didn't work)");

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
