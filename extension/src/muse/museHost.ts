// Owns the Muse Code SDK client: spawn, session, streaming turns, approvals.
// Talks to the view through events; knows nothing about VS Code or webviews.
//
// The SDK is ESM-only, so it is loaded with a dynamic import() (kept as a real
// import by the NodeNext module setting — never a require). Type-only imports
// below are erased at compile time.

import { execFile } from "node:child_process";
import type {
  ApprovalFailureHandler,
  ApprovalHandler,
  FoldedItem,
  MuseClient,
  TurnOutcome,
} from "@muse-code/sdk";
import type {
  ApprovalRequestParams,
  ItemDeltaParams,
  Notification,
} from "@muse-code/sdk/dist/src/msp.js";
import { formatSaveTime, stripBackgroundPrefix } from "../brain/brain.js";
import { isSavePrompt } from "../brain/prompts.js";
import type {
  AllowanceSlice,
  EffortLevel,
  GoalInfo,
  ModelRow,
  PluginRow,
  ResumeSession,
  SkillRow,
  TaskRow,
} from "../commands/slash.js";
import {
  allowedOnceRow,
  alwaysAllowedRow,
  approvalCard,
  backedUpRow,
  backupAction,
  choiceHint,
  currentStage,
  describeStage,
  findStageChoice,
  isReadOnlyStage,
  isRejectChoice,
  lookedAtRow,
  pickerTitle,
  rejectedRow,
  rememberedDecision,
  safestChoiceId,
  stageLabel,
  type RememberedDecision,
} from "../lib/approvals.js";
import { historyEvent, isSandboxBugFailure, reasoningText, toolRowText } from "../lib/items.js";
import { decideSession } from "../lib/session.js";
import { classifySpawnError, parseSandboxReady, shortReason } from "../lib/startup.js";
import type { SessionUsageTotals } from "../lib/usage.js";

export interface PickerChoiceCard {
  id: string;
  label: string;
  /** Hover hint; only the always-allow choice carries one. */
  hint?: string;
  /** The "No, tell Muse…" row: rejecting opens the one-line why box. */
  isReject: boolean;
}

export interface PickerEvent {
  type: "picker";
  /** The approval id; one picker per command, whatever its stages. */
  id: string;
  /** The subject kind ("shell", "fileAccess", …) for one-time notices. */
  kind: string;
  title: string;
  detail?: string;
  /** Short stage lines for a multi-stage shell command. */
  stages?: string[];
  choices: PickerChoiceCard[];
}

/** The panel's answer to an approval card: the clicked choice plus optional "why". */
export interface ApprovalAnswer {
  choiceId: string;
  feedback?: string;
}

export type MuseHostEvent =
  | { type: "user"; text: string; at?: number }
  | { type: "assistant"; id: string; text: string; at?: number }
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; text: string; done: boolean }
  | { type: "status"; text: string }
  | PickerEvent
  | { type: "approvalDone"; id: string }
  | { type: "notice"; text: string; copy?: string; kind: "info" | "error" }
  | { type: "turn"; state: "started" | "done" }
  | { type: "usage"; usage: SessionUsageTotals }
  | { type: "goal"; goal: GoalInfo | null }
  | { type: "model"; modelId: string }
  | { type: "effort"; level: EffortLevel };

export interface MuseHostOptions {
  museBin: string;
  version: string;
  /** Pass --trust-workspace so Muse reads the workspace AGENTS.md. */
  trustWorkspace: boolean;
  emit: (event: MuseHostEvent) => void;
  /**
   * Show the approval picker and resolve with the picked choice, or undefined
   * when the panel can't ask (closed) — the host then takes the safest choice.
   */
  askApproval: (picker: PickerEvent) => Promise<ApprovalAnswer | undefined>;
  /**
   * Windows sandbox workaround (the metaBetta.windowsSandboxWorkaround
   * setting): spawn with the sandbox off and make Muse ask before every
   * command. Off unless enabled.
   */
  sandboxWorkaround?: boolean;
  /** Test seam: pretend platform for the sandbox workaround. */
  platform?: string;
  /** Test seam: build the client instead of spawning `muse serve`. */
  createHost?: () => Promise<{ client: HostClient; connection: HostConnection }>;
  /** Saved session id storage; without it every start is a fresh session. */
  sessionStore?: SessionStore;
  /** Step-by-step notes for the output channel (side runs, recaps). */
  log?: (message: string) => void;
}

/** The slice of the SDK client MuseHost drives (real or fake). */
export interface HostClient {
  startSession(options: { workspaceRoot: string }): Promise<HostSession>;
  resumeSession(options: {
    sessionId: string;
    onApproval: ApprovalHandler;
    onApprovalError: ApprovalFailureHandler;
  }): Promise<HostSession>;
  close(): Promise<void>;
}

/** The slice of the SDK session MuseHost drives (real or fake). */
export interface HostSession {
  readonly sessionId: string;
  sendUserTurn(options: { input: { type: "text"; text: string }[] }): Promise<HostTurn>;
  onApproval(handler: ApprovalHandler): void;
  onApprovalError(handler: ApprovalFailureHandler): void;
  readonly fold: { readonly items: { list(): readonly FoldedItem[] } };
}

/** Saved session id storage, owned by the view layer. */
export interface SessionStore {
  loadId(): string | undefined;
  saveId(sessionId: string): void;
  clear(): void;
}

/** The slice of the SDK turn MuseHost drives (real or fake). */
export interface HostTurn {
  readonly turnId: string;
  items(): AsyncIterableIterator<FoldedItem>;
  deltas(): AsyncIterableIterator<ItemDeltaParams>;
  readonly completed: Promise<TurnOutcome>;
}

