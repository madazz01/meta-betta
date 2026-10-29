import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FoldedItem, TurnOutcome } from "@muse-code/sdk";
import type { ApprovalRequestParams, Notification } from "@muse-code/sdk/dist/src/msp.js";
import {
  chainNotifications,
  MuseHost,
  serveArgs,
  type ApprovalAnswer,
  type PickerEvent,
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
  hostOptions?: { sandboxWorkaround?: boolean; platform?: string };
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
});

interface ApprovalFake {
  host: MuseHost;
  events: MuseHostEvent[];
  pickers: PickerEvent[];
  decide: (request: ApprovalRequestParams) => Promise<ApprovalAnswer>;
}

/** Captures the registered approval handler plus the picker it builds. */
function fakeApprovalHost(answer: ApprovalAnswer | undefined): ApprovalFake {
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
