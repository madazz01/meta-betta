// Owns the Muse Code SDK client: spawn, session, streaming turns, approvals.
// Talks to the view through events; knows nothing about VS Code or webviews.
//
// The SDK is ESM-only, so it is loaded with a dynamic import() (kept as a real
// import by the NodeNext module setting — never a require). Type-only imports
// below are erased at compile time.

import { execFile } from "node:child_process";
import type { FoldedItem, MuseClient, Session, Turn, TurnOutcome } from "@muse-code/sdk";
import type { ApprovalRequestParams, ItemDeltaParams } from "@muse-code/sdk/dist/src/msp.js";
import { approvalCard, safestChoiceId } from "../lib/approvals.js";
import { reasoningText, toolRowText } from "../lib/items.js";
import { classifySpawnError, parseSandboxReady, shortReason } from "../lib/startup.js";

export interface ApprovalChoiceCard {
  id: string;
  label: string;
}

export interface ApprovalCardEvent {
  type: "approval";
  id: string;
  title: string;
  detail?: string;
  choices: ApprovalChoiceCard[];
}

export type MuseHostEvent =
  | { type: "assistant"; id: string; text: string }
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; text: string; done: boolean }
  | { type: "status"; text: string }
  | ApprovalCardEvent
  | { type: "approvalDone"; id: string }
  | { type: "notice"; text: string; copy?: string; kind: "info" | "error" }
  | { type: "turn"; state: "started" | "done" };

export interface MuseHostOptions {
  museBin: string;
  version: string;
  emit: (event: MuseHostEvent) => void;
  /**
   * Show an approval card and resolve with the clicked choiceId, or undefined
   * when the panel can't ask (closed) — the host then takes the safest choice.
   */
  askApproval: (card: ApprovalCardEvent) => Promise<string | undefined>;
}

interface TurnState {
  gen: number;
  kinds: Map<string, string>;
  pending: ItemDeltaParams[];
  assistant: Map<string, string>;
  thinking: Map<string, string>;
  settled: Set<string>;
  toolSeen: boolean;
}

function newTurnState(gen: number): TurnState {
  return {
    gen,
    kinds: new Map(),
    pending: [],
    assistant: new Map(),
    thinking: new Map(),
    settled: new Set(),
    toolSeen: false,
  };
}

export class MuseHost {
  private client: MuseClient | undefined;
  private session: Session | undefined;
  private starting: Promise<void> | undefined;
  /** Bumped by every send and every stop; older turns' late events are dropped. */
  private turnGen = 0;
  private approvalWaiters = new Set<(choiceId: string | undefined) => void>();

  public constructor(private readonly options: MuseHostOptions) {}

  public async send(text: string, workspaceRoot: string): Promise<void> {
    this.turnGen += 1;
    const state = newTurnState(this.turnGen);
    this.emit({ type: "turn", state: "started" });
    try {
      await this.ensureStarted(workspaceRoot);
    } catch (error) {
      await this.startupFailed(error, state.gen);
      return;
    }
    const session = this.session;
    if (!session || !this.live(state)) {
      return;
    }
    this.emit({ type: "status", text: "Muse is thinking…" });
    let turn: Turn;
    try {
      turn = await session.sendUserTurn({ input: [{ type: "text", text }] });
    } catch (error) {
      this.markDead();
      this.finishTurn(state.gen, {
        kind: "error",
        text: `Something went wrong: ${shortReason(error)}. Want me to try again?`,
      });
      return;
    }
    await this.followTurn(turn, state);
  }

  /**
   * Stop showing the current turn. SDK 1.4.14 exposes no turn/cancel verb —
   * the connection is a private field on Session/MuseClient, so there is no
   * supported way to send one — so this stops the panel (late events are
   * dropped) while the server turn runs out in the background; a new message
   * queues behind it.
   */
  public stop(): void {
    this.turnGen += 1;
    for (const finish of this.approvalWaiters) {
      finish(undefined);
    }
    this.emit({ type: "notice", kind: "info", text: "Stopped." });
    this.emit({ type: "turn", state: "done" });
    this.emit({ type: "status", text: "Ready" });
  }

  public async dispose(): Promise<void> {
    this.turnGen += 1;
    for (const finish of this.approvalWaiters) {
      finish(undefined);
    }
    this.approvalWaiters.clear();
    const client = this.client;
    this.client = undefined;
    this.session = undefined;
    this.starting = undefined;
    if (client) {
      await client.close();
    }
  }

  private emit(event: MuseHostEvent): void {
    this.options.emit(event);
  }