/** The slice of the SDK connection MuseHost drives (real or fake). */
export interface HostConnection {
  command(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  onNotification(handler: (notification: Notification) => void): void;
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

/**
 * One command's approval state, keyed by approvalId: the picked choice
 * (answered once, applied to every stage) plus read-only stage labels
 * waiting for their quiet row.
 */
interface PendingCommand {
  lookedAt: string[];
  decided?: RememberedDecision;
  timer?: ReturnType<typeof setTimeout>;
  at: number;
}

/** Quiet "looked at" labels flush 1s after the last read-only stage. */
const QUIET_FLUSH_MS = 1000;

/** Per-command memories older than this are dropped. */
const PENDING_TTL_MS = 5 * 60_000;

export class MuseHost {
  private client: HostClient | undefined;
  private session: HostSession | undefined;
  private connection: HostConnection | undefined;
  private currentTurnId: string | undefined;
  private historyLoadedFor: string | undefined;
  private starting: Promise<HostSession> | undefined;
  /** Bumped by every send and every stop; older turns' late events are dropped. */
  private turnGen = 0;
  /** The sandbox-bug plain line shows once per session, then rows stay short. */
  private sandboxBugNoted = false;
  private approvalWaiters = new Set<(answer: ApprovalAnswer | undefined) => void>();
  /** Session ids with promptUnmatched confirmed (Windows workaround only). */
  private promptModeFor: string | undefined;
  /** Per-command approval state, keyed by approvalId. */
  private pendingApprovals = new Map<string, PendingCommand>();
  /** The workspace approvals resolve backup paths against. */
  private workspaceRoot = "";
  private backupSeq = 0;
  private quietSeq = 0;
  private recapWaiters = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: (recap: { text: string; title?: string }) => void;
      reject: (error: Error) => void;
    }
  >();

  public constructor(private readonly options: MuseHostOptions) {}

  public async send(text: string, workspaceRoot: string): Promise<void> {
    this.turnGen += 1;
    const state = newTurnState(this.turnGen);
    this.emit({ type: "turn", state: "started" });
    let session: HostSession;
    try {
      session = await this.ensureStarted(workspaceRoot);
    } catch (error) {
      await this.startupFailed(error, state.gen);
      return;
    }
    if (!this.live(state)) {
      return;
    }
    if (!(await this.confirmPromptMode(session.sessionId))) {
      this.finishTurn(state.gen, {
        kind: "error",
        text: "I couldn't make Muse ask before running commands, so I've stopped to be safe.",
      });
      return;
    }
    this.emit({ type: "status", text: "Muse is thinking…" });
    let turn: HostTurn;
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
    this.currentTurnId = turn.turnId;
    if (!this.live(state)) {
      // Stopped while submitting: interrupt the orphan so nothing runs unseen.
      try {
        await this.interruptTurn(turn.turnId);
        if (this.currentTurnId === turn.turnId) {
          this.currentTurnId = undefined;
        }
      } catch {
        // Best effort; a later Stop retries while the id is still set.
      }
      return;
    }
    await this.followTurn(turn, state);
  }

  /**
   * Interrupt the running turn on the server. The cancelled terminal reports
   * "Stopped." through the normal completion path. Falls back to a panel-side
   * stop when there is no running turn or the interrupt throws.
   */
  public async stop(): Promise<void> {
    const turnId = this.currentTurnId;
    if (!turnId) {
      this.localStop();
      return;
    }
    try {
      await this.interruptTurn(turnId);
    } catch {
      this.localStop();
    }
  }

  public async dispose(): Promise<void> {
    this.turnGen += 1;
    this.currentTurnId = undefined;
    for (const finish of this.approvalWaiters) {
      finish(undefined);
    }
    this.approvalWaiters.clear();
    for (const waiter of this.recapWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Muse stopped."));
    }
    this.recapWaiters.clear();
    for (const pending of this.pendingApprovals.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.pendingApprovals.clear();
    const client = this.client;
    this.client = undefined;
    this.session = undefined;
    this.connection = undefined;
    this.starting = undefined;
    if (client) {
      await client.close();
    }
  }

  private async interruptTurn(turnId: string): Promise<void> {
    const session = this.session;
    const connection = this.connection;
    if (!session || !connection) {
      throw new Error("no live session");
    }
    await connection.command("turn/interrupt", { sessionId: session.sessionId, turnId });
  }

  /** True when this host runs with the Windows sandbox off. */
  private sandboxOff(): boolean {
    return serveArgs(
      this.options.platform ?? process.platform,
      this.options.trustWorkspace,
      this.options.sandboxWorkaround ?? false,
    ).includes("--disable-sandbox");
  }

  /**
   * With the Windows sandbox off, Muse must ask before every command. Sends
   * session/setApprovalMode right after the session opens and checks the
   * server confirmed promptUnmatched. Never throws: false means the turn
   * must not run. A no-op unless the workaround is on.
   */
  private async confirmPromptMode(sessionId: string): Promise<boolean> {
    if (!this.sandboxOff() || this.promptModeFor === sessionId) {
      return true;
    }
    try {
      const result = await this.connection?.command("session/setApprovalMode", {
        sessionId,
        mode: "promptUnmatched",
      });
      const mode = asString(asRecord(result?.effectiveMode)?.mode);
      if (mode === "promptUnmatched") {
        this.promptModeFor = sessionId;
        return true;
      }
      this.log(`approval mode: expected promptUnmatched, got ${mode ?? "(none)"}`);
      return false;
    } catch (error) {
      this.log(`approval mode: setApprovalMode failed: ${shortReason(error)}`);
      return false;
    }
  }

  /** Panel-side stop: drop late events and report "Stopped." at once. */
  private localStop(): void {
    this.turnGen += 1;
    this.currentTurnId = undefined;
    for (const finish of this.approvalWaiters) {
      finish(undefined);
    }
    this.emit({ type: "notice", kind: "info", text: "Stopped." });
    this.emit({ type: "turn", state: "done" });
    this.emit({ type: "status", text: "Ready" });
  }

  /**
   * Start a new session on the same client, abandoning the old one (it stays
   * saved by Muse). Interrupts a running turn first; late events from it are
   * dropped. Emits nothing; the caller resets the panel.
   */
  public async newSession(workspaceRoot: string): Promise<void> {
    if (this.currentTurnId) {
      try {
        await this.interruptTurn(this.currentTurnId);
      } catch {
        // Abandoned either way; the generation bump drops late events.
      }
    }
    this.turnGen += 1;
    this.currentTurnId = undefined;
    this.sandboxBugNoted = false;
    for (const finish of this.approvalWaiters) {
      finish(undefined);
    }
    this.approvalWaiters.clear();
    const client = await this.ensureClient();
    const session = await client.startSession({ workspaceRoot });
    this.session = session;
    session.onApproval((request) => this.decideApproval(request));
    session.onApprovalError(() => this.approvalErrorNotice());
    this.options.sessionStore?.saveId(session.sessionId);
    // Best effort here; send() refuses the turn unless this confirms.
    await this.confirmPromptMode(session.sessionId);
  }

  /**
   * Open the session and emit its earlier messages (once per session).
   * Returns how many history events were emitted.
   */
  public async prepare(workspaceRoot: string): Promise<number> {
    const session = await this.ensureStarted(workspaceRoot);
    if (this.historyLoadedFor === session.sessionId) {
      return 0;
    }
    this.historyLoadedFor = session.sessionId;
    const shown = this.loadHistory(session);
    this.emit({ type: "status", text: "Ready" });
    return shown;
  }

  /**
   * Abandon the live session for another one (it stays saved by Muse):
   * interrupt anything running, resume the target, emit its history. Returns
   * how many history events were emitted.
   */
  public async switchSession(sessionId: string, workspaceRoot: string): Promise<number> {
    if (this.currentTurnId) {
      try {
        await this.interruptTurn(this.currentTurnId);
      } catch {
        // Abandoned either way; the generation bump drops late events.
      }
    }
    this.turnGen += 1;
    this.currentTurnId = undefined;
    this.sandboxBugNoted = false;
    for (const finish of this.approvalWaiters) {
      finish(undefined);
    }
    this.approvalWaiters.clear();
    const client = await this.ensureClient();
    const session = await client.resumeSession({
      sessionId,
      onApproval: (request) => this.decideApproval(request),
      onApprovalError: () => this.approvalErrorNotice(),
    });
    this.session = session;
    session.onApproval((request) => this.decideApproval(request));
    session.onApprovalError(() => this.approvalErrorNotice());
    this.options.sessionStore?.saveId(session.sessionId);
    this.historyLoadedFor = session.sessionId;
    // Best effort here; send() refuses the turn unless this confirms.
    await this.confirmPromptMode(session.sessionId);
    return this.loadHistory(session);
  }

  /** Earlier sessions in this workspace, newest first, minus the live one. */
  public async listSessions(workspaceRoot: string): Promise<ResumeSession[]> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const result = await connection.request("session/list", { workspaceRoot, limit: 20 });
    const rows: ResumeSession[] = [];
    for (const row of asArray(result.sessions)) {
      const record = asRecord(row);
      const id = record ? asString(record.sessionId) : undefined;
      if (!record || !id || id === session.sessionId) {
        continue;
      }
      const prompt = asString(record.firstUserPrompt);
      rows.push({
        id,
        name:
          asString(record.name) ?? asString(record.title) ?? prompt?.slice(0, 40) ?? `Session ${id.slice(0, 4)}`,
        updatedAt: asString(record.updatedAt) ?? "",
        turnCount: asNumber(record.turnCount) ?? 0,
      });
    }
    return rows;
  }

  /** The account's allowance slices, when the server reports them. */
  public async readSubscription(
    workspaceRoot: string,
  ): Promise<{ weekly?: AllowanceSlice; window?: AllowanceSlice }> {
    const { connection } = await this.useConnection(workspaceRoot);
    const usage = asRecord((await connection.request("usage/read")).usage);
    const weekly = usage ? parseAllowanceSlice(usage.weekly) : undefined;
    const window = usage ? parseAllowanceSlice(usage.window) : undefined;
    return {
      ...(weekly ? { weekly } : {}),
      ...(window ? { window } : {}),
    };
  }

  /** The model catalog, with the session's model flagged. */
  public async listModels(workspaceRoot: string): Promise<ModelRow[]> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const result = await connection.request("model/list", { sessionId: session.sessionId });
    const rows: ModelRow[] = [];
    for (const row of asArray(result.models)) {
      const record = asRecord(row);
      const modelId = record ? asString(record.modelId) : undefined;
      if (!record || !modelId) {
        continue;
      }
      rows.push({
        modelId,
        label: asString(record.displayLabel) ?? modelId,
        active: record.isActive === true,
      });
    }
    return rows;
  }

