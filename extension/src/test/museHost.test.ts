import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TurnOutcome } from "@muse-code/sdk";
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
  };
  const client: HostClient = {
    startSession: async () => session,
    close: async () => undefined,
  };
  const connection: HostConnection = {
    command: async (method, params) => onCommand(method, params, fake),
  };
  const fake: FakeHost = {
    host: new MuseHost({
      museBin: "unused",
      version: "0.0.1",
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