  private live(state: TurnState): boolean {
    return state.gen === this.turnGen;
  }

  private ensureStarted(workspaceRoot: string): Promise<void> {
    if (this.session) {
      return Promise.resolve();
    }
    this.starting ??= this.start(workspaceRoot).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(workspaceRoot: string): Promise<void> {
    this.emit({ type: "status", text: "Starting Muse…" });
    const { MuseClient } = await import("@muse-code/sdk");
    let client: MuseClient;
    try {
      client = await MuseClient.spawn({
        museBin: this.options.museBin,
        args: ["serve"],
        clientInfo: { name: "meta_betta", version: this.options.version },
      });
      this.session = await client.startSession({ workspaceRoot });
    } catch (error) {
      this.client = undefined;
      this.session = undefined;
      throw error;
    }
    this.client = client;
    this.session.onApproval(async (request) => ({ choiceId: await this.decideApproval(request) }));
    this.session.onApprovalError(() => {
      this.emit({
        type: "notice",
        kind: "error",
        text: "That permission request didn't go through. Try stopping the turn and asking again.",
      });
    });
  }

  private decideApproval(request: ApprovalRequestParams): Promise<string> {
    const card = approvalCard(request.subject, request.toolName, request.rawArgs);
    return new Promise<string>((resolve) => {
      const finish = (choiceId: string | undefined) => {
        this.approvalWaiters.delete(finish);
        resolve(choiceId ?? safestChoiceId(request.availableChoices) ?? "");
        this.emit({ type: "approvalDone", id: request.approvalId });
      };
      this.approvalWaiters.add(finish);
      void this.options
        .askApproval({
          type: "approval",
          id: request.approvalId,
          title: card.title,
          detail: card.detail,
          choices: request.availableChoices.map((choice) => ({ id: choice.choiceId, label: choice.label })),
        })
        .then(
          (choiceId) => finish(choiceId),
          () => finish(undefined),
        );
    });
  }

  private async followTurn(turn: Turn, state: TurnState): Promise<void> {
    const itemsDone = (async () => {
      for await (const item of turn.items()) {
        if (!this.live(state)) {
          break;
        }
        this.onItem(item, state);
      }
    })();
    const deltasDone = (async () => {
      for await (const delta of turn.deltas()) {
        if (!this.live(state)) {
          break;
        }
        this.onDelta(delta, state);
      }
    })();
    let outcome: TurnOutcome;
    try {
      await Promise.all([itemsDone, deltasDone]);
      outcome = await turn.completed;
    } catch (error) {
      // The host died mid-turn: drop the session so the next send restarts it.
      this.markDead();
      this.finishTurn(state.gen, {
        kind: "error",
        text: `Something went wrong: ${shortReason(error)}. Want me to try again?`,
      });
      return;
    }
    if (!this.live(state)) {
      return;
    }
    this.finishOutcome(outcome, state.gen);
  }

  private onItem(item: FoldedItem, state: TurnState): void {
    // String(...) because DeepReadonly over the SDK's open string enums is no
    // longer typed as string, though it always is one at runtime.
    state.kinds.set(item.itemId, String(item.kind));
    this.flushPending(item.itemId, state);
    switch (item.kind) {
      case "userMessage":
      case "reminderChild":
        return;
      case "agentMessage": {
        const text = item.text ?? "";
        const settled = item.status !== "inProgress";
        if (settled || text.length >= (state.assistant.get(item.itemId) ?? "").length) {
          if (settled) {
            state.settled.add(item.itemId);
          }
          state.assistant.set(item.itemId, text);
          this.emit({ type: "assistant", id: item.itemId, text });
        }
        return;
      }
      case "reasoning": {
        const text = reasoningText(item.summary, item.text);
        const settled = item.status !== "inProgress";
        if (text && (settled || text.length >= (state.thinking.get(item.itemId) ?? "").length)) {
          if (settled) {
            state.settled.add(item.itemId);
          }
          state.thinking.set(item.itemId, text);
          this.emit({ type: "thinking", id: item.itemId, text });
        }
        return;
      }
      default: {
        if (!state.toolSeen) {
          state.toolSeen = true;
          this.emit({ type: "status", text: "Muse is working…" });
        }
        const row = toolRowText({
          kind: String(item.kind),
          tool: item.tool,
          args: item.args,
          displayLabel: item.displayLabel,
          status: String(item.status),
          failureReason: item.failureReason,
          fallbackText: item.fallbackText,
          commandText: item.commandText,
        });
        this.emit({ type: "tool", id: item.itemId, text: row.text, done: row.done });
      }
    }
  }

  private onDelta(delta: ItemDeltaParams, state: TurnState): void {
    const kind = state.kinds.get(delta.itemId);
    if (!kind) {
      state.pending.push(delta);
      return;
    }
    this.applyDelta(kind, delta, state);
  }

  private flushPending(itemId: string, state: TurnState): void {
    const kind = state.kinds.get(itemId);
    if (!kind || state.pending.length === 0) {
      return;
    }
    const rest: ItemDeltaParams[] = [];
    for (const delta of state.pending) {
      if (delta.itemId === itemId) {
        this.applyDelta(kind, delta, state);
      } else {
        rest.push(delta);
      }
    }
    state.pending = rest;
  }

  private applyDelta(kind: string, delta: ItemDeltaParams, state: TurnState): void {
    if (state.settled.has(delta.itemId)) {
      return;
    }
    const field = delta.field ?? "text";
    if (kind === "agentMessage" && field === "text") {
      const text = (state.assistant.get(delta.itemId) ?? "") + delta.delta;
      state.assistant.set(delta.itemId, text);
      this.emit({ type: "assistant", id: delta.itemId, text });
    } else if (kind === "reasoning" && field.startsWith("summary")) {
      const text = (state.thinking.get(delta.itemId) ?? "") + delta.delta;
      state.thinking.set(delta.itemId, text);
      this.emit({ type: "thinking", id: delta.itemId, text });
    }
    // toolCall/userShell "output" deltas are skipped: rows stay one line.
  }

  private finishOutcome(outcome: TurnOutcome, gen: number): void {
    if (outcome.kind === "completed") {
      const terminal = outcome.params.terminal;
      if (terminal === "completed") {
        this.finishTurn(gen);
      } else if (terminal === "cancelled") {
        this.finishTurn(gen, { kind: "info", text: "Stopped." });
      } else if (terminal === "failed") {
        this.finishTurn(gen, {
          kind: "error",
          text: outcome.params.error
            ? `Something went wrong: ${shortReason(outcome.params.error.message)}. Want me to try again?`
            : "Something went wrong. Want me to try again?",
        });
      } else {
        this.finishTurn(gen, {
          kind: "error",
          text: `Something went wrong: the turn ended (${terminal}). Want me to try again?`,
        });
      }
    } else if (outcome.kind === "unqueued") {
      this.finishTurn(gen, { kind: "error", text: "That turn didn't run. Want to try again?" });
    } else {
      this.markDead();
      this.finishTurn(gen, {
        kind: "error",
        text: "I lost touch with Muse. Send your message again and I'll reconnect.",
      });
    }
  }

  private finishTurn(gen: number, notice?: { kind: "info" | "error"; text: string }): void {
    if (gen !== this.turnGen) {
      return;
    }
    if (notice) {
      this.emit({ type: "notice", kind: notice.kind, text: notice.text });
    }
    this.emit({ type: "turn", state: "done" });
    this.emit({ type: "status", text: "Ready" });
  }

  private async startupFailed(error: unknown, gen: number): Promise<void> {
    if (gen !== this.turnGen) {
      return;
    }
    const problem = classifySpawnError(error);
    if (problem === "missing" || problem === "login") {
      this.emit({
        type: "notice",
        kind: "error",
        text: "I can't find Muse Code. Install it with: `irm https://dev.meta.ai/install.ps1 | iex`, then run `muse` once to log in.",
        copy: "irm https://dev.meta.ai/install.ps1 | iex",
      });
    } else if (await this.sandboxNeedsSetup()) {
      if (gen !== this.turnGen) {
        return;
      }
      this.emit({
        type: "notice",
        kind: "error",
        text: "Muse needs a one-time setup with admin rights. Open PowerShell as administrator and run `muse sandbox windows setup`, then come back.",
        copy: "muse sandbox windows setup",
      });
    } else {
      if (gen !== this.turnGen) {
        return;
      }
      this.emit({
        type: "notice",
        kind: "error",
        text: `Something went wrong starting Muse: ${shortReason(error)}. Want to try again?`,
      });
    }
    this.emit({ type: "turn", state: "done" });
    this.emit({ type: "status", text: "Ready" });
  }

  private sandboxNeedsSetup(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.options.museBin, ["sandbox", "windows", "check"], { timeout: 15000 }, (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(!parseSandboxReady(stdout));
      });
    });
  }

  private markDead(): void {
    const client = this.client;
    this.client = undefined;
    this.session = undefined;
    if (client) {
      void client.close().catch(() => undefined);
    }
  }
}