  /** Switch the session's model; the next turn uses it. */
  public async setModel(workspaceRoot: string, modelId: string): Promise<void> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const result = await connection.command("session/setModel", {
      sessionId: session.sessionId,
      model: { modelId },
    });
    checkAccepted(result);
  }

  /** Shrink a long conversation; "noop" when there's nothing to tidy. */
  public async compact(workspaceRoot: string): Promise<"compacted" | "noop"> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const result = await connection.command("session/compact", { sessionId: session.sessionId });
    if (result.status === "noop") {
      return "noop";
    }
    checkAccepted(result);
    return "compacted";
  }

  /** A short "where we're up to" summary, awaited via recap/completed. */
  public async recap(workspaceRoot: string): Promise<{ text: string; title?: string }> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const result = await connection.command("recap/request", { sessionId: session.sessionId });
    const commandId = asString(result.commandId);
    if (!commandId) {
      throw new Error("Muse didn't take it.");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.recapWaiters.delete(commandId);
        reject(new Error("The recap took too long."));
      }, 120_000);
      timer.unref?.();
      this.recapWaiters.set(commandId, { timer, resolve, reject });
    });
  }

  /** One of the goal verbs; the pin updates on session/goalChanged. */
  public async goalCommand(
    workspaceRoot: string,
    op: "set" | "edit" | "pause" | "resume" | "clear",
    objective?: string,
  ): Promise<void> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const params: Record<string, unknown> = { sessionId: session.sessionId };
    if ((op === "set" || op === "edit") && objective !== undefined) {
      params.objective = objective;
    }
    checkAccepted(await connection.command(`goal/${op}`, params));
  }

  /**
   * Ask a quick question in a side session; the main chat never sees it.
   * Approvals fall back to the main panel when the side run needs one.
   * Progress lines feed the side card; the log notes each step for diagnosis.
   */
  public async sideAsk(
    workspaceRoot: string,
    question: string,
    onProgress?: (line: string) => void,
  ): Promise<string> {
    const started = Date.now();
    const { session, connection } = await this.useConnection(workspaceRoot);
    const client = this.client;
    if (!client) {
      throw new Error("Muse isn't running.");
    }
    const made = await connection.command("session/sideChat", { sessionId: session.sessionId });
    const sideId = asString(asRecord(made.session)?.sessionId);
    this.log(`side: opened ${sideId ?? "(no id)"} in ${Date.now() - started}ms`);
    if (!sideId) {
      throw new Error("Muse didn't take it.");
    }
    onProgress?.("Chat opened");
    const side = await client.resumeSession({
      sessionId: sideId,
      onApproval: (request) => this.decideApproval(request),
      onApprovalError: () => this.approvalErrorNotice(),
    });
    this.log(`side: resumed in ${Date.now() - started}ms`);
    if (!(await this.confirmPromptMode(sideId))) {
      throw new Error("I couldn't make Muse ask before running commands, so I've stopped to be safe.");
    }
    onProgress?.("Asking…");
    const turn = await side.sendUserTurn({ input: [{ type: "text", text: question }] });
    this.log(`side: turn ${turn.turnId} sent in ${Date.now() - started}ms`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        collectSideAnswer(turn, (message) => this.log(message), onProgress),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.log(`side: timed out waiting in ${Date.now() - started}ms`);
            void connection
              .command("turn/interrupt", { sessionId: sideId, turnId: turn.turnId })
              .catch(() => undefined);
            reject(new Error("The side answer took too long."));
          }, 180_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** Fork from here (full history); resolves to the new session id. */
  public async forkSession(workspaceRoot: string): Promise<string> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const result = await connection.command("session/fork", { sessionId: session.sessionId });
    const id = asString(asRecord(result.session)?.sessionId);
    if (!id) {
      throw new Error("Muse didn't take it.");
    }
    // Best effort: the fork isn't loaded here yet, so this may fail; the
    // resume in switchSession confirms before any turn runs.
    await this.confirmPromptMode(id);
    return id;
  }

  /** What's running in this session: workflows, helpers, terminals. */
  public async listTasks(workspaceRoot: string): Promise<TaskRow[]> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const result = await connection.request("task/list", { sessionId: session.sessionId });
    const rows: TaskRow[] = [];
    for (const row of asArray(result.tasks)) {
      const record = asRecord(row);
      const taskId = record ? asString(record.taskId) : undefined;
      if (!record || !taskId) {
        continue;
      }
      rows.push({ taskId, label: taskLabel(record), detail: taskDetail(record) });
    }
    return rows;
  }

  public async stopTask(workspaceRoot: string, taskId: string): Promise<void> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    checkAccepted(await connection.command("task/stop", { sessionId: session.sessionId, taskId }));
  }

  public async stopAllTasks(workspaceRoot: string): Promise<void> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    checkAccepted(await connection.command("task/stopAll", { sessionId: session.sessionId }));
  }

  /** The session's skills. */
  public async listSkills(workspaceRoot: string): Promise<SkillRow[]> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const result = await connection.request("skill/list", { sessionId: session.sessionId });
    const rows: SkillRow[] = [];
    for (const row of asArray(result.skills)) {
      const record = asRecord(row);
      const selector = record ? asString(record.selector) : undefined;
      if (!record || !selector) {
        continue;
      }
      rows.push({
        selector,
        name: asString(record.displayName) ?? selector,
        description: asString(record.description) ?? "",
      });
    }
    return rows;
  }

  /** Turn one skill on or off for this project. */
  public async setSkill(workspaceRoot: string, selector: string, on: boolean): Promise<void> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    await connection.command("skill/setActivation", {
      sessionId: session.sessionId,
      selector,
      scope: "project",
      activation: on ? "on" : "off",
    });
  }

  /** Installed plugins. */
  public async listPlugins(workspaceRoot: string): Promise<PluginRow[]> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const result = await connection.request("plugin/list", { sessionId: session.sessionId });
    const rows: PluginRow[] = [];
    for (const row of asArray(result.plugins)) {
      const record = asRecord(row);
      const id = record ? asString(record.id) : undefined;
      if (!record || !id) {
        continue;
      }
      rows.push({
        id,
        version: asString(record.version) ?? "?",
        enabled: record.enabled === true,
      });
    }
    return rows;
  }

  /** Install a plugin from a store or a folder. */
  public async installPlugin(
    workspaceRoot: string,
    target: { marketplace: string; name: string } | { path: string },
  ): Promise<{ id: string; version: string; advisory?: string }> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    const result = await connection.command("plugin/install", {
      sessionId: session.sessionId,
      target:
        "path" in target
          ? { localPath: { path: target.path } }
          : { marketplace: { marketplace: target.marketplace, name: target.name } },
    });
    checkAccepted(result);
    const advisory = asString(result.advisory);
    return {
      id: asString(result.id) ?? "",
      version: asString(result.version) ?? "?",
      ...(advisory ? { advisory: advisory.slice(0, 200) } : {}),
    };
  }

  /** Quick / normal / deep thinking for the rest of the session. */
  public async setEffort(workspaceRoot: string, level: EffortLevel): Promise<void> {
    const { session, connection } = await this.useConnection(workspaceRoot);
    checkAccepted(
      await connection.command("session/setReasoningEffort", {
        sessionId: session.sessionId,
        reasoningEffort: EFFORT_TO_TIER[level],
      }),
    );
  }

  private emit(event: MuseHostEvent): void {
    this.options.emit(event);
  }

  /** The live session and connection, starting them when needed. */
  private async useConnection(
    workspaceRoot: string,
  ): Promise<{ session: HostSession; connection: HostConnection }> {
    const session = await this.ensureStarted(workspaceRoot);
    const connection = this.connection;
    if (!connection) {
      throw new Error("Muse isn't running.");
    }
    return { session, connection };
  }

  /**
   * Server notifications on the held connection: usage totals, goal/model/
   * effort changes, recap completions. Anything from another session (a side
   * run) is ignored.
   */
  private onNotification(notification: Notification): void {
    // Never throws: a throw here would kill the shared notification pump.
    const params = asRecord(notification.params) ?? {};
    const sessionId = asString(params.sessionId);
    switch (notification.method) {
      case "session/tokenUsage": {
        if (sessionId === undefined || sessionId !== this.session?.sessionId) {
          return;
        }
        const usage = parseTokenUsage(params);
        if (usage) {
          this.emit({ type: "usage", usage });
        }
        return;
      }
      case "session/goalChanged": {
        if (sessionId === undefined || sessionId !== this.session?.sessionId) {
          return;
        }
        if (!("goal" in params)) {
          return;
        }
        const goal = parseGoal(params.goal);
        if (goal !== undefined) {
          this.emit({ type: "goal", goal });
        }
        return;
      }
      case "session/modelChanged": {
        if (sessionId === undefined || sessionId !== this.session?.sessionId) {
          return;
        }
        const modelId = asString(params.modelId);
        if (modelId) {
          this.emit({ type: "model", modelId });
        }
        return;
      }
      case "session/reasoningEffortChanged": {
        if (sessionId === undefined || sessionId !== this.session?.sessionId) {
          return;
        }
        const level = effortFromTier(params.reasoningEffort);
        if (level) {
          this.emit({ type: "effort", level });
        }
        return;
      }
      case "recap/completed": {
        const commandId = asString(params.commandId);
        const waiter = commandId ? this.recapWaiters.get(commandId) : undefined;
        if (!waiter || !commandId) {
          return;
        }
        this.recapWaiters.delete(commandId);
        clearTimeout(waiter.timer);
        if (
          params.outcome === "completed" &&
          typeof params.text === "string" &&
          params.text.trim() !== ""
        ) {
          waiter.resolve({ text: params.text, title: asString(params.title) });
        } else if (params.outcome === "cancelled") {
          waiter.reject(new Error("The recap was cancelled."));
        } else {
          waiter.reject(new Error("The recap didn't come back."));
        }
        return;
      }
      default: {
        return;
      }
    }
  }

  private live(state: TurnState): boolean {
    return state.gen === this.turnGen;
  }

  private ensureStarted(workspaceRoot: string): Promise<HostSession> {
    this.workspaceRoot = workspaceRoot;
    if (this.session) {
      return Promise.resolve(this.session);
    }
    this.starting ??= this.openSession(workspaceRoot).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async openSession(workspaceRoot: string): Promise<HostSession> {
    const client = await this.ensureClient();
    const savedId = this.options.sessionStore?.loadId()?.trim() || undefined;
    let session: HostSession | undefined;
    if (savedId) {
      try {
        session = await client.resumeSession({
          sessionId: savedId,
          onApproval: (request) => this.decideApproval(request),
          onApprovalError: () => this.approvalErrorNotice(),
        });
      } catch {
        session = undefined;
      }
    }
    const action = decideSession(savedId, session !== undefined);
    if (action === "resume-saved" && session) {
      this.session = session;
      this.options.sessionStore?.saveId(session.sessionId);
      // Best effort here; send() refuses the turn unless this confirms.
      await this.confirmPromptMode(session.sessionId);
      return session;
    }
    let fresh: HostSession;
    try {
      fresh = await client.startSession({ workspaceRoot });
    } catch (error) {
      this.markDead();
      throw error;
    }
    this.session = fresh;
    fresh.onApproval((request) => this.decideApproval(request));
    fresh.onApprovalError(() => this.approvalErrorNotice());
    // Best effort here; send() refuses the turn unless this confirms.
    await this.confirmPromptMode(fresh.sessionId);
    if (action === "restart-after-failed-resume") {
      this.options.sessionStore?.clear();
      this.emit({
        type: "notice",
        kind: "info",
        text: "Couldn't reopen yesterday's chat, so I've started a fresh one.",
      });
    }
    this.options.sessionStore?.saveId(fresh.sessionId);
    return fresh;
  }

  private async ensureClient(): Promise<HostClient> {
    if (this.client) {
      return this.client;
    }
    this.emit({ type: "status", text: "Starting Muse…" });
    if (this.options.createHost) {
      const built = await this.options.createHost();
      this.client = built.client;
      this.connection = built.connection;
      this.connection.onNotification((notification) => this.onNotification(notification));
      return this.client;
    }
    // The same steps MuseClient.spawn() takes, done manually so this host
    // holds the connection (needed to interrupt a running turn).
    // See spike/stop.mjs.
    const { MuseClient, spawnMspConnection, readSessionDurability } = await import("@muse-code/sdk");
    const args = serveArgs(
      this.options.platform ?? process.platform,
      this.options.trustWorkspace,
      this.options.sandboxWorkaround ?? false,
    );
    const handshake = spawnMspConnection({ command: this.options.museBin, args });
    let client: MuseClient | undefined;
    try {
      const spawned = await handshake.initialize({
        clientInfo: { name: "meta_betta", version: this.options.version },
      });
      // Chain before the client claims the single notification slot.
      chainNotifications(spawned.connection, (error) => {
        this.log(`notification handler failed: ${shortReason(error)}`);
      });
      client = new MuseClient(spawned.connection, {
        durability: readSessionDurability(spawned.initializeResult),
        host: spawned,
      });
      this.client = client;
      this.connection = spawned.connection;
      this.connection.onNotification((notification) => this.onNotification(notification));
      return client;
    } catch (error) {
      if (client) {
        await client.close().catch(() => undefined);
      } else {
        await handshake.close().catch(() => undefined);
      }
      this.client = undefined;
      this.session = undefined;
      this.connection = undefined;
      // After teardown the exit is settled: when the spawn itself failed,
      // throw its error (e.g. ENOENT) instead of the knock-on EPIPE, so the
      // panel can show the right card.
      const spawnError = await handshake.child.exit.then(
        () => undefined,
        (exitError: unknown) => exitError,
      );
      if (spawnError instanceof Error) {
        throw spawnError;
      }
      throw error;
    }
  }

  private loadHistory(session: HostSession): number {
    let count = 0;
    let skippingSave = false;
    for (const item of session.fold.items.list()) {
      const event = historyEvent({
        kind: String(item.kind),
        itemId: item.itemId,
        text: item.text,
        displayText: item.displayText,
        summary: item.summary,
        recordedAt: item.recordedAt,
      });
      if (!event) {
        continue;
      }
      if (event.type === "user") {
        // Resumed quiet-start messages carry the background block; replay
        // only the user's own words.
        const text = stripBackgroundPrefix(event.text);
        if (!text) {
          continue;
        }
        // Save turns were filed into brain/ already; replaying the prompt
        // and its raw reply would just be noise.
        skippingSave = isSavePrompt(text);
        if (skippingSave) {
          continue;
        }
        this.emit({ type: "user", text, ...(event.at === undefined ? {} : { at: event.at }) });
      } else {
        if (skippingSave && event.type === "assistant") {
          continue;
        }
        this.emit(event);
      }
      count += 1;
    }
    return count;
  }

  private approvalErrorNotice(): void {
    this.emit({
      type: "notice",
      kind: "error",
      text: "That permission request didn't go through. Try stopping the turn and asking again.",
    });
  }

  /**
   * One ask per command, not per stage. Requests sharing an approvalId are
   * one picker: the pick is remembered and later stages answer from memory.
   * Read-only stages and rule-9 backups never reach the picker.
   */
  private decideApproval(request: ApprovalRequestParams): Promise<ApprovalAnswer> {
    const approvalId = request.approvalId;
    const sourceIndex = request.currentRequirementId?.sourceIndex ?? 0;
    const shell = request.subject.kind === "shell";
    const stages = shell ? (request.subject.stages ?? []) : [];
    const stage = shell ? currentStage(request.subject.stages, sourceIndex) : undefined;
    const argv = stage?.argv ?? [];
    this.sweepPending();
    const pending = this.pendingFor(approvalId);

    if (pending.decided) {
      const remembered = findStageChoice(request.availableChoices, pending.decided);
      if (remembered !== undefined) {
        return this.answerQuietly(approvalId, remembered);
      }
      // The remembered answer isn't offered for this stage: ask again.
    } else if (shell && stage && isReadOnlyStage(argv)) {
      const once = findStageChoice(request.availableChoices, "once");
      if (once !== undefined) {
        pending.lookedAt.push(stageLabel(argv));
        this.armQuietFlush(approvalId, pending);
        return this.answerQuietly(approvalId, once);
      }
    } else if (shell && stage && this.workspaceRoot !== "") {
      const backup = backupAction(argv, this.workspaceRoot);
      if (backup) {
        const once = findStageChoice(request.availableChoices, "once");
        if (once !== undefined) {
          if (backup.kind === "copy") {
            this.emit({
              type: "tool",
              id: `backup-${approvalId}-${this.backupSeq++}`,
              text: backedUpRow(backup.files),
              done: true,
            });
          }
          return this.answerQuietly(approvalId, once);
        }
      }
    }
    return this.askPicker(request, pending, { shell, stages, argv });
  }

  /** Answer without asking; the panel never sees this stage. */
  private answerQuietly(approvalId: string, choiceId: string): Promise<ApprovalAnswer> {
    this.emit({ type: "approvalDone", id: approvalId });
    return Promise.resolve({ choiceId });
  }

  private askPicker(
    request: ApprovalRequestParams,
    pending: PendingCommand,
    view: { shell: boolean; stages: { argv: string[] }[]; argv: string[] },
  ): Promise<ApprovalAnswer> {
    const approvalId = request.approvalId;
    // Earlier read-only stages of this command come first in the chat.
    this.flushQuiet(approvalId, pending);
    const sourceIndex = request.currentRequirementId?.sourceIndex ?? 0;
    const card = approvalCard(request.subject, request.toolName, request.rawArgs, sourceIndex);
    const hasStage = view.shell && view.argv.length > 0;
    const description = hasStage ? describeStage(view.argv) : (card.detail ?? "that");
    const prefix =
      hasStage && view.argv[0] ? view.argv[0] : (card.detail ?? "that");
    const stageLines =
      view.shell && view.stages.length > 0
        ? view.stages.map((entry) => shorten(entry.argv.join(" "), 80))
        : undefined;
    return new Promise<ApprovalAnswer>((resolve) => {
      const finish = (answer: ApprovalAnswer | undefined) => {
        this.approvalWaiters.delete(finish);
        const choiceId = answer?.choiceId ?? safestChoiceId(request.availableChoices) ?? "";
        const picked = request.availableChoices.find((choice) => choice.choiceId === choiceId);
        const memory = picked ? rememberedDecision(picked) : undefined;
        if (memory) {
          pending.decided = memory;
        }
        // Feedback only reaches a choice that takes it; the server would
        // refuse the decision otherwise.
        const takesFeedback = picked?.acceptsFeedback === true;
        const feedback = takesFeedback ? answer?.feedback?.trim() || undefined : undefined;
        const row =
          memory === "always"
            ? alwaysAllowedRow(prefix)
            : memory === "reject"
              ? rejectedRow(description, feedback)
              : allowedOnceRow(description);
        this.emit({ type: "tool", id: `approval-${approvalId}`, text: row, done: true });
        resolve(feedback === undefined ? { choiceId } : { choiceId, feedback });
        this.emit({ type: "approvalDone", id: approvalId });
      };
      this.approvalWaiters.add(finish);
      void this.options
        .askApproval({
          type: "picker",
          id: approvalId,
          kind: request.subject.kind,
          title: hasStage ? pickerTitle(view.argv) : card.title,
          ...(card.detail === undefined ? {} : { detail: card.detail }),
          ...(stageLines === undefined ? {} : { stages: stageLines }),
          // Muse's own labels, in its order; nothing invented.
          choices: request.availableChoices.map((choice) => {
            const hint = view.shell ? choiceHint(choice) : undefined;
            return {
              id: choice.choiceId,
              label: choice.label,
              isReject: isRejectChoice(choice),
              ...(hint === undefined ? {} : { hint }),
            };
          }),
        })
        .then(
          (answer) => finish(answer),
          () => finish(undefined),
        );
    });
  }

  private pendingFor(approvalId: string): PendingCommand {
    let pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      pending = { lookedAt: [], at: Date.now() };
      this.pendingApprovals.set(approvalId, pending);
    }
    pending.at = Date.now();
    return pending;
  }

  private sweepPending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.at < cutoff) {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        this.pendingApprovals.delete(id);
      }
    }
  }

  private armQuietFlush(approvalId: string, pending: PendingCommand): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      this.flushQuiet(approvalId, pending);
    }, QUIET_FLUSH_MS);
    pending.timer.unref?.();
  }

  private flushQuiet(approvalId: string, pending: PendingCommand): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    if (pending.lookedAt.length === 0) {
      return;
    }
    const labels = pending.lookedAt;
    pending.lookedAt = [];
    this.emit({
      type: "tool",
      id: `looked-${approvalId}-${this.quietSeq++}`,
      text: lookedAtRow(labels),
      done: true,
    });
  }

  private flushAllQuiet(): void {
    for (const [id, pending] of this.pendingApprovals) {
      this.flushQuiet(id, pending);
    }
  }

  private async followTurn(turn: HostTurn, state: TurnState): Promise<void> {
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
          this.emit({ type: "assistant", id: item.itemId, text, at: Date.now() });
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
        const row = toolRowText(
          {
            kind: String(item.kind),
            tool: item.tool,
            args: item.args,
            displayLabel: item.displayLabel,
            status: String(item.status),
            failureReason: item.failureReason,
            fallbackText: item.fallbackText,
            commandText: item.commandText,
          },
          // The sandbox-bug line only applies when the workaround is off.
          this.sandboxOff() || this.sandboxBugNoted,
        );
        if (row.failed && isSandboxBugFailure(item.failureReason)) {
          this.sandboxBugNoted = true;
        }
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
      this.emit({ type: "assistant", id: delta.itemId, text, at: Date.now() });
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
    this.flushAllQuiet();
    this.currentTurnId = undefined;
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
    } else if (!this.sandboxOff() && (await this.sandboxNeedsSetup())) {
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
    this.connection = undefined;
    this.currentTurnId = undefined;
    if (client) {
      void client.close().catch(() => undefined);
    }
  }
}

