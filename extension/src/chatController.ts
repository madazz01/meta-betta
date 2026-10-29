import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  cleanEffortLevel,
  cleanGoalInfo,
  commandErrorText,
  findSlashCommand,
  parsePluginSpec,
  parseSlashCommand,
  SLASH_COMMANDS,
  unknownCommandText,
  type AllowanceSlice,
  type CardHandlers,
  type CardSpec,
  type EffortLevel,
  type GoalInfo,
  type ModelRow,
  type PluginRow,
  type ResumeSession,
  type SkillRow,
  type SlashContext,
  type TaskRow,
} from "./commands/slash.js";
import { parseCardButton, parseCardInput, parseNudgeAnswer, parseSendMessage } from "./lib/chat.js";
import { parseFileLink } from "./lib/links.js";
import {
  buildTranscript,
  cleanTranscript,
  cleanUndos,
  dividerBefore,
  keepMessageTime,
  stampMessageTime,
  UndoReplayer,
  type ChatAssistantMessage,
  type ChatUserMessage,
  type StoredUndo,
} from "./lib/session.js";
import { shortReason } from "./lib/startup.js";
import {
  cleanDayUsage,
  formatStatusBar,
  formatStatusBarToday,
  recordDayUsage,
  sumDayUsage,
  todayKey,
  type DayUsage,
  type SessionUsageTotals,
} from "./lib/usage.js";
import {
  appendEntry,
  backupBrain,
  buildBackgroundBlock,
  catchUpGreeting,
  cleanLiveLabels,
  cleanSessionLabel,
  cleanTopic,
  continuedTopic,
  createSessionId,
  ensureBrain,
  ensureFrontDoor,
  ensureGitignoreEntry,
  formatSaveTime,
  formatSessionLabel,
  isLabelTaken,
  isStarterMe,
  LIVE_LABEL_TTL_MS,
  needsCatchUp,
  nodeBrainFs,
  splitSaveReply,
  todayLogFile,
  topicFromFirstMessage,
  UnsafeBackupError,
  welcomeName,
  withGoalLine,
  withNameLine,
  withNotInterested,
  withStartHere,
  type SaveSection,
  type SaveSections,
} from "./brain/brain.js";
import {
  QUICK_SAVE_PROMPT,
  SAVE_MY_DAY_PROMPT,
  WELCOME_MEMORY_DETAIL,
  WELCOME_MEMORY_TEXT,
  WELCOME_PROMPT,
} from "./brain/prompts.js";
import { findGitBin, formatUndoTime, NoGitError, ShadowSnapshots } from "./safety/snapshots.js";
import { singleFlight } from "./lib/singleFlight.js";
import { findMuseBin } from "./muse/resolveBin.js";
import {
  type ApprovalAnswer,
  type ApprovalCardEvent,
  MuseHost,
  type MuseHostEvent,
} from "./muse/museHost.js";

/** One attached chat surface: the editor panel or the sidebar view. */
export interface ChatSink {
  post(message: unknown): void;
}

export interface SavedSection {
  title: string;
  text: string;
}

type TranscriptEvent =
  | ChatUserMessage
  | ChatAssistantMessage
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; text: string; done: boolean }
  | ApprovalCardEvent
  | { type: "approvalDone"; id: string }
  | { type: "notice"; text: string; copy?: string; kind: "info" | "error" }
  | { type: "saved"; text: string; backup?: string; sections: SavedSection[] }
  | { type: "undo"; id: string; label: string }
  | { type: "undoDone"; id: string; state: "undone" | "ready" | "gone" }
  | { type: "memory"; text: string; detail: string }
  | { type: "day"; label: string }
  | { type: "nudgeAnswered"; id: string; answer: "show" | "notnow" }
  | { type: "card"; id: string; title: string; body: string; buttons?: CardSpec["buttons"]; input?: CardSpec["input"] }
  | { type: "cardDone"; id: string };

const HISTORY_LIMIT = 500;
const SESSION_ID_KEY = "metaBetta.sessionId";
const SESSION_LABEL_KEY = "metaBetta.sessionLabel";
const TRANSCRIPT_KEY = "metaBetta.transcript";
const LAST_MESSAGE_KEY = "metaBetta.lastMessageAt";
const LIVE_LABELS_KEY = "metaBetta.liveLabels";
const UNDOS_KEY = "metaBetta.undos";
const WELCOMED_KEY = "metaBetta.welcomed";
const GOAL_KEY = "metaBetta.goal";
const EFFORT_KEY = "metaBetta.effort";
const DAILY_USAGE_KEY = "metaBetta.dailyUsage";
const SHELL_NOTICE_KEY = "metaBetta.shellNoticeShown";
/** Heartbeat + quick-save check, every 10 seconds. */
const TICK_MS = 10_000;
/** A quick save also fires after this many turns, whatever the clock says. */
const QUICK_SAVE_TURNS = 15;

const SAVE_TITLES: Record<SaveSection, string> = {
  project: "Project",
  log: "Today's log",
  tricks: "Tricks",
  "good-for": "Good for",
  me: "About you",
};

interface SaveRun {
  quick: boolean;
  texts: Map<string, string>;
  failed: boolean;
  stopped: boolean;
  cancelled: boolean;
  label: string;
}

/**
 * Owns the Muse session and the chat history. Every attached surface shows
 * the same chat; a surface that (re)binds gets the history replayed.
 */