/**
 * The `muse serve` args: the trust flag, plus --disable-sandbox on Windows
 * while the sandbox workaround is on (Muse bug: every shell command fails in
 * serve mode). One helper so it's easy to remove the day Meta fixes it.
 */
export function serveArgs(platform: string, trustWorkspace: boolean, workaround: boolean): string[] {
  const args = ["serve"];
  if (trustWorkspace) {
    args.push("--trust-workspace");
  }
  if (platform === "win32" && workaround) {
    args.push("--disable-sandbox");
  }
  return args;
}

/**
 * The SDK connection holds ONE notification handler, and the facade client
 * claims it for session routing in its constructor — registering ours after
 * that replaces the router and starves every turn of its events (all turns
 * hang). Chain registrations instead: every handler fires, newest first, so
 * ours can never be skipped by a facade throw. Each call is guarded, so one
 * throwing handler can't stop the rest; the error goes to onError. Must run
 * before `new MuseClient` so the constructor's registration is chained too.
 */
export function chainNotifications(
  connection: HostConnection,
  onError?: (error: unknown) => void,
): void {
  const raw = connection.onNotification.bind(connection);
  const handlers: ((notification: Notification) => void)[] = [];
  connection.onNotification = (handler) => {
    handlers.push(handler);
    raw((notification) => {
      for (let index = handlers.length - 1; index >= 0; index -= 1) {
        try {
          handlers[index]?.(notification);
        } catch (error) {
          onError?.(error);
        }
      }
    });
  };
}