export class ChatController {
  private sinks = new Set<ChatSink>();
  private history: TranscriptEvent[] = [];
  private running = false;
  private lastStatus = "";
  private host?: MuseHost;
  private prepared = false;
  private preparing: Promise<void> | undefined;
  private memoryAnnounced = false;
  private memoryOn = false;
  private liveReplySeen = false;
  private forceCatchUp = false;
  private sessionId = createSessionId();
  private sessionTopic = "";
  private labelSettled = false;
  /** A second window on this folder: own id, never overwrites the stored label. */
  private diverged = false;
  private saveRun: SaveRun | undefined;
  private pendingSave: "full" | undefined;
  private turnsSinceSave = 0;
  private lastSaveAt = Date.now();
  private pendingBefore: { sha: string; at: number; excluded: string[] } | undefined;
  private undos = new Map<string, StoredUndo>();
  private undoCounter = 0;
  private anchorHigh = 0;
  private museSessionId: string | undefined;
  private replaying = false;
  private replayer: UndoReplayer | undefined;
  private headerUndoSeq = 0;
  private welcomeStep: "hello" | "project" | "memory" | undefined;
  private welcomeHeard = false;
  private gitNoticeShown = false;
  private gitBinCache: string | undefined;
  private shadowCache: { folder: string; bin: string; shadow: ShadowSnapshots } | undefined;
  private readonly tickTimer: ReturnType<typeof setInterval>;
  private approvalResolvers = new Map<string, (answer: ApprovalAnswer | undefined) => void>();
  /** True once the host runs with the Windows sandbox off (workaround on). */
  private shellWorkaround = false;
  private cardCounter = 0;
  private cardHandlers = new Map<string, CardHandlers>();
  private lastUsage: SessionUsageTotals | undefined;
  private lastGoal: GoalInfo | null = null;
  private lastEffort: EffortLevel = "normal";
  private switching = false;
  private readonly createHostShared = singleFlight((folder: vscode.WorkspaceFolder) =>
    this.createHostAsync(folder),
  );

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: vscode.Memento,
    private readonly onBrainChanged: (files: string[]) => void = () => undefined,
    private readonly storageDir: string | undefined = undefined,
    private readonly logFn: (message: string) => void = () => undefined,
    private readonly onWelcomeOutline: () => void = () => undefined,
    private readonly updateStatusBar: (text: string) => void = () => undefined,
    private readonly globalState: vscode.Memento | undefined = undefined,
  ) {
    this.lastGoal = cleanGoalInfo(this.storage.get<unknown>(GOAL_KEY));
    this.lastEffort = cleanEffortLevel(this.storage.get<unknown>(EFFORT_KEY));
    const storedToday = sumDayUsage(
      cleanDayUsage(this.globalState?.get<unknown>(DAILY_USAGE_KEY)),
      todayKey(),
    );
    this.updateStatusBar(formatStatusBarToday(storedToday.totalTokens));
    this.heartbeat();
    this.tickTimer = setInterval(() => {
      this.heartbeat();
      this.maybeQuickSave();
    }, TICK_MS);
    this.tickTimer.unref?.();
  }

  public bind(sink: ChatSink): void {
    this.adoptStoredLabel();
    this.sinks.add(sink);
    for (const event of this.history) {
      sink.post(event);
    }
    sink.post({ type: "turn", state: this.running ? "started" : "done" });
    sink.post({ type: "status", text: this.lastStatus });
    sink.post({ type: "sessionLabel", label: this.sessionLabel() });
    sink.post({ type: "welcomeSkip", show: this.welcomeStep !== undefined });
    sink.post({
      type: "slashCommands",
      commands: SLASH_COMMANDS.map((def) => ({ name: def.name, description: def.description })),
    });
    sink.post({ type: "goal", goal: this.lastGoal });
    sink.post({ type: "effort", level: this.lastEffort });
    void this.updateHeaderUndo();
    if (!vscode.workspace.workspaceFolders?.[0]) {
      sink.post({ type: "noFolder" });
    }
    void this.prepare();
  }

  /** Re-check the no-folder card when the open folders change. */
  public refreshFolder(): void {
    this.broadcast({ type: vscode.workspace.workspaceFolders?.[0] ? "hideNoFolder" : "noFolder" });
  }

  public async openFolder(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.files.openFolder");
  }

  public async renameSession(): Promise<void> {
    const topic = await vscode.window.showInputBox({
      title: "Name this chat",
      value: this.sessionTopic,
      prompt: "A short topic for this chat, shown in the header.",
    });
    if (topic === undefined) {
      return;
    }
    this.sessionTopic = cleanTopic(topic);
    this.persistSessionLabel();
    this.broadcastSessionLabel();
  }

  /** VS Code just granted workspace trust: switch memory on. */
  public async trustGranted(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    if (!vscode.workspace.getConfiguration("metaBetta").get<boolean>("memory", true)) {
      return;
    }
    if (this.host) {
      await this.host.dispose();
      this.host = undefined;
      this.running = false;
      this.broadcast({ type: "turn", state: "done" });
      this.broadcast({ type: "status", text: "Ready" });
    }
    this.memoryAnnounced = false;
    await this.ensureMemory(folder);
    // Trust granted mid-session is first setup too.
    void this.maybeWelcome(folder);
  }

  public unbind(sink: ChatSink): void {
    this.sinks.delete(sink);
    if (this.sinks.size === 0) {
      // No panel can ask, so pending approvals take the safest choice.
      for (const resolve of this.approvalResolvers.values()) {
        resolve(undefined);
      }
      this.approvalResolvers.clear();
    }
  }

  public async send(text: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.broadcast({ type: "noFolder" });
      return;
    }
    // History first, so yesterday's messages stay above a fresh reply.
    await this.prepare();

    const slash = parseSlashCommand(text);
    if (slash) {
      this.recordAndBroadcast({ type: "user", text, at: Date.now() });
      this.storeSet(LAST_MESSAGE_KEY, Date.now());
      await this.dispatchSlash(slash.name, slash.args);
      return;
    }

    // "continue working on X" always starts a newly labelled episode, even
    // mid-conversation; any other first message just names the topic.
    const continued = continuedTopic(text);
    if (continued !== undefined) {
      this.sessionId = createSessionId();
      this.sessionTopic = continued;
      this.persistSessionLabel();
      this.broadcastSessionLabel();
    } else if (!this.sessionTopic && !this.welcomeStep) {
      // During the welcome the topic comes from the project answer instead.
      const topic = topicFromFirstMessage(text);
      if (topic) {
        this.sessionTopic = topic;
        this.persistSessionLabel();
        this.broadcastSessionLabel();
      }
    }
    let host: MuseHost;
    try {
      host = await this.ensureHost(folder);
    } catch (error) {
      this.broadcast({
        type: "notice",
        kind: "error",
        text: `Something went wrong: ${shortReason(error)}.`,
      });
      return;
    }
    if (this.welcomeStep && /^\s*skip(\s+this|\s+for\s+now)?\s*[.?]?\s*$/i.test(text)) {
      this.skipWelcome();
      return;
    }
    // Recorded only once the turn will actually run: a failed send never
    // reaches the server, and a ghost user message would skew the undo
    // anchors on resume.
    this.recordAndBroadcast({ type: "user", text, at: Date.now() });
    this.storeSet(LAST_MESSAGE_KEY, Date.now());
    if (this.welcomeStep === "hello" && !this.welcomeHeard) {
      // The hello never arrived (failed or stopped): cancel rather than
      // filing guesses. A reload tries the welcome again.
      this.welcomeStep = undefined;
      this.broadcast({ type: "welcomeSkip", show: false });
    } else if (this.welcomeStep === "hello") {
      await this.fileWelcomeName(folder, text);
      this.welcomeStep = "project";
    } else if (this.welcomeStep === "project") {
      await this.fileWelcomeProject(folder, text);
      if (!this.sessionTopic) {
        const topic = topicFromFirstMessage(text);
        if (topic) {
          this.sessionTopic = topic;
          this.persistSessionLabel();
          this.broadcastSessionLabel();
        }
      }
      this.welcomeStep = "memory";
    }
    this.pendingBefore = await this.takeBeforeSnapshot(folder);
    await host.send(await this.withBackground(folder, text), folder.uri.fsPath);
  }

  /**
   * The welcome, first run in a workspace: Muse asks the name, then the
   * project. The extension files both answers itself; Muse just chats.
   */
  private async maybeWelcome(folder: vscode.WorkspaceFolder): Promise<void> {
    // A finished welcome never repeats (even nameless); a skip tries again.
    if (!this.memoryOn || this.welcomeStep || this.storage.get<boolean>(WELCOMED_KEY)) {
      return;
    }
    let me: string | undefined;
    try {
      me = await nodeBrainFs.readFile(path.join(folder.uri.fsPath, "brain", "me.md"));
    } catch {
      me = undefined;
    }
    if (!isStarterMe(me)) {
      return;
    }
    this.welcomeStep = "hello";
    this.welcomeHeard = false;
    this.broadcast({ type: "welcomeSkip", show: true });
    const host = await this.ensureHost(folder);
    await host.send(WELCOME_PROMPT, folder.uri.fsPath);
  }

  public skipWelcome(): void {
    if (!this.welcomeStep) {
      return;
    }
    this.welcomeStep = undefined;
    this.broadcast({ type: "welcomeSkip", show: false });
    this.recordAndBroadcast({ type: "notice", kind: "info", text: "Skipped for now — what's first?" });
  }

  /**
   * A nudge card button: record the answer once, file a decline in me.md,
   * then send the answer back as the user's reply.
   */
  public async answerNudge(id: string, answer: "show" | "notnow", thing: string): Promise<void> {
    if (this.history.some((entry) => entry.type === "nudgeAnswered" && entry.id === id)) {
      return;
    }
    this.recordAndBroadcast({ type: "nudgeAnswered", id, answer });
    if (answer === "notnow" && thing.trim() !== "") {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) {
        try {
          const target = path.join(folder.uri.fsPath, "brain", "me.md");
          const content = await nodeBrainFs.readFile(target).catch(() => "");
          await nodeBrainFs.writeFile(target, withNotInterested(content, thing));
        } catch {
          // The card still answers; me.md stays editable.
        }
      }
    }
    await this.send(answer === "show" ? "Show me" : "Not now");
  }

  /** Run a slash command by name (no echo; send() echoes typed commands). */
  public async dispatchSlash(name: string, args: string): Promise<void> {
    const def = findSlashCommand(name);
    if (!def) {
      this.recordAndBroadcast({ type: "notice", kind: "info", text: unknownCommandText(name) });
      return;
    }
    try {
      await def.run(this.slashContext(), args);
    } catch (error) {
      this.recordAndBroadcast({
        type: "notice",
        kind: "error",
        text: `That didn't work: ${shortReason(error)}.`,
      });
    }
  }

  /** The live side of SlashContext: cards, chats, and Muse calls. */
  private slashContext(): SlashContext {
    return {
      showCard: (card, handlers) => this.showCard(card, handlers),
      updateCard: (id, card) => this.updateCard(id, card),
      closeCard: (id) => this.closeCard(id),
      notice: (kind, text) => this.recordAndBroadcast({ type: "notice", kind, text }),
      newChat: () => this.newChat(),
      saveMyDay: () => this.saveMyDay(),
      stop: () => this.stop(),
      clearView: () => this.clearView(),
      focusBrain: () => this.focusBrain(),
      exportHistory: () => this.exportHistory(),
      listSessions: () => this.slashListSessions(),
      switchToSession: (id) => this.switchToSession(id),
      readUsage: () => this.slashReadUsage(),
      listModels: () => this.slashListModels(),
      setModel: (modelId) => this.slashSetModel(modelId),
      compact: () => this.slashCompact(),
      recap: () => this.slashRecap(),
      goal: (op, text) => this.slashGoal(op, text),
      currentGoal: () => this.lastGoal,
      sideAsk: (question, onProgress) => this.slashSideAsk(question, onProgress),
      fork: () => this.slashFork(),
      listTasks: () => this.slashListTasks(),
      stopTask: (taskId) => this.slashStopTask(taskId),
      stopAllTasks: () => this.slashStopAllTasks(),
      listSkills: () => this.slashListSkills(),
      setSkill: (selector, on) => this.slashSetSkill(selector, on),
      listPlugins: () => this.slashListPlugins(),
      installPlugin: (spec) => this.slashInstallPlugin(spec),
      setEffort: (level) => this.slashSetEffort(level),
      currentEffort: () => this.lastEffort,
    };
  }

  /** The live host for a slash command, or a plain throw when none. */
  private async slashHost(): Promise<{ host: MuseHost; root: string }> {
    await this.prepare();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("Open a folder first.");
    }
    return { host: await this.ensureHost(folder), root: folder.uri.fsPath };
  }

  private showCard(card: CardSpec, handlers?: CardHandlers): string {
    this.cardCounter += 1;
    const id = `card-${this.cardCounter}`;
    if (handlers) {
      this.cardHandlers.set(id, handlers);
    }
    this.recordAndBroadcast({
      type: "card",
      id,
      title: card.title,
      body: card.body,
      ...(card.buttons ? { buttons: card.buttons } : {}),
      ...(card.input ? { input: card.input } : {}),
    });
    return id;
  }

  private updateCard(id: string, card: CardSpec): void {
    this.recordAndBroadcast({
      type: "card",
      id,
      title: card.title,
      body: card.body,
      ...(card.buttons ? { buttons: card.buttons } : {}),
      ...(card.input ? { input: card.input } : {}),
    });
  }

  private closeCard(id: string): void {
    this.cardHandlers.delete(id);
    this.recordAndBroadcast({ type: "cardDone", id });
  }

  public onCardButton(cardId: string, buttonId: string): void {
    void this.cardHandlers.get(cardId)?.onButton?.(buttonId);
  }

  public onCardInput(cardId: string, text: string): void {
    if (text.trim() === "") {
      return;
    }
    void this.cardHandlers.get(cardId)?.onInput?.(text);
  }

  private async slashListSessions(): Promise<ResumeSession[]> {
    const { host, root } = await this.slashHost();
    return host.listSessions(root);
  }

  /**
   * Switch the panel to another saved chat: clear the view, resume it,
   * replay its history as a fresh episode. The old chat stays saved.
   */
  public async switchToSession(id: string): Promise<void> {
    if (id === this.museSessionId || this.switching) {
      return;
    }
    const { host, root } = await this.slashHost();
    this.switching = true;
    if (this.saveRun) {
      this.saveRun.cancelled = true;
    }
    this.pendingSave = undefined;
    this.pendingBefore = undefined;
    this.welcomeStep = undefined;
    this.broadcast({ type: "welcomeSkip", show: false });
    this.history = [];
    this.broadcast({ type: "clear" });
    this.running = true;
    this.broadcast({ type: "turn", state: "started" });
    this.setStatus("Switching chats…");
    this.replaying = true;
    this.replayer = new UndoReplayer([...this.undos.values()], id);
    try {
      const shown = await host.switchSession(id, root);
      this.log(`Switched: server history (${shown} events)`);
    } catch (error) {
      this.replaying = false;
      this.replayer = undefined;
      this.running = false;
      this.broadcast({ type: "turn", state: "done" });
      this.setStatus("Ready");
      this.recordAndBroadcast({
        type: "notice",
        kind: "error",
        text: `Couldn't switch chats: ${commandErrorText(error)}.`,
      });
      // The old session is still saved; bring its view back.
      this.prepared = false;
      await this.prepare();
      this.switching = false;
      return;
    }
    for (const uid of this.replayer.finish()) {
      this.emitReplayedUndo(uid);
    }
    this.replaying = false;
    this.replayer = undefined;
    this.storeSet(TRANSCRIPT_KEY, undefined);
    this.storeSet(LAST_MESSAGE_KEY, undefined);
    this.anchorHigh = 0;
    this.forceCatchUp = true;
    this.liveReplySeen = false;
    this.sessionId = createSessionId();
    this.sessionTopic = "";
    this.persistSessionLabel();
    this.broadcastSessionLabel();
    this.lastUsage = undefined;
    this.updateStatusBar(formatStatusBar(undefined));
    this.running = false;
    this.broadcast({ type: "turn", state: "done" });
    this.setStatus("Ready");
    this.switching = false;
  }

  private async slashReadUsage(): Promise<{
    session?: SessionUsageTotals;
    today: { totalTokens: number; usd: number };
    weekly?: AllowanceSlice;
    window?: AllowanceSlice;
  }> {
    const { host, root } = await this.slashHost();
    const allowance = await host
      .readSubscription(root)
      .catch(() => ({} as { weekly?: AllowanceSlice; window?: AllowanceSlice }));
    const today = sumDayUsage(cleanDayUsage(this.globalState?.get<unknown>(DAILY_USAGE_KEY)), todayKey());
    return { session: this.lastUsage, today, ...allowance };
  }

  /** A usage notification: status bar now, today's sums for later. */
  private recordUsage(usage: SessionUsageTotals): void {
    this.lastUsage = usage;
    const prev: DayUsage | undefined = cleanDayUsage(this.globalState?.get<unknown>(DAILY_USAGE_KEY));
    void this.globalState?.update(
      DAILY_USAGE_KEY,
      recordDayUsage(prev, todayKey(), this.museSessionId ?? "unknown", usage),
    );
    this.updateStatusBar(formatStatusBar(usage));
  }

  private async slashListModels(): Promise<ModelRow[]> {
    const { host, root } = await this.slashHost();
    return host.listModels(root);
  }

  private async slashSetModel(modelId: string): Promise<void> {
    const { host, root } = await this.slashHost();
    await host.setModel(root, modelId);
  }

  private async slashCompact(): Promise<"compacted" | "noop"> {
    const { host, root } = await this.slashHost();
    return host.compact(root);
  }

  private async slashRecap(): Promise<{ text: string; title?: string }> {
    const { host, root } = await this.slashHost();
    return host.recap(root);
  }

  private async slashGoal(op: "set" | "edit" | "pause" | "resume" | "clear", text?: string): Promise<void> {
    const { host, root } = await this.slashHost();
    await host.goalCommand(root, op, text);
  }

  private async slashSideAsk(question: string, onProgress?: (line: string) => void): Promise<string> {
    const { host, root } = await this.slashHost();
    return host.sideAsk(root, question, onProgress);
  }

  private async slashFork(): Promise<void> {
    const { host, root } = await this.slashHost();
    await this.switchToSession(await host.forkSession(root));
  }

  private async slashListTasks(): Promise<TaskRow[]> {
    const { host, root } = await this.slashHost();
    return host.listTasks(root);
  }

  private async slashStopTask(taskId: string): Promise<void> {
    const { host, root } = await this.slashHost();
    await host.stopTask(root, taskId);
  }

  private async slashStopAllTasks(): Promise<void> {
    const { host, root } = await this.slashHost();
    await host.stopAllTasks(root);
  }

  private async slashListSkills(): Promise<SkillRow[]> {
    const { host, root } = await this.slashHost();
    return host.listSkills(root);
  }

  private async slashSetSkill(selector: string, on: boolean): Promise<void> {
    const { host, root } = await this.slashHost();
    await host.setSkill(root, selector, on);
  }

  private async slashListPlugins(): Promise<PluginRow[]> {
    const { host, root } = await this.slashHost();
    return host.listPlugins(root);
  }

  private async slashInstallPlugin(spec: string): Promise<string> {
    const { host, root } = await this.slashHost();
    const parsed = parsePluginSpec(spec);
    if (!parsed) {
      throw new Error("Tell me the plugin as store:name, or a folder path.");
    }
    const installed = await host.installPlugin(
      root,
      parsed.kind === "path" ? { path: parsed.path } : { marketplace: parsed.marketplace, name: parsed.name },
    );
    const label =
      installed.id !== ""
        ? installed.id
        : parsed.kind === "path"
          ? (parsed.path.split(/[\\/]/).pop() ?? parsed.path)
          : parsed.name;
    return `Installed ${label} v${installed.version}.${installed.advisory ? ` ${installed.advisory}` : ""}`;
  }

  private async slashSetEffort(level: EffortLevel): Promise<void> {
    const { host, root } = await this.slashHost();
    await host.setEffort(root, level);
    this.lastEffort = level;
    this.storeSet(EFFORT_KEY, level);
    this.broadcast({ type: "effort", level });
  }

  /** The 🎯 chip: ask for the goal, then pin it. */
  public async askGoal(): Promise<void> {
    const text = await vscode.window.showInputBox({
      title: "Goal for this chat",
      value: this.lastGoal?.objective ?? "",
      prompt: "What are we working toward? The pin shows it with a progress bar.",
    });
    if (text === undefined || text.trim() === "") {
      return;
    }
    try {
      await this.slashContext().goal("set", text.trim());
      this.recordAndBroadcast({ type: "notice", kind: "info", text: "Goal pinned." });
    } catch (error) {
      this.recordAndBroadcast({
        type: "notice",
        kind: "error",
        text: `Couldn't pin the goal: ${commandErrorText(error)}.`,
      });
    }
  }

  /** The ⚡ chip: quick → normal → deep, round and round. */
  public async cycleEffort(): Promise<void> {
    const order: EffortLevel[] = ["quick", "normal", "deep"];
    const next = order[(order.indexOf(this.lastEffort) + 1) % order.length] ?? "normal";
    try {
      await this.slashContext().setEffort(next);
    } catch (error) {
      this.recordAndBroadcast({
        type: "notice",
        kind: "error",
        text: `Couldn't set the effort: ${commandErrorText(error)}.`,
      });
    }
  }

  /** Clear the panel view: the chat, undos and brain all stay. */
  public clearView(): void {
    this.history = [];
    this.storeSet(TRANSCRIPT_KEY, undefined);
    this.broadcast({ type: "clear" });
    this.broadcast({ type: "turn", state: "done" });
    this.setStatus("Ready");
  }

  /** Focus the Brain view and open the project notes. */
  public async focusBrain(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.broadcast({ type: "noFolder" });
      return;
    }
    try {
      await vscode.commands.executeCommand("metaBetta.brain.focus");
    } catch {
      // The file below still opens.
    }
    try {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(folder.uri, "brain", "project.md"),
      );
      await vscode.window.showTextDocument(doc);
    } catch {
      this.recordAndBroadcast({ type: "notice", kind: "error", text: "Couldn't open brain/project.md." });
    }
  }

  /** Save the visible conversation to a Markdown file; undefined on cancel. */
  public async exportHistory(): Promise<string | undefined> {
    const lines = [`# Meta Betta chat — ${this.sessionLabel()}`, ""];
    let messages = 0;
    for (const entry of this.history) {
      if (entry.type === "day") {
        lines.push(`## ${entry.label}`, "");
      } else if (entry.type === "user" || entry.type === "assistant") {
        messages += 1;
        const when = entry.time ? ` (${entry.time})` : "";
        lines.push(`**${entry.type === "user" ? "You" : "Muse"}**${when}`, entry.text, "");
      }
    }
    if (messages === 0) {
      this.recordAndBroadcast({ type: "notice", kind: "info", text: "Nothing to save yet." });
      return undefined;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const uri = await vscode.window.showSaveDialog({
      defaultUri: folder
        ? vscode.Uri.joinPath(folder.uri, `meta-betta-chat-${todayKey()}.md`)
        : undefined,
      filters: { Markdown: ["md"] },
      saveLabel: "Save chat",
    });
    if (!uri) {
      return undefined;
    }
    await writeFile(uri.fsPath, `${lines.join("\n").trimEnd()}\n`, "utf8");
    return uri.fsPath;
  }

  private async fileWelcomeName(folder: vscode.WorkspaceFolder, text: string): Promise<void> {
    const name = welcomeName(text);
    if (!name) {
      return;
    }
    try {
      const target = path.join(folder.uri.fsPath, "brain", "me.md");
      const content = await nodeBrainFs.readFile(target).catch(() => "");
      await nodeBrainFs.writeFile(target, withNameLine(content, name));
    } catch {
      // The welcome carries on without it; me.md stays editable.
    }
  }

  private async fileWelcomeProject(folder: vscode.WorkspaceFolder, text: string): Promise<void> {
    if (text.trim() === "") {
      return;
    }
    try {
      const target = path.join(folder.uri.fsPath, "brain", "project.md");
      const content = await nodeBrainFs.readFile(target).catch(() => "");
      await nodeBrainFs.writeFile(target, withStartHere(content, text));
    } catch {
      // The welcome carries on without it; project.md stays editable.
    }
  }

  /** The memory message, the tour outlines, and "What's first?". */
  private finishWelcome(): void {
    this.welcomeStep = undefined;
    this.storeSet(WELCOMED_KEY, true);
    this.broadcast({ type: "welcomeSkip", show: false });
    this.recordAndBroadcast({ type: "memory", text: WELCOME_MEMORY_TEXT, detail: WELCOME_MEMORY_DETAIL });
    this.recordAndBroadcast({ type: "assistant", id: "welcome-next", text: "What's first?", at: Date.now() });
    this.onWelcomeOutline();
  }

  /**
   * On the first send before any live reply (memory on), read the brain and
   * attach it as background, showing a friendly placeholder meanwhile.
   */
  private async withBackground(folder: vscode.WorkspaceFolder, text: string): Promise<string> {
    if (!this.memoryOn || this.liveReplySeen || this.welcomeStep) {
      return text;
    }
    if (this.forceCatchUp) {
      this.forceCatchUp = false;
    } else {
      const afterHours = vscode.workspace.getConfiguration("metaBetta").get<number>("catchUpAfterHours", 4);
      if (!needsCatchUp(this.storage.get<number>(LAST_MESSAGE_KEY), Date.now(), afterHours)) {
        return text;
      }
    }
    const root = folder.uri.fsPath;
    const [me, project, tricks, todayLog] = await Promise.all([
      nodeBrainFs.readFile(path.join(root, "brain", "me.md")).catch(() => undefined),
      nodeBrainFs.readFile(path.join(root, "brain", "project.md")).catch(() => undefined),
      nodeBrainFs.readFile(path.join(root, "brain", "tricks.md")).catch(() => undefined),
      nodeBrainFs.readFile(path.join(root, "brain", todayLogFile())).catch(() => undefined),
    ]);
    const background = buildBackgroundBlock({ me, project, tricks, todayLog });
    if (!background) {
      return text;
    }
    this.broadcast({ type: "catchingUp", text: catchUpGreeting(new Date(), me) });
    return `${background}\n\n${text}`;
  }

  public stop(): void {
    void this.host?.stop();
  }

  /** Ask Muse what happened, then file the reply into brain/ ourselves. */
  public async saveMyDay(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.broadcast({ type: "noFolder" });
      return;
    }
    // History first, so yesterday's messages stay above a fresh reply.
    await this.prepare();
    if (!this.memoryOn) {
      this.broadcast({
        type: "notice",
        kind: "info",
        text: "Memory is off, so there's nowhere to save. Turn it on with the Meta Betta › Memory setting.",
      });
      return;
    }
    if (this.running || this.saveRun) {
      this.pendingSave = "full";
      this.broadcast({ type: "notice", kind: "info", text: "I'll save as soon as this reply finishes." });
      return;
    }
    await this.runSave(folder, false);
  }

  private async runSave(folder: vscode.WorkspaceFolder, quick: boolean): Promise<void> {
    // Claimed up front: the timer and turn-done both check, and must not
    // start a second save while the host is still starting.
    this.saveRun = {
      quick,
      texts: new Map(),
      failed: false,
      stopped: false,
      cancelled: false,
      label: this.sessionLabel(),
    };
    this.turnsSinceSave = 0;
    this.lastSaveAt = Date.now();
    this.setStatus(quick ? "Saving…" : "Saving your day…");
    let host: MuseHost;
    try {
      host = await this.ensureHost(folder);
    } catch (error) {
      this.saveRun = undefined;
      this.broadcast({
        type: "notice",
        kind: "error",
        text: `Couldn't save: ${shortReason(error)}.`,
      });
      this.setStatus("Ready");
      return;
    }
    await host.send(quick ? QUICK_SAVE_PROMPT : SAVE_MY_DAY_PROMPT, folder.uri.fsPath);
    await this.finalizeSave(folder, quick);
  }

  private async finalizeSave(folder: vscode.WorkspaceFolder, quick: boolean): Promise<void> {
    const save = this.saveRun;
    this.saveRun = undefined;
    if (!save || save.cancelled) {
      return;
    }
    if (save.stopped) {
      if (quick) {
        this.setStatus("Ready");
      } else {
        this.recordAndBroadcast({
          type: "notice",
          kind: "info",
          text: "Save stopped — nothing was written.",
        });
        this.setStatus("Ready");
      }
      return;
    }
    if (save.failed) {
      // The error notice was already shown; just reset the status.
      this.setStatus("Ready");
      return;
    }
    const sections = splitSaveReply([...save.texts.values()].join("\n\n"));
    const files = await this.appendSaveSections(folder, sections, save.label);
    if (files.length === 0) {
      if (Object.keys(sections).length === 0) {
        if (!quick) {
          this.recordAndBroadcast({ type: "notice", kind: "info", text: "Nothing new to save." });
        }
      } else {
        this.recordAndBroadcast({
          type: "notice",
          kind: "error",
          text: "Couldn't write to the brain.",
        });
      }
      this.setStatus("Ready");
      return;
    }
    this.onBrainChanged(files);
    const backup = await this.backup(folder);
    if (quick) {
      let status = `Saved ✓ ${formatSaveTime(new Date())}`;
      if (backup === "ok") {
        status += " · Backed up ✓";
      } else if (backup === "missing") {
        status += " · backup folder missing";
      } else if (backup === "unsafe") {
        status += " · backup folder must be outside this folder";
      }
      this.setStatus(status);
      return;
    }
    this.recordAndBroadcast({
      type: "saved",
      text: "Saved ✓ — see you tomorrow",
      backup:
        backup === "ok"
          ? "Backed up ✓"
          : backup === "missing"
            ? "Couldn't reach the backup folder — this save stayed on this computer."
            : backup === "unsafe"
              ? "The backup folder must be outside this folder — this save stayed on this computer."
              : undefined,
      sections: savedSections(sections),
    });
    this.setStatus("Ready");
    this.offerGitCommit(folder);
  }

  /** Append each save section to its brain file; returns the files written. */
  private async appendSaveSections(
    folder: vscode.WorkspaceFolder,
    sections: SaveSections,
    label: string,
  ): Promise<string[]> {
    const root = folder.uri.fsPath;
    const now = new Date();
    const entries: { file: string; text: string }[] = [];
    if (sections.project) {
      entries.push({
        file: "project.md",
        text: this.lastGoal
          ? withGoalLine(sections.project, this.lastGoal.objective, this.lastGoal.percentComplete)
          : sections.project,
      });
    }
    if (sections.log) {
      entries.push({ file: todayLogFile(now), text: sections.log });
    }
    if (sections.tricks) {
      entries.push({ file: "tricks.md", text: sections.tricks });
    }
    if (sections["good-for"]) {
      entries.push({ file: "good-for.md", text: sections["good-for"] });
    }
    if (sections.me) {
      entries.push({ file: "me.md", text: sections.me });
    }
    if (entries.length === 0) {
      return [];
    }
    await ensureBrain(root);
    const written: string[] = [];
    for (const { file, text } of entries) {
      try {
        await appendEntry(root, file, label, text, nodeBrainFs, now);
        written.push(file);
      } catch {
        // One failed file shouldn't sink the others.
      }
    }
    return written;
  }

  private async backup(folder: vscode.WorkspaceFolder): Promise<"off" | "ok" | "missing" | "unsafe"> {
    const backupFolder = vscode.workspace.getConfiguration("metaBetta").get<string>("backupFolder", "").trim();
    if (!backupFolder) {
      return "off";
    }
    try {
      await backupBrain(folder.uri.fsPath, backupFolder);
      return "ok";
    } catch (error) {
      return error instanceof UnsafeBackupError ? "unsafe" : "missing";
    }
  }

  /** After a manual save in a git repo, offer to commit the brain. Never pushes. */
  private offerGitCommit(folder: vscode.WorkspaceFolder): void {
    const root = folder.uri.fsPath;
    execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root }, (error, stdout) => {
      if (error || stdout.trim() !== "true") {
        return;
      }
      void vscode.window.showInformationMessage("Also commit the brain?", "Commit brain").then((choice) => {
        if (choice !== "Commit brain") {
          return;
        }
        execFile("git", ["add", "brain"], { cwd: root }, (addError) => {
          if (addError) {
            this.broadcast({ type: "notice", kind: "error", text: "Couldn't commit the brain." });
            return;
          }
          const date = todayLogFile().slice("log/".length, -".md".length);
          execFile("git", ["commit", "-m", `Save my day ${date}`], { cwd: root }, (commitError) => {
            if (commitError) {
              const alreadyDone = String(commitError.message).includes("nothing to commit");
              this.broadcast({
                type: "notice",
                kind: alreadyDone ? "info" : "error",
                text: alreadyDone ? "Already committed — nothing new." : "Couldn't commit the brain.",
              });
              return;
            }
            this.broadcast({ type: "notice", kind: "info", text: "Brain committed." });
          });
        });
      });
    });
  }

  /** A quiet quick save when one is due. Never starts one mid-turn. */
  private maybeQuickSave(): void {
    const minutes = vscode.workspace.getConfiguration("metaBetta").get<number>("autoSaveMinutes", 45);
    if (!minutes || minutes <= 0 || !this.memoryOn) {
      return;
    }
    if (this.running || this.saveRun || this.pendingSave) {
      return;
    }
    if (this.turnsSinceSave === 0) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    const oldEnough = Date.now() - this.lastSaveAt >= minutes * 60_000;
    if (this.turnsSinceSave < QUICK_SAVE_TURNS && !oldEnough) {
      return;
    }
    void this.runSave(folder, true);
  }

  private setStatus(text: string): void {
    this.lastStatus = text;
    this.broadcast({ type: "status", text });
  }

  /** One line to the Meta Betta output channel (startup/resume diagnosis). */
  private log(message: string): void {
    this.logFn(message);
  }

  /** Put back the files one reply changed, after a confirm listing them. */
  public async undo(id: string): Promise<void> {
    const target = this.undos.get(id);
    if (!target) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    let shadow: ShadowSnapshots | undefined;
    try {
      shadow = folder ? await this.shadowFor(folder) : undefined;
    } catch (error) {
      this.snapshotFailed(error, "Couldn't undo that.");
      this.recordAndBroadcast({ type: "undoDone", id, state: "ready" });
      return;
    }
    if (!shadow) {
      this.recordAndBroadcast({ type: "notice", kind: "info", text: "Couldn't undo that." });
      this.recordAndBroadcast({ type: "undoDone", id, state: "ready" });
      return;
    }
    let changed: string[];
    try {
      const [beforeKept, afterKept] = await Promise.all([shadow.has(target.before), shadow.has(target.after)]);
      if (!beforeKept || !afterKept) {
        this.recordAndBroadcast({ type: "notice", kind: "info", text: "That change is too old to undo." });
        this.recordAndBroadcast({ type: "undoDone", id, state: "gone" });
        void this.updateHeaderUndo();
        return;
      }
      changed = await shadow.changedSince(target.files, target.after);
    } catch (error) {
      this.snapshotFailed(error, "Couldn't undo that.");
      this.recordAndBroadcast({ type: "undoDone", id, state: "ready" });
      return;
    }
    const lines = target.files.slice(0, 10).map((file) => {
      const mark = changed.includes(file.path) ? " (changed since)" : "";
      return `- ${file.path}${mark}`;
    });
    if (target.files.length > 10) {
      lines.push(`…and ${target.files.length - 10} more`);
    }
    const time = formatUndoTime(new Date(target.at));
    const choice = await vscode.window.showInformationMessage(
      `Put back ${countFiles(target.files.length)} as they were at ${time}?`,
      { detail: lines.join("\n"), modal: false },
      "Undo these files",
    );
    if (choice !== "Undo these files") {
      this.recordAndBroadcast({ type: "undoDone", id, state: "ready" });
      return;
    }
    try {
      const { restored, failed } = await shadow.restore(target.files, target.before);
      target.undone = true;
      this.persistUndos();
      if (restored.length > 0) {
        this.recordAndBroadcast({
          type: "notice",
          kind: "info",
          text: `Put back ${countFiles(restored.length)} as they were at ${time}.`,
        });
      }
      if (failed.length > 0) {
        this.recordAndBroadcast({ type: "notice", kind: "error", text: `Couldn't put back: ${failed.join(", ")}.` });
      }
      this.recordAndBroadcast({ type: "undoDone", id, state: "undone" });
      void this.updateHeaderUndo();
    } catch (error) {
      this.snapshotFailed(error, "Couldn't undo that.");
      this.recordAndBroadcast({ type: "undoDone", id, state: "ready" });
    }
  }

  /** Undo the newest change that isn't undone yet (header button). */
  public async undoLast(): Promise<void> {
    const target = this.newestOpenUndo();
    if (!target) {
      return;
    }
    await this.undo(target.id);
  }

  /** Newest stored undo that hasn't been undone, if any. */
  private newestOpenUndo(): StoredUndo | undefined {
    const open = [...this.undos.values()].filter((undo) => !undo.undone);
    return open[open.length - 1];
  }

  /** Push the header Undo button state (greyed when nothing is undoable). */
  private async updateHeaderUndo(): Promise<void> {
    this.headerUndoSeq += 1;
    const seq = this.headerUndoSeq;
    const target = this.newestOpenUndo();
    let enabled = false;
    let tip = "Nothing to undo";
    if (target) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      let shadow: ShadowSnapshots | undefined;
      try {
        shadow = folder ? await this.shadowFor(folder) : undefined;
      } catch {
        shadow = undefined;
      }
      if (shadow) {
        try {
          // Pruning deletes oldest first, so one check decides: if the
          // newest open undo is gone, everything older is gone too.
          if ((await shadow.has(target.before)) && (await shadow.has(target.after))) {
            enabled = true;
            tip = `Undo: ${headerUndoTip(target)}`;
          }
        } catch {
          // Leave greyed.
        }
      }
    }
    if (seq !== this.headerUndoSeq) {
      return;
    }
    this.broadcast({ type: "headerUndo", enabled, tip });
  }

  /** Re-emit one stored Undo button (reload/resume), then check its state. */
  private emitReplayedUndo(id: string): void {
    const target = this.undos.get(id);
    if (!target) {
      return;
    }
    this.recordAndBroadcast({ type: "undo", id, label: `↩ Undo that (${countFiles(target.files.length)})` });
    void this.refreshUndoState(id);
  }

  private async refreshUndoState(id: string): Promise<void> {
    const target = this.undos.get(id);
    if (!target) {
      return;
    }
    if (target.undone) {
      this.recordAndBroadcast({ type: "undoDone", id, state: "undone" });
      this.log(`${id}: already undone`);
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    let shadow: ShadowSnapshots | undefined;
    try {
      shadow = folder ? await this.shadowFor(folder) : undefined;
    } catch {
      return; // No git: leave the button; clicking explains.
    }
    if (!shadow) {
      return;
    }
    try {
      const kept = (await shadow.has(target.before)) && (await shadow.has(target.after));
      if (!kept) {
        this.recordAndBroadcast({ type: "undoDone", id, state: "gone" });
        this.log(`${id}: snapshots pruned`);
      }
    } catch {
      // Leave the button; clicking reports properly.
    }
  }

  private async shadowFor(folder: vscode.WorkspaceFolder): Promise<ShadowSnapshots | undefined> {
    if (!this.storageDir) {
      return undefined;
    }
    const bin = await this.resolveGitBin();
    const cached = this.shadowCache;
    if (cached && cached.folder === folder.uri.fsPath && cached.bin === bin) {
      return cached.shadow;
    }
    const shadow = new ShadowSnapshots(folder.uri.fsPath, path.join(this.storageDir, "shadow.git"), {
      gitBin: bin,
    });
    this.shadowCache = { folder: folder.uri.fsPath, bin, shadow };
    return shadow;
  }

  /** The git binary, cached once found (a miss retries next turn). */
  private async resolveGitBin(): Promise<string> {
    if (!this.gitBinCache) {
      const configured = vscode.workspace.getConfiguration("git").get<unknown>("path");
      const settingPaths = (Array.isArray(configured) ? configured : [configured]).filter(
        (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
      );
      this.gitBinCache = await findGitBin({ settingPaths, extensionPath: readBundledGitPath() });
    }
    return this.gitBinCache;
  }

  private async takeBeforeSnapshot(
    folder: vscode.WorkspaceFolder,
  ): Promise<{ sha: string; at: number; excluded: string[] } | undefined> {
    try {
      const shadow = await this.shadowFor(folder);
      if (!shadow) {
        return undefined;
      }
      const snapshot = await shadow.snapshot("before turn");
      return { sha: snapshot.sha, at: Date.now(), excluded: snapshot.excluded };
    } catch (error) {
      this.snapshotFailed(error);
      return undefined;
    }
  }

  /** After-snapshot, then an Undo button when the turn changed files. */
  private async finishTurnSnapshot(
    before: { sha: string; at: number; excluded: string[] } | undefined,
  ): Promise<void> {
    if (!before) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    try {
      const shadow = await this.shadowFor(folder);
      if (!shadow) {
        return;
      }
      const after = await shadow.snapshot("after turn");
      const files = await shadow.diffFiles(before.sha, after.sha, before.excluded);
      if (files.length === 0) {
        return;
      }
      this.undoCounter += 1;
      const id = `undo-${this.undoCounter}`;
      // Past the reloaded high-water mark, so a suffix replay (whose user
      // count restarts small) can't reuse an anchor.
      const anchor = Math.max(
        this.history.filter((entry) => entry.type === "user").length,
        this.anchorHigh + 1,
      );
      this.anchorHigh = anchor;
      this.undos.set(id, {
        id,
        before: before.sha,
        after: after.sha,
        at: before.at,
        files,
        anchor,
        undone: false,
        session: this.museSessionId ?? "",
      });
      this.persistUndos();
      this.recordAndBroadcast({ type: "undo", id, label: `↩ Undo that (${countFiles(files.length)})` });
      // The turn-done persist ran before this button existed; without this,
      // closing now would replay the reply with no Undo button.
      this.persistTranscript();
      void this.updateHeaderUndo();
    } catch (error) {
      this.snapshotFailed(error);
    }
  }

  private snapshotFailed(error: unknown, fallback = "Couldn't take a snapshot, so this reply has no Undo."): void {
    if (error instanceof NoGitError) {
      this.gitBinCache = undefined;
      if (!this.gitNoticeShown) {
        this.gitNoticeShown = true;
        this.recordAndBroadcast({
          type: "notice",
          kind: "info",
          text: "Install Git to get Undo on every change. Muse still backs up files before changing them.",
        });
      }
      return;
    }
    this.recordAndBroadcast({ type: "notice", kind: "error", text: fallback });
  }

  public approve(id: string, choiceId: string, feedback?: string): void {
    this.approvalResolvers.get(id)?.(
      feedback === undefined || feedback.trim() === "" ? { choiceId } : { choiceId, feedback },
    );
    this.approvalResolvers.delete(id);
  }

  public async newChat(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      "Start a new chat? The old one stays saved by Muse.",
      "New chat",
      "Cancel",
    );
    if (answer !== "New chat") {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    if (this.saveRun) {
      // Stays set so late save events keep routing to onSaveEvent (dropped);
      // finalizeSave clears it when the interrupted turn ends.
      this.saveRun.cancelled = true;
    }
    this.pendingSave = undefined;
    // The interrupted turn ends silently, so no after-snapshot pairs with this.
    this.pendingBefore = undefined;
    // A new chat drops the script (a reload tries the welcome again).
    this.welcomeStep = undefined;
    this.broadcast({ type: "welcomeSkip", show: false });
    const host = await this.ensureHost(folder);
    try {
      await host.newSession(folder.uri.fsPath);
    } catch (error) {
      this.broadcast({
        type: "notice",
        kind: "error",
        text: `Something went wrong starting a new chat: ${shortReason(error)}.`,
      });
      this.broadcast({ type: "turn", state: "done" });
      this.broadcast({ type: "status", text: "Ready" });
      return;
    }
    this.history = [];
    this.storeSet(TRANSCRIPT_KEY, undefined);
    this.storeSet(LAST_MESSAGE_KEY, undefined);
    // Undo history stays: it's about files, not the conversation. Anchors
    // restart for the new session (old ones can't match it: they're tagged
    // with the old session id).
    this.anchorHigh = 0;
    this.forceCatchUp = true;
    this.running = false;
    this.lastStatus = "";
    this.lastUsage = undefined;
    this.updateStatusBar(formatStatusBar(undefined));
    this.liveReplySeen = false;
    this.sessionId = createSessionId();
    this.sessionTopic = "";
    this.persistSessionLabel();
    this.broadcastSessionLabel();
    this.broadcast({ type: "clear" });
    this.broadcast({ type: "turn", state: "done" });
    this.broadcast({ type: "status", text: "Ready" });
  }

  public async openLink(url: string): Promise<void> {
    try {
      if (/^https?:/i.test(url)) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      const folder = vscode.workspace.workspaceFolders?.[0];
      const link = folder ? parseFileLink(url, folder.uri.fsPath) : undefined;
      if (!link) {
        throw new Error("not a file link");
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(link.fsPath));
      if (link.line !== undefined) {
        const position = new vscode.Position(link.line - 1, (link.column ?? 1) - 1);
        await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
      } else {
        await vscode.window.showTextDocument(document);
      }
    } catch {
      this.broadcast({ type: "notice", kind: "error", text: "Couldn't open that link." });
    }
  }

  public async dispose(): Promise<void> {
    clearInterval(this.tickTimer);
    const live = cleanLiveLabels(this.storage.get<unknown>(LIVE_LABELS_KEY));
    delete live[this.sessionId];
    try {
      // Awaited: a restart boots within seconds, and must not see us as live.
      await this.storage.update(LIVE_LABELS_KEY, live);
    } catch {
      // Shutting down anyway; the entry expires on its own in 20 seconds.
    }
    const host = this.host;
    this.host = undefined;
    if (host) {
      await host.dispose();
    }
  }

  private prepare(): Promise<void> {
    if (this.prepared) {
      return Promise.resolve();
    }
    this.preparing ??= this.doPrepare().finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }

  private async doPrepare(): Promise<void> {
    try {
      const loaded = cleanUndos(this.storage.get<unknown>(UNDOS_KEY));
      this.log(`Undos loaded: ${loaded.length}`);
      this.undos = new Map(loaded.map((undo) => [undo.id, undo]));
      // New ids and anchors must not collide with reloaded ones.
      for (const undo of loaded) {
        const match = undo.id.match(/^undo-(\d+)$/);
        if (match) {
          this.undoCounter = Math.max(this.undoCounter, Number.parseInt(match[1] ?? "0", 10));
        }
        this.anchorHigh = Math.max(this.anchorHigh, undo.anchor);
      }
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        this.log("Resume: none (no folder open)");
        void this.updateHeaderUndo();
        return;
      }
      const host = await this.ensureHost(folder);
      const savedId = this.storage.get<string>(SESSION_ID_KEY);
      if (!savedId?.trim()) {
        this.log("Resume: none (no saved session)");
      } else {
        this.replaying = true;
        const resumeId = savedId.trim() || undefined;
        this.replayer = new UndoReplayer([...this.undos.values()], resumeId);
        try {
          let shown = 0;
          try {
            shown = await host.prepare(folder.uri.fsPath);
          } catch {
            // Leave the panel usable; send() surfaces startup problems properly.
            shown = 0;
          }
          if (shown === 0) {
            const stored = cleanTranscript(this.storage.get<unknown>(TRANSCRIPT_KEY));
            this.log(`Resume: stored transcript (${stored.length} entries)`);
            const replayed = new Set<string>();
            stored.forEach((entry, index) => {
              if (entry.role === "undo" && entry.id) {
                this.emitReplayedUndo(entry.id);
                replayed.add(entry.id);
                this.log(`${entry.id}: replayed from stored transcript`);
              } else if (entry.role === "nudge" && entry.id && entry.answer) {
                this.recordAndBroadcast({ type: "nudgeAnswered", id: entry.id, answer: entry.answer });
              } else {
                this.recordAndBroadcast(
                  entry.role === "user"
                    ? { type: "user", text: entry.text, at: entry.at }
                    : { type: "assistant", id: `stored-${index}`, text: entry.text, at: entry.at },
                );
              }
            });
            for (const undo of loaded) {
              if (!replayed.has(undo.id)) {
                this.log(`${undo.id}: not in stored transcript`);
              }
            }
          } else {
            for (const id of this.replayer.finish()) {
              this.emitReplayedUndo(id);
            }
            const users = this.replayer.userCount();
            this.log(`Resume: server history (${users} user messages)`);
            const fired = new Set(this.replayer.firedIds());
            for (const undo of loaded) {
              if (fired.has(undo.id)) {
                this.log(`${undo.id}: anchor ${undo.anchor} matched`);
              } else {
                this.log(`${undo.id}: anchor ${undo.anchor} had no reply (${users} users replayed)`);
              }
            }
          }
        } finally {
          this.replaying = false;
          this.replayer = undefined;
        }
      }
      await this.maybeWelcome(folder);
      void this.updateHeaderUndo();
    } finally {
      this.prepared = true;
    }
  }

  private ensureHost(folder: vscode.WorkspaceFolder): Promise<MuseHost> {
    if (this.host) {
      return Promise.resolve(this.host);
    }
    // Single flight: two hosts would each spawn `muse serve` and their
    // status lines would overwrite each other.
    return this.createHostShared(folder);
  }

  private async createHostAsync(folder: vscode.WorkspaceFolder): Promise<MuseHost> {
    const trustWorkspace = await this.ensureMemory(folder);
    this.host = this.createHost(trustWorkspace);
    return this.host;
  }

  /**
   * Decide memory from the setting + Workspace Trust; create the brain and
   * front door when on. Returns the --trust-workspace flag for the host.
   */
  private async ensureMemory(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const setting = vscode.workspace.getConfiguration("metaBetta").get<boolean>("memory", true);
    const on = setting && vscode.workspace.isTrusted;
    this.memoryOn = on;
    if (on) {
      await ensureBrain(folder.uri.fsPath);
      await ensureFrontDoor(folder.uri.fsPath);
      await ensureGitignoreEntry(folder.uri.fsPath, ".backups/");
    }
    if (!this.memoryAnnounced) {
      this.memoryAnnounced = true;
      // Ephemeral, like turn/status: announcing again on every reopen would
      // flood the history with the same line.
      if (on) {
        this.broadcast({ type: "notice", kind: "info", text: "Memory is on for this folder (brain/)." });
      } else if (!setting) {
        this.broadcast({
          type: "notice",
          kind: "info",
          text: "Memory is off. Turn it on with the Meta Betta › Memory setting.",
        });
      } else {
        this.broadcast({
          type: "notice",
          kind: "info",
          text: "Memory is off because VS Code doesn't trust this folder. Trust it (Manage Workspace Trust) to turn memory on.",
        });
      }
    }
    return on;
  }

  private sessionLabel(): string {
    return formatSessionLabel(this.sessionId, this.sessionTopic);
  }

  private broadcastSessionLabel(): void {
    this.broadcast({ type: "sessionLabel", label: this.sessionLabel() });
  }

  private adoptStoredLabel(): void {
    // A resumed chat keeps its label; a chat already renamed or reset this
    // boot keeps what it has. A second window on this folder keeps its own
    // id (the stored one is taken) so each window saves under its own label.
    if (this.labelSettled) {
      return;
    }
    this.labelSettled = true;
    const stored = cleanSessionLabel(this.storage.get<unknown>(SESSION_LABEL_KEY));
    if (stored) {
      const live = cleanLiveLabels(this.storage.get<unknown>(LIVE_LABELS_KEY));
      if (isLabelTaken(stored.id, live, Date.now())) {
        this.diverged = true;
        this.sessionTopic = stored.topic;
      } else {
        this.sessionId = stored.id;
        this.sessionTopic = stored.topic;
      }
      this.broadcastSessionLabel();
    }
    this.heartbeat();
  }

  private persistSessionLabel(): void {
    this.labelSettled = true;
    if (!this.diverged) {
      this.storeSet(SESSION_LABEL_KEY, { id: this.sessionId, topic: this.sessionTopic });
    }
    this.heartbeat();
  }

  /** Mark this window's label id as live, pruning windows long gone. */
  private heartbeat(): void {
    const live = cleanLiveLabels(this.storage.get<unknown>(LIVE_LABELS_KEY));
    const now = Date.now();
    for (const id of Object.keys(live)) {
      if (now - (live[id] ?? 0) >= LIVE_LABEL_TTL_MS) {
        delete live[id];
      }
    }
    live[this.sessionId] = now;
    this.storeSet(LIVE_LABELS_KEY, live);
  }

  private createHost(trustWorkspace: boolean): MuseHost {
    const config = vscode.workspace.getConfiguration("metaBetta");
    const workaround = config.get<boolean>("windowsSandboxWorkaround", true);
    this.shellWorkaround = process.platform === "win32" && workaround;
    return new MuseHost({
      museBin: findMuseBin(config.get<string>("museBin", "")),
      version: readVersion(this.extensionUri),
      trustWorkspace,
      emit: (event) => this.onHostEvent(event),
      askApproval: (card) => this.askApproval(card),
      log: (message) => this.log(message),
      sandboxWorkaround: workaround,
      sessionStore: {
        loadId: () => this.storage.get<string>(SESSION_ID_KEY),
        saveId: (id) => {
          this.museSessionId = id;
          this.storeSet(SESSION_ID_KEY, id);
        },
        clear: () => {
          this.storeSet(SESSION_ID_KEY, undefined);
          this.storeSet(TRANSCRIPT_KEY, undefined);
          this.storeSet(LAST_MESSAGE_KEY, undefined);
          // Undo history stays: the snapshots are still valid.
          this.anchorHigh = 0;
        },
      },
    });
  }

  private storeSet(key: string, value: unknown): void {
    void this.storage.update(key, value).then(undefined, () => undefined);
  }

  private persistTranscript(): void {
    this.storeSet(TRANSCRIPT_KEY, buildTranscript(this.history));
  }

  private persistUndos(): void {
    this.storeSet(UNDOS_KEY, [...this.undos.values()].slice(-100));
  }

  private onHostEvent(event: MuseHostEvent): void {
    // State updates, not chat: they apply during saves too.
    if (event.type === "usage") {
      this.recordUsage(event.usage);
      return;
    }
    if (event.type === "goal") {
      this.lastGoal = event.goal;
      this.storeSet(GOAL_KEY, event.goal);
      this.broadcast({ type: "goal", goal: event.goal });
      return;
    }
    if (event.type === "effort") {
      this.lastEffort = event.level;
      this.storeSet(EFFORT_KEY, event.level);
      this.broadcast({ type: "effort", level: event.level });
      return;
    }
    if (event.type === "model") {
      // No persistent display; /model lists fresh.
      return;
    }
    const save = this.saveRun;
    if (save) {
      this.onSaveEvent(event, save);
      return;
    }
    if (event.type === "turn") {
      this.running = event.state === "started";
      this.broadcast(event);
      if (!this.running) {
        this.persistTranscript();
        if (this.welcomeStep === "memory") {
          this.finishWelcome();
        }
        const before = this.pendingBefore;
        this.pendingBefore = undefined;
        void this.finishTurnSnapshot(before);
        this.turnsSinceSave += 1;
        const pending = this.pendingSave;
        this.pendingSave = undefined;
        if (pending === "full") {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (folder && this.memoryOn) {
            void this.runSave(folder, false);
          } else {
            this.broadcast({ type: "notice", kind: "info", text: "Couldn't save this time." });
          }
        } else {
          this.maybeQuickSave();
        }
      }
      return;
    }
    if (event.type === "status") {
      this.lastStatus = event.text;
      this.broadcast(event);
      return;
    }
    if (this.replaying && this.replayer && event.type === "user") {
      for (const id of this.replayer.userArrived()) {
        this.emitReplayedUndo(id);
      }
    }
    if (event.type === "assistant" && this.running) {
      this.liveReplySeen = true;
    }
    if (this.welcomeStep === "hello" && event.type === "assistant") {
      this.welcomeHeard = true;
    }
    this.recordAndBroadcast(event);
    if (this.replaying && this.replayer && event.type === "assistant") {
      for (const id of this.replayer.assistantArrived()) {
        this.emitReplayedUndo(id);
      }
    }
  }

  /**
   * Route a save turn's events: collect the reply for filing, keep the chat
   * quiet. Finalizing happens after host.send() resolves, so the host's own
   * "Ready" can't overwrite the save status.
   */
  private onSaveEvent(event: MuseHostEvent, save: SaveRun): void {
    if (save.cancelled) {
      return;
    }
    if (event.type === "assistant") {
      save.texts.set(event.id, event.text);
      return;
    }
    if (event.type === "notice") {
      if (event.text === "Stopped.") {
        save.stopped = true;
        return;
      }
      if (event.kind === "error") {
        save.failed = true;
      }
      this.recordAndBroadcast(event);
      return;
    }
    if (event.type === "turn") {
      this.running = event.state === "started";
      this.broadcast(event);
      if (!this.running) {
        this.persistTranscript();
      }
      return;
    }
    if (event.type === "status") {
      // Keep "Saving…" until the save itself reports.
      return;
    }
    if (event.type === "approval" || event.type === "approvalDone") {
      this.recordAndBroadcast(event);
      return;
    }
    // Thinking and tool rows stay out of the chat during a save.
  }

  private askApproval(card: ApprovalCardEvent): Promise<ApprovalAnswer | undefined> {
    if (this.sinks.size === 0 || !this.running) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.approvalResolvers.set(card.id, resolve);
      this.maybeShellNotice(card);
      this.recordAndBroadcast(card);
    });
  }

  /**
   * One plain line the first time a command card appears (Windows workaround
   * only), then never again for this folder.
   */
  private maybeShellNotice(card: ApprovalCardEvent): void {
    if (card.kind !== "shell" || !this.shellWorkaround) {
      return;
    }
    if (this.storage.get<boolean>(SHELL_NOTICE_KEY) === true) {
      return;
    }
    this.storeSet(SHELL_NOTICE_KEY, true);
    this.recordAndBroadcast({
      type: "notice",
      kind: "info",
      text: "Muse's Windows sandbox has a bug right now, so I'll ask you before running any command. ↩ Undo still works on every change.",
    });
  }

  private recordAndBroadcast(event: TranscriptEvent): void {
    // Messages carry their time; resumed ones keep their recorded stamp, and
    // ones with no stamp show no time.
    const stamped =
      event.type === "user" || event.type === "assistant" ? stampMessageTime(event) : event;
    // Streaming updates replace their earlier self, so history stays compact
    // and a replay shows each bubble once, in its final state.
    const upsertId =
      stamped.type === "assistant" ||
      stamped.type === "thinking" ||
      stamped.type === "tool" ||
      stamped.type === "card"
        ? stamped.id
        : undefined;
    if (upsertId !== undefined) {
      const index = this.history.findIndex(
        (entry) => entry.type === stamped.type && (entry as { id?: string }).id === upsertId,
      );
      if (index >= 0) {
        // A stream chunk never moves the message's time.
        const prev = this.history[index];
        this.history[index] =
          stamped.type === "assistant" && prev?.type === "assistant"
            ? keepMessageTime(prev, stamped)
            : stamped;
        this.broadcast(this.history[index]);
        return;
      }
    }
    const divider = this.dividerFor(stamped);
    if (divider !== undefined) {
      this.pushHistory({ type: "day", label: divider });
      this.broadcast({ type: "day", label: divider });
    }
    this.pushHistory(stamped);
    this.broadcast(stamped);
    if (stamped.type === "user") {
      this.persistTranscript();
    }
  }

  private pushHistory(event: TranscriptEvent): void {
    this.history.push(event);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
      const alive = new Set(
        this.history
          .filter((entry): entry is Extract<TranscriptEvent, { type: "card" }> => entry.type === "card")
          .map((entry) => entry.id),
      );
      for (const id of [...this.cardHandlers.keys()]) {
        if (!alive.has(id)) {
          this.cardHandlers.delete(id);
        }
      }
    }
  }

  /** The day divider before a message, from the last stamped message. */
  private dividerFor(event: TranscriptEvent): string | undefined {
    if ((event.type !== "user" && event.type !== "assistant") || event.at === undefined) {
      return undefined;
    }
    let prevAt: number | undefined;
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const entry = this.history[index];
      if ((entry?.type === "user" || entry?.type === "assistant") && entry.at !== undefined) {
        prevAt = entry.at;
        break;
      }
    }
    return dividerBefore(prevAt, event.at);
  }

  private broadcast(message: unknown): void {
    for (const sink of this.sinks) {
      sink.post(message);
    }
  }
}