/** Quick / normal / deep in the server's eight-tier vocabulary. */
const EFFORT_TO_TIER: Record<EffortLevel, string> = { quick: "low", normal: "medium", deep: "high" };

/** The server's tier back to quick / normal / deep; unknown tiers are ignored. */
function effortFromTier(tier: unknown): EffortLevel | undefined {
  switch (tier) {
    case "none":
    case "minimal":
    case "low":
      return "quick";
    case "medium":
      return "normal";
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return "deep";
    default:
      return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function shorten(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Command acks carry status "accepted"; anything else is a plain failure. */
function checkAccepted(result: Record<string, unknown>): void {
  if (result.status !== "accepted") {
    throw new Error("Muse didn't take it.");
  }
}

/** Session running totals from a tokenUsage notification, when well-formed. */
function parseTokenUsage(params: Record<string, unknown>): SessionUsageTotals | undefined {
  const cumulative = asRecord(params.cumulative);
  const promptTokens = cumulative ? asNumber(cumulative.promptTokens) : undefined;
  const outputTokens = cumulative ? asNumber(cumulative.outputTokens) : undefined;
  const totalTokens = cumulative ? asNumber(cumulative.totalTokens) : undefined;
  if (promptTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  const cost = cumulative ? asRecord(cumulative.cost) : undefined;
  const usd = cost ? asNumber(cost.usd) : undefined;
  return {
    promptTokens,
    outputTokens,
    totalTokens,
    ...(usd === undefined ? {} : { usd, partial: cost?.partial === true }),
  };
}

/** One allowance slice, or undefined when the payload is malformed. */
function parseAllowanceSlice(value: unknown): AllowanceSlice | undefined {
  const record = asRecord(value);
  const usedPercent = record ? asNumber(record.usedPercent) : undefined;
  const resetsAtMs = record ? asNumber(record.resetsAtMs) : undefined;
  return usedPercent === undefined || resetsAtMs === undefined
    ? undefined
    : { usedPercent, resetsAtMs };
}

/** A goal block, null to clear, undefined when the payload is malformed. */
function parseGoal(value: unknown): GoalInfo | null | undefined {
  if (value === null) {
    return null;
  }
  const record = asRecord(value);
  const objective = record ? asString(record.objective) : undefined;
  if (!record || objective === undefined) {
    return undefined;
  }
  const currentWork = asString(record.currentWork);
  const nextWork = asString(record.nextWork);
  return {
    objective,
    percentComplete: asNumber(record.percentComplete) ?? 0,
    status: asString(record.status) ?? "active",
    ...(currentWork === undefined ? {} : { currentWork }),
    ...(nextWork === undefined ? {} : { nextWork }),
  };
}

/** Plain words for a task row; the raw command is never shown (may hold secrets). */
function taskLabel(record: Record<string, unknown>): string {
  const tool = asString(record.tool);
  if (tool) {
    return tool;
  }
  const kind = asString(record.kind) ?? "";
  const short = kind.includes(".") ? (kind.split(".").pop() ?? kind) : kind;
  return short !== "" && short !== "tool" ? short : "Background task";
}

function taskDetail(record: Record<string, unknown>): string {
  const mode = asString(record.executionMode) ?? "background";
  const started = asString(record.startedAt);
  const at = started ? new Date(started) : undefined;
  if (!at || Number.isNaN(at.getTime())) {
    return mode;
  }
  return `${mode} · started ${formatSaveTime(at)}`;
}

/** The side session's answer: its agent messages joined, in order. */
async function collectSideAnswer(
  turn: HostTurn,
  log: (message: string) => void,
  onProgress?: (line: string) => void,
): Promise<string> {
  const texts = new Map<string, string>();
  const kinds = new Set<string>();
  let answerStarted = false;
  for await (const item of turn.items()) {
    const kind = String(item.kind);
    if (!kinds.has(kind)) {
      kinds.add(kind);
      log(`side: first ${kind}`);
      if (!answerStarted && (kind === "agentMessage" || kind === "reasoning")) {
        answerStarted = true;
        onProgress?.("Reading the answer…");
      }
    }
    if (kind === "agentMessage" && typeof item.text === "string" && item.text.trim() !== "") {
      texts.set(item.itemId, item.text);
    }
  }
  const outcome = await turn.completed;
  const terminal = outcome.kind === "completed" ? outcome.params.terminal : outcome.kind;
  log(`side: terminal ${terminal}`);
  if (outcome.kind !== "completed" || outcome.params.terminal !== "completed") {
    throw new Error("The side answer didn't come back.");
  }
  const answer = [...texts.values()].join("\n\n").trim();
  if (!answer) {
    throw new Error("The side answer came back empty.");
  }
  return answer;
}