/** Route one webview message to the controller. Shared by panel and sidebar. */
export function routeViewMessage(controller: ChatController, message: unknown): void {
  if (!isRecord(message)) {
    return;
  }
  if (message.type === "stop") {
    controller.stop();
    return;
  }
  if (message.type === "saveMyDay") {
    void controller.saveMyDay();
    return;
  }
  if (message.type === "undo" && typeof message.id === "string") {
    void controller.undo(message.id);
    return;
  }
  if (message.type === "undoLast") {
    void controller.undoLast();
    return;
  }
  if (message.type === "skipWelcome") {
    controller.skipWelcome();
    return;
  }
  if (message.type === "newChat") {
    void controller.newChat();
    return;
  }
  if (message.type === "renameSession") {
    void controller.renameSession();
    return;
  }
  if (message.type === "openFolder") {
    void controller.openFolder();
    return;
  }
  if (message.type === "approve" && typeof message.id === "string" && typeof message.choiceId === "string") {
    const feedback = typeof message.feedback === "string" ? message.feedback : undefined;
    controller.approve(message.id, message.choiceId, feedback);
    return;
  }
  if (message.type === "openLink" && typeof message.url === "string") {
    void controller.openLink(message.url);
    return;
  }
  if (message.type === "nudgeAnswer") {
    const parsed = parseNudgeAnswer(message);
    if (parsed) {
      void controller.answerNudge(parsed.id, parsed.answer, parsed.thing);
    }
    return;
  }
  if (message.type === "cardButton") {
    const parsed = parseCardButton(message);
    if (parsed) {
      controller.onCardButton(parsed.cardId, parsed.buttonId);
    }
    return;
  }
  if (message.type === "cardInput") {
    const parsed = parseCardInput(message);
    if (parsed) {
      controller.onCardInput(parsed.cardId, parsed.text);
    }
    return;
  }
  if (message.type === "goalAsk") {
    void controller.askGoal();
    return;
  }
  if (message.type === "sideBox") {
    void controller.dispatchSlash("side", "");
    return;
  }
  if (message.type === "forkNow") {
    void controller.dispatchSlash("fork", "");
    return;
  }
  if (message.type === "usageNow") {
    void controller.dispatchSlash("usage", "");
    return;
  }
  if (message.type === "effortCycle") {
    void controller.cycleEffort();
    return;
  }
  if (
    message.type === "goalAction" &&
    (message.action === "pause" || message.action === "resume" || message.action === "clear")
  ) {
    void controller.dispatchSlash("goal", message.action);
    return;
  }
  if (message.type === "forkMessage" && typeof message.id === "string") {
    void controller.dispatchSlash("fork", "");
    return;
  }
  const text = parseSendMessage(message);
  if (text !== undefined) {
    void controller.send(text);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** "1 file" or "3 files". */
function countFiles(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

/** "notes.txt (4:12pm)" or "3 files (4:12pm)" for the header Undo tooltip. */
function headerUndoTip(target: StoredUndo): string {
  const time = formatSaveTime(new Date(target.at));
  if (target.files.length === 1) {
    return `${target.files[0]?.path ?? "file"} (${time})`;
  }
  return `${countFiles(target.files.length)} (${time})`;
}

/**
 * The git binary VS Code's own Git extension found, if it's already active.
 * Read only — activating it just to ask would spin up a repo scan.
 */
function readBundledGitPath(): string | undefined {
  try {
    const api = vscode.extensions.getExtension("vscode.git")?.exports?.getAPI?.(1);
    const found = api?.git?.path;
    return typeof found === "string" && found.trim() !== "" ? found : undefined;
  } catch {
    return undefined;
  }
}

/** Save sections in file order, with card titles, for the Saved card. */
function savedSections(sections: SaveSections): SavedSection[] {
  const order: SaveSection[] = ["project", "log", "tricks", "good-for", "me"];
  const cards: SavedSection[] = [];
  for (const key of order) {
    const text = sections[key];
    if (text !== undefined) {
      cards.push({ title: SAVE_TITLES[key], text });
    }
  }
  return cards;
}

function readVersion(extensionUri: vscode.Uri): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(extensionUri.fsPath, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
