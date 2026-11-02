import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  APPROVAL_CHOICES,
  cleanApprovalChoice,
  cleanEffortLevel,
  cleanGoalInfo,
  commandErrorText,
  EFFORT_LEVELS,
  findSlashCommand,
  parsePluginSpec,
  parseSlashCommand,
  SLASH_COMMANDS,
  unknownCommandText,
  type AllowanceSlice,
  type ApprovalChoice,
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
import {
  approvalsMenu,
  cleanShortcutSlots,
  DEFAULT_SHORTCUT_SLOTS,
  effortMenu,
  shortcutDefs,
  shortcutDispatch,
  swapShortcutSlot,
} from "./commands/shortcuts.js";
import { parseCardButton, parseCardInput, parseNudgeAnswer, parseSendWithImages } from "./lib/chat.js";
import {
  imageAttachmentNames,
  pasteFileFits,
  PASTED_DIR,
  PASTED_GITIGNORE,
  uniquePastedName,
  fileMention,
  type PasteImage,
} from "./lib/paste.js";
import { insideDir } from "./lib/approvals.js";
import { formatWorkLog } from "./lib/items.js";
import type { StepGroup } from "./lib/items.js";
import { parseFileLink } from "./lib/links.js";
import {
  buildForkTranscript,
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
  type TranscriptEntry,
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
  brainCommitOffer,
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
  isGreetingMessage,
  isJobFirstMessage,
  isLabelTaken,
  isStarterMe,
  LIVE_LABEL_TTL_MS,
  needsCatchUp,
  nodeBrainFs,
  previousUserLeftHanging,
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
import {
  findGitBin,
  formatUndoTime,
  gitHeadMoved,
  NoGitError,
  readGitHead,
  ShadowSnapshots,
  undoCommitWarning,
} from "./safety/snapshots.js";
import { singleFlight } from "./lib/singleFlight.js";
import { findMuseBin } from "./muse/resolveBin.js";
import {
  runFirstRun,
  shQuote,
  type FirstRunDeps,
  type RunResult,
  type RunSpec,
} from "./setup/firstRun.js";
import {
  type ApprovalAnswer,
  type PickerEvent,
  MuseHost,
  type MuseHostEvent,
  type SetupNeededInfo,
} from "./muse/museHost.js";
import { current as lockHolder, TurnBusyError } from "./muse/turnLock.js";
import {
  adoptsStoredLabel,
  clearedKeysOnFailedResume,
  findPeekTarget,
  formatPeekBackground,
  MAIN_TAB_UID,
  MessageQueue,
  queueDroppedNote,
  queueQueuedNote,
  queueSentNote,
  tabStorageKey,
  type PeekCandidate,
  type TabRecord,
  type TabSeed,
} from "./lib/chatTabs.js";

/** One attached chat surface: a chat tab's panel. */
export interface ChatSink {
  post(message: unknown): void;
}

/**
 * The extension side of a tab: persistence + cross-tab actions. The
 * controller owns its chat; the TabHost owns everything shared between tabs.
 */
export interface TabHost {
  /** This tab's id (MAIN_TAB_UID for the first chat). */
  uid: string;
  /** Reload/fork seed: the session (and label) to resume. */
  seed?: TabSeed;
  /** The tab's record changed (session/label/topic): persist it + retitle. */
  onChanged: (record: TabRecord) => void;
  /** New pill: open a fresh tab and focus it. */
  onNewTab: () => void;
  /** Fork pill: open a tab on the forked session and focus it. */
  onForkTab: (sessionId: string, transcript: TranscriptEntry[], topic: string) => void;
  /** Open + recent chats (labels/topics) for the peek matcher. */
  peekChats: () => PeekCandidate[];
  /** Another tab's header label, for the busy line. */
  labelOf: (uid: string) => string | undefined;
  /** Go to it: reveal the tab running the turn. */
  revealTab: (uid: string) => void;
  /** Stop it: stop the tab running the turn. */
  stopTab: (uid: string) => void;
  /** Fresh usage numbers landed: the sidebar Usage view wants them. */
  onUsage?: () => void;
}

export interface SavedSection {
  title: string;
  text: string;
}

type TranscriptEvent =
  | ChatUserMessage
  | ChatAssistantMessage
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; text: string; done: boolean; group?: StepGroup; failed?: boolean }
  | PickerEvent
  | { type: "approvalDone"; id: string }
  | { type: "notice"; text: string; copy?: string; kind: "info" | "error" }
  | { type: "saved"; text: string; backup?: string; sections: SavedSection[] }
  | { type: "undo"; id: string; label: string }
  | { type: "undoDone"; id: string; state: "undone" | "ready" | "gone" }
  | { type: "memory"; text: string; detail: string }
  | { type: "day"; label: string }
  | { type: "nudgeAnswered"; id: string; answer: "show" | "notnow" }
  | { type: "card"; id: string; title: string; body: string; buttons?: CardSpec["buttons"]; input?: CardSpec["input"]; details?: CardSpec["details"] }
  | { type: "cardDone"; id: string }
  | { type: "busy"; text: string }
  | { type: "busyDone" }
  | { type: "boxLock"; locked: boolean; text?: string }
  | { type: "tabId"; id: string }
  | { type: "turn"; state: "started" | "done"; finalId?: string; line?: string; replay?: boolean };

const HISTORY_LIMIT = 500;
const SESSION_ID_KEY = "metaBetta.sessionId";
const SESSION_LABEL_KEY = "metaBetta.sessionLabel";
const TRANSCRIPT_KEY = "metaBetta.transcript";
const LAST_MESSAGE_KEY = "metaBetta.lastMessageAt";
const LIVE_LABELS_KEY = "metaBetta.liveLabels";
const UNDOS_KEY = "metaBetta.undos";
const WELCOMED_KEY = "metaBetta.welcomed";
/** SecretStorage id for the pasted API key (this machine's vault). */
const API_KEY_SECRET = "metaBetta.apiKey";
/** First-run "Muse is ready" cache (globalState: this machine). */
const FIRST_RUN_READY_KEY = "metaBetta.firstRunReady";
/** The setup test turn must answer within this. */
const TEST_TURN_TIMEOUT_MS = 120_000;

/** The before-turn state: a shadow snapshot plus the repo HEAD at the time. */
interface BeforeState {
  sha: string;
  at: number;
  excluded: string[];
  headBefore: string | undefined;
}
const GOAL_KEY = "metaBetta.goal";
const EFFORT_KEY = "metaBetta.effort";
const APPROVALS_KEY = "metaBetta.approvals";
/** A session left in All when the window closed; the host reverts it on resume. */
const APPROVAL_ALL_KEY = "metaBetta.approvalAll";
const DAILY_USAGE_KEY = "metaBetta.dailyUsage";
const SHELL_NOTICE_KEY = "metaBetta.shellNoticeShown";
/** The user's shortcut pill choices (globalState: every project). */
const SHORTCUT_SLOTS_KEY = "metaBetta.shortcutSlots";
/** Heartbeat + quick-save check, every 10 seconds. */
const TICK_MS = 10_000;
/** A quick save also fires after this many turns, whatever the clock says. */
const QUICK_SAVE_TURNS = 15;
/** A queued message retries the lock this often while it waits. */
const QUEUE_RETRY_MS = 1000;

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
  private pendingBefore: BeforeState | undefined;
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
  /** A "run setup again" card is already on screen; don't stack another. */
  private setupCardOpen = false;
  private lastUsage: SessionUsageTotals | undefined;
  private lastGoal: GoalInfo | null = null;
  private lastEffort: EffortLevel = "normal";
  private lastApprovals: ApprovalChoice = "auto";
  /** Fork attach: swallow server history, the seed transcript replays instead. */
  private quietAttach = false;
  /** A greeting in a fresh folder: ask the deferred name question after this turn. */
  private welcomeAfterTurn: vscode.WorkspaceFolder | undefined;
  private switching = false;
  private disposed = false;
  private readonly createHostShared = singleFlight((folder: vscode.WorkspaceFolder) =>
    this.createHostAsync(folder),
  );
  /** Typed messages waiting for the lock, oldest first. */
  private readonly queue = new MessageQueue();
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
  /** Pasted pictures waiting with queued messages, keyed by queue row id. */
  private readonly pendingImages = new Map<string, PasteImage[]>();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: vscode.Memento,
    private readonly onBrainChanged: (files: string[]) => void = () => undefined,
    private readonly storageDir: string | undefined = undefined,
    private readonly logFn: (message: string) => void = () => undefined,
    private readonly onWelcomeOutline: () => void = () => undefined,
    private readonly updateStatusBar: (text: string) => void = () => undefined,
    private readonly globalState: vscode.Memento | undefined = undefined,
    private readonly tabHost: TabHost,
    private readonly secrets: vscode.SecretStorage | undefined = undefined,
  ) {
    this.lastGoal = cleanGoalInfo(this.storage.get<unknown>(this.tabKey(GOAL_KEY)));
    this.lastEffort = cleanEffortLevel(this.storage.get<unknown>(this.tabKey(EFFORT_KEY)));
    this.lastApprovals = cleanApprovalChoice(this.storage.get<unknown>(this.tabKey(APPROVALS_KEY)));
    if (this.tabHost.seed?.catchUp) {
      this.forceCatchUp = true;
    }
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
    for (const item of this.queue.list()) {
      if (!item.recorded) {
        sink.post({ type: "queued", id: item.id, text: item.text, ...sentAttachments(item.attachments ?? []) });
      }
    }
    sink.post({ type: "turn", state: this.running ? "started" : "done" });
    sink.post({ type: "status", text: this.lastStatus });
    sink.post({ type: "tabId", id: this.tabHost.uid });
    sink.post({ type: "sessionLabel", label: this.sessionLabel() });
    sink.post({ type: "welcomeSkip", show: this.welcomeStep !== undefined });
    sink.post({
      type: "slashCommands",
      commands: SLASH_COMMANDS.map((def) => ({ name: def.name, description: def.description })),
    });
    sink.post({ type: "goal", goal: this.lastGoal });
    sink.post({ type: "effort", level: this.lastEffort, levels: effortMenu(this.lastEffort) });
    sink.post({
      type: "approvals",
      mode: this.lastApprovals,
      modes: approvalsMenu(this.lastApprovals),
    });
    sink.post({ type: "shortcuts", shortcuts: shortcutDefs(), slots: this.shortcutSlots() });
    const ding = vscode.workspace.getConfiguration("metaBetta").get<boolean>("dingWhenDone", true);
    sink.post({ type: "ding", enabled: ding });
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

  public async send(text: string, images: PasteImage[] = []): Promise<void> {
    if (text === "" && images.length === 0) {
      return;
    }
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
      this.storeSet(this.tabKey(LAST_MESSAGE_KEY), Date.now());
      if (images.length > 0) {
        // The command ran; the pictures went nowhere. Say so, plainly.
        this.recordAndBroadcast({
          type: "notice",
          kind: "info",
          text: "That went out without the pictures — send them with a message to show them to Muse.",
        });
      }
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
    if (this.welcomeStep && /^\s*skip(\s+this|\s+for\s+now)?\s*[.?]?\s*$/i.test(text)) {
      this.skipWelcome();
      return;
    }
    if (this.queue.full) {
      // The box should have locked at five; a raced sixth says so plainly.
      this.showBusy();
      this.broadcast({
        type: "notice",
        kind: "info",
        text: "Five messages are already waiting — press Send again when the box unlocks.",
      });
      return;
    }
    try {
      // Ensured before recording, so a failed start leaves no ghost message.
      await this.ensureHost(folder);
    } catch (error) {
      this.broadcast({
        type: "notice",
        kind: "error",
        text: `Something went wrong: ${shortReason(error)}.`,
      });
      return;
    }
    await this.fileWelcomeAnswer(folder, text);
    if (lockHolder() !== undefined) {
      // Queued behind the running turn: the bubble records when it sends, so
      // a waiting message never skews the undo anchors or shows twice.
      this.enqueueMessage(text, false, images);
      return;
    }
    // Recorded only once the turn will actually run: a failed send never
    // reaches the server, and a ghost user message would skew the undo
    // anchors on resume.
    this.recordAndBroadcast({
      type: "user",
      text,
      at: Date.now(),
      ...sentAttachments(imageAttachmentNames(images)),
    });
    this.storeSet(this.tabKey(LAST_MESSAGE_KEY), Date.now());
    await this.sendNow(folder, text, images);
    if (this.welcomeAfterTurn) {
      // The greeting's turn is done and the lock is free: ask the deferred name.
      const pending = this.welcomeAfterTurn;
      this.welcomeAfterTurn = undefined;
      try {
        await this.maybeWelcome(pending);
      } catch {
        // A reload tries the welcome again.
      }
    }
  }

  /** File a welcome answer into the brain; runs once per message, queued or not. */
  private async fileWelcomeAnswer(folder: vscode.WorkspaceFolder, text: string): Promise<void> {
    if (
      (this.welcomeStep === undefined || this.welcomeStep === "hello") &&
      (await this.isFreshWelcome(folder))
    ) {
      if (isJobFirstMessage(text)) {
        // A job first: skip the name questions for now, do the job, and put
        // the memory note before the reply. The name waits for a greeting.
        this.welcomeStep = undefined;
        this.broadcast({ type: "welcomeSkip", show: false });
        this.postMemoryNoteOnce();
        return;
      }
      if (this.welcomeStep === undefined && isGreetingMessage(text) && lockHolder() === undefined) {
        this.welcomeAfterTurn = folder;
      }
    }
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
  }

  /** Memory on, welcome unfinished, me.md still the starter template. */
  private async isFreshWelcome(folder: vscode.WorkspaceFolder): Promise<boolean> {
    if (!this.memoryOn || this.storage.get<boolean>(WELCOMED_KEY)) {
      return false;
    }
    let me: string | undefined;
    try {
      me = await nodeBrainFs.readFile(path.join(folder.uri.fsPath, "brain", "me.md"));
    } catch {
      me = undefined;
    }
    return isStarterMe(me);
  }

  /** The short memory note, once per chat no matter which path posts it. */
  private postMemoryNoteOnce(): void {
    if (this.history.some((entry) => entry.type === "memory")) {
      return;
    }
    this.recordAndBroadcast({ type: "memory", text: WELCOME_MEMORY_TEXT, detail: WELCOME_MEMORY_DETAIL });
  }

  /**
   * Run the turn now. A lost lock race re-queues instead of failing; the
   * message is recorded already, so only the turn is deferred.
   */
  private async sendNow(folder: vscode.WorkspaceFolder, text: string, images: PasteImage[] = []): Promise<void> {
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
    this.pendingBefore = await this.takeBeforeSnapshot(folder);
    const peek = this.peekFor(text);
    if (peek) {
      const note = `Peeked at '${peek.label}'`;
      // A queued message retries sendNow; the note shows once per message.
      const noted = [...this.history].reverse().find((event) => event.type === "notice");
      if (noted?.type !== "notice" || noted.text !== note) {
        this.recordAndBroadcast({ type: "notice", kind: "info", text: note });
      }
    }
    const prompt = await this.withBackground(folder, text);
    try {
      await host.send(
        peek ? `${prompt}\n\n${peek.block}` : prompt,
        folder.uri.fsPath,
        images,
        images.length > 0 ? text : undefined,
      );
    } catch (error) {
      if (error instanceof TurnBusyError) {
        // Lost the lock race after recording: the bubble stays, no extra row.
        this.enqueueMessage(text, true, images);
        return;
      }
      throw error;
    }
  }

  /**
   * The background peek for a message that refers to another chat: that
   * chat's last transcript entries, for this turn only. Otherwise never —
   * other chats stay unloaded.
   */
  private peekFor(text: string): { label: string; block: string } | undefined {
    const target = findPeekTarget(text, this.tabHost.uid, this.tabHost.peekChats());
    if (!target) {
      return undefined;
    }
    const entries = cleanTranscript(this.storage.get<unknown>(tabStorageKey(TRANSCRIPT_KEY, target.uid)));
    if (entries.length === 0) {
      this.log(`Peek: '${target.label}' has nothing to show`);
      return undefined;
    }
    this.log(`Peek: '${target.label}' (${entries.length} entries)`);
    return { label: target.label, block: formatPeekBackground(target.label, entries) };
  }

  /**
   * The lock is held: the message waits as a muted row and sends in order
   * when the lock frees. The box locks at five until the queue drains.
   * `recorded` marks a lost lock race: its bubble is already showing, so no
   * extra row goes up for it.
   */
  private enqueueMessage(text: string, recorded = false, images: PasteImage[] = []): void {
    const id = this.queue.push(text, recorded, imageAttachmentNames(images));
    if (id === undefined) {
      this.showBusy();
      return;
    }
    if (images.length > 0) {
      this.pendingImages.set(id, images);
    }
    this.log(queueQueuedNote(this.tabHost.uid, this.queue.size, lockHolder()));
    if (!recorded) {
      this.broadcast({ type: "queued", id, text, ...sentAttachments(imageAttachmentNames(images)) });
    }
    this.showBusy();
    this.ensureRetry();
  }

  /** Take (and forget) the pictures waiting with a queued message. */
  private takeImages(id: string): PasteImage[] {
    const images = this.pendingImages.get(id);
    this.pendingImages.delete(id);
    return images ?? [];
  }

  /** A webview-side refusal (wrong picture type, too many): say so in chat. */
  public attachNote(text: string): void {
    this.recordAndBroadcast({ type: "notice", kind: "error", text });
  }

  /**
   * Dropped or pasted-in files. Workspace files are mentioned where they
   * are; outside ones are copied under .meta-betta/pasted/ first. Mentions
   * land at the cursor; every refusal says so in plain words.
   */
  public async resolveDrop(paths: string[]): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.broadcast({ type: "noFolder" });
      return;
    }
    const root = folder.uri.fsPath;
    const mentions: string[] = [];
    const seen = new Set<string>();
    const mention = (text: string): void => {
      if (!seen.has(text)) {
        seen.add(text);
        mentions.push(text);
      }
    };
    for (const raw of paths) {
      if (typeof raw !== "string" || raw.trim() === "") {
        continue;
      }
      // Drags from VS Code's own Explorer arrive as file: URIs.
      const target = raw.trim().startsWith("file:") ? vscode.Uri.parse(raw.trim()).fsPath : raw.trim();
      const base = path.basename(target) || target;
      let stat: { isDirectory(): boolean; size: number } | undefined;
      try {
        stat = await fs.promises.stat(target);
      } catch {
        stat = undefined;
      }
      if (!stat) {
        this.recordAndBroadcast({
          type: "notice",
          kind: "error",
          text: `I couldn't find ${base} — it may have been moved or deleted.`,
        });
        continue;
      }
      if (stat.isDirectory()) {
        this.recordAndBroadcast({
          type: "notice",
          kind: "error",
          text: "Sorry, I can only use single files, not folders.",
        });
        continue;
      }
      if (!pasteFileFits(stat.size)) {
        this.recordAndBroadcast({
          type: "notice",
          kind: "error",
          text: "That file's too big to paste (20 MB max).",
        });
        continue;
      }
      if (insideDir(root, root, target)) {
        const rel = path.relative(root, path.resolve(root, target)).split(path.sep).join("/");
        mention(fileMention(rel));
        continue;
      }
      try {
        const dir = path.join(root, PASTED_DIR);
        await fs.promises.mkdir(dir, { recursive: true });
        const taken = await fs.promises.readdir(dir).catch(() => [] as string[]);
        const name = uniquePastedName(taken, base);
        await fs.promises.copyFile(target, path.join(dir, name));
        const isRepo = await fs.promises
          .stat(path.join(root, ".git"))
          .then(() => true)
          .catch(() => false);
        if (isRepo) {
          await ensureGitignoreEntry(root, PASTED_GITIGNORE);
        }
        mention(fileMention(`${PASTED_DIR}/${name}`));
      } catch {
        this.recordAndBroadcast({ type: "notice", kind: "error", text: `I couldn't read ${base}.` });
      }
    }
    if (mentions.length > 0) {
      this.broadcast({ type: "insertText", text: `${mentions.join(" ")} ` });
    }
  }

  /**
   * A file the panel could read but not locate (VS Code hides real paths
   * from webviews): save its bytes under .meta-betta/pasted/ and mention it.
   */
  public async pasteFileBytes(name: string, base64Data: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.broadcast({ type: "noFolder" });
      return;
    }
    const root = folder.uri.fsPath;
    const base = path.basename(name.replace(/\\/g, "/")) || "pasted-file";
    const bytes = Buffer.from(base64Data, "base64");
    if (!pasteFileFits(bytes.length)) {
      this.recordAndBroadcast({ type: "notice", kind: "error", text: "That file's too big to paste (20 MB max)." });
      return;
    }
    try {
      const dir = path.join(root, PASTED_DIR);
      await fs.promises.mkdir(dir, { recursive: true });
      const taken = await fs.promises.readdir(dir).catch(() => [] as string[]);
      const saved = uniquePastedName(taken, base);
      await fs.promises.writeFile(path.join(dir, saved), bytes, { flag: "wx" });
      const isRepo = await fs.promises
        .stat(path.join(root, ".git"))
        .then(() => true)
        .catch(() => false);
      if (isRepo) {
        await ensureGitignoreEntry(root, PASTED_GITIGNORE);
      }
      this.broadcast({ type: "insertText", text: `${fileMention(`${PASTED_DIR}/${saved}`)} ` });
    } catch {
      this.recordAndBroadcast({ type: "notice", kind: "error", text: `I couldn't save ${base}.` });
    }
  }

  /** Drop waiting drafts, saying so when there were any. */
  private dropQueue(why: string): void {
    if (this.queue.size > 0) {
      this.log(queueDroppedNote(this.tabHost.uid, this.queue.size, why));
      for (const item of this.queue.list()) {
        if (!item.recorded) {
          this.broadcast({ type: "queueDrop", id: item.id });
        }
      }
    }
    this.queue.clear();
  }

  /** ✕ on a queued row: take it out and tidy the box. */
  public cancelQueued(id: string): void {
    if (this.queue.remove(id) === undefined) {
      return;
    }
    this.pendingImages.delete(id);
    this.broadcast({ type: "queueDrop", id });
    this.settleRetry();
  }

  /** Send now on a queued row: steer it into the running turn, else send it first next. */
  public async steerQueued(id: string): Promise<void> {
    const taken = this.queue.remove(id);
    if (taken === undefined) {
      return;
    }
    this.broadcast({ type: "queueDrop", id });
    const images = this.takeImages(id);
    if (images.length > 0) {
      // Steer can't carry pictures: the message (pictures and all) goes
      // first with the next turn instead. Quietly, per the brief.
      const front = this.queue.unshift(taken.text, taken.recorded, taken.attachments ?? []);
      if (front === undefined) {
        // Unreachable: removing just freed the slot.
        this.settleRetry();
        return;
      }
      this.pendingImages.set(front, images);
      if (!taken.recorded) {
        this.broadcast({ type: "queued", id: front, text: taken.text, ...sentAttachments(taken.attachments ?? []) });
      }
      this.settleRetry();
      this.ensureRetry();
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    let host: MuseHost | undefined;
    try {
      host = folder ? await this.ensureHost(folder) : undefined;
    } catch {
      host = undefined;
    }
    if (host && (await host.steer(taken.text))) {
      this.settleRetry();
      return;
    }
    // The turn just ended (or never started): it goes first, as a fresh turn.
    const front = this.queue.unshift(taken.text, taken.recorded);
    if (front === undefined) {
      const kept = taken.text.length > 120 ? `${taken.text.slice(0, 119)}…` : taken.text;
      this.recordAndBroadcast({
        type: "notice",
        kind: "info",
        text: `That turn just ended, and five messages are already waiting — this one didn't send: "${kept}"`,
      });
      this.settleRetry();
      return;
    }
    if (!taken.recorded) {
      this.broadcast({ type: "queued", id: front, text: taken.text });
    }
    this.recordAndBroadcast({
      type: "notice",
      kind: "info",
      text: "That turn just ended — sending it fresh.",
    });
    this.settleRetry();
    this.ensureRetry();
  }

  private ensureRetry(): void {
    this.retryTimer ??= setInterval(() => {
      void this.retryQueue();
    }, QUEUE_RETRY_MS);
    this.retryTimer.unref?.();
  }

  private async retryQueue(): Promise<void> {
    if (this.flushing) {
      return;
    }
    if (lockHolder() !== undefined) {
      // Waiting stays silent; the queue logs state changes only.
      this.showBusy();
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const next = this.queue.shift();
    this.flushing = true;
    try {
      if (next !== undefined && folder) {
        this.log(queueSentNote(this.tabHost.uid));
        if (!next.recorded) {
          // The muted row becomes the real bubble as its turn starts.
          this.broadcast({ type: "queueDrop", id: next.id });
          this.recordAndBroadcast({
            type: "user",
            text: next.text,
            at: Date.now(),
            ...sentAttachments(next.attachments ?? []),
          });
          this.storeSet(this.tabKey(LAST_MESSAGE_KEY), Date.now());
        }
        await this.sendNow(folder, next.text, this.takeImages(next.id));
      } else if (
        next === undefined &&
        this.pendingSave === "full" &&
        !this.running &&
        !this.saveRun &&
        folder &&
        this.memoryOn
      ) {
        this.pendingSave = undefined;
        await this.runSave(folder, false);
      }
    } finally {
      this.flushing = false;
    }
    this.settleRetry();
  }

  /** Refresh the busy line + box lock after the queue changes. */
  private settleRetry(): void {
    if (this.queue.size === 0 && this.pendingSave !== "full") {
      if (this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = undefined;
      }
      this.broadcast({ type: "busyDone" });
      this.broadcast({ type: "boxLock", locked: false });
      return;
    }
    this.showBusy();
  }

  private showBusy(): void {
    const holder = lockHolder();
    if (holder === undefined || this.queue.size === 0) {
      return;
    }
    if (holder === this.tabHost.uid) {
      // Our own turn is running: the box stays usable until five wait.
      this.broadcast({
        type: "boxLock",
        locked: this.queue.full,
        ...(this.queue.full ? { text: "Five messages are already waiting — it'll get to these" } : {}),
      });
      return;
    }
    const name = this.tabHost.labelOf(holder);
    const where = name === undefined ? "another chat" : `'${name}'`;
    this.broadcast({ type: "busy", text: `Muse is working in ${where}.` });
    this.broadcast({
      type: "boxLock",
      locked: this.queue.full,
      text: `Muse is working in ${where} — it'll get to these`,
    });
  }

  /** Go to it: reveal the tab running the turn. */
  public goToHolder(): void {
    const holder = lockHolder();
    if (holder !== undefined) {
      this.tabHost.revealTab(holder);
    }
  }

  /** Stop it: stop the tab running the turn; ours sends next. */
  public stopHolder(): void {
    const holder = lockHolder();
    if (holder !== undefined) {
      this.tabHost.stopTab(holder);
    }
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
    if (lockHolder() !== undefined) {
      this.retryWelcome(folder);
      return;
    }
    this.welcomeStep = "hello";
    this.welcomeHeard = false;
    this.broadcast({ type: "welcomeSkip", show: true });
    const host = await this.ensureHost(folder);
    try {
      await host.send(WELCOME_PROMPT, folder.uri.fsPath);
    } catch (error) {
      if (error instanceof TurnBusyError) {
        this.welcomeStep = undefined;
        this.broadcast({ type: "welcomeSkip", show: false });
        this.retryWelcome(folder);
        return;
      }
      throw error;
    }
  }

  /** The hello lost the lock race: try again in a bit, unless we're chatting. */
  private retryWelcome(folder: vscode.WorkspaceFolder): void {
    if (this.disposed || this.liveReplySeen) {
      return;
    }
    const timer = setTimeout(() => {
      if (!this.disposed) {
        void this.maybeWelcome(folder);
      }
    }, 5000);
    timer.unref?.();
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
      newChat: async () => this.newChat(),
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
      ...(card.details ? { details: card.details } : {}),
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
      ...(card.details ? { details: card.details } : {}),
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
    // Queued drafts belong to the old chat; switching drops them.
    this.dropQueue("switching chats");
    this.settleRetry();
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
    this.storeSet(this.tabKey(TRANSCRIPT_KEY), undefined);
    this.storeSet(this.tabKey(LAST_MESSAGE_KEY), undefined);
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
    this.tabHost.onUsage?.();
  }

  /** This chat's numbers plus today's sums, for the sidebar Usage view. */
  public usageSnapshot(): {
    session?: SessionUsageTotals;
    today: { totalTokens: number; usd: number };
  } {
    const today = sumDayUsage(cleanDayUsage(this.globalState?.get<unknown>(DAILY_USAGE_KEY)), todayKey());
    return { session: this.lastUsage, today };
  }

  /** The account allowance slices, or none when they can't be read. */
  public async usageAllowance(): Promise<{ weekly?: AllowanceSlice; window?: AllowanceSlice }> {
    try {
      const { host, root } = await this.slashHost();
      return await host.readSubscription(root);
    } catch {
      return {};
    }
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

  /**
   * Fork snapshot-forks the Muse session, then opens it in a new focused
   * tab. The fork is a session command, not a turn: it never takes the lock,
   * even mid-turn.
   */
  private async slashFork(): Promise<void> {
    const { host, root } = await this.slashHost();
    // The fork shows the conversation it came from: both sides plus step rows.
    const transcript = buildForkTranscript(this.history);
    this.tabHost.onForkTab(await host.forkSession(root), transcript, this.sessionTopic);
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
    this.storeSet(this.tabKey(EFFORT_KEY), level);
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

  /** A shortcut pill (left-click): Goal asks, the rest run their / command. */
  public runShortcut(id: string): void {
    const target = shortcutDispatch(id);
    if (target === "askGoal") {
      void this.askGoal();
    } else if (target === "slash") {
      void this.dispatchSlash(id, "");
    }
    // Unknown pills are quietly ignored (a stale panel after an update).
  }

  /** A shortcut pill (right-click pick): swap it in and save the slots. */
  public pickShortcut(index: number, id: string): void {
    const slots = swapShortcutSlot(this.shortcutSlots(), index, id);
    this.saveShortcutSlots(slots);
    this.broadcast({ type: "shortcutSlots", slots });
  }

  /** Back to Goal · Side · Fork · Usage on every pill. */
  public resetShortcuts(): void {
    const slots = [...DEFAULT_SHORTCUT_SLOTS];
    this.saveShortcutSlots(slots);
    this.broadcast({ type: "shortcutSlots", slots });
  }

  /** This user's pill choices, shared by every project. */
  private shortcutSlots(): string[] {
    return cleanShortcutSlots(this.globalState?.get<unknown>(SHORTCUT_SLOTS_KEY));
  }

  private saveShortcutSlots(slots: string[]): void {
    void this.globalState?.update(SHORTCUT_SLOTS_KEY, slots).then(undefined, () => undefined);
  }

  /** The Effort button menu: set the picked level, same call as /effort. */
  public async setEffortLevel(level: string): Promise<void> {
    if (!(EFFORT_LEVELS as string[]).includes(level)) {
      return;
    }
    try {
      await this.slashContext().setEffort(level as EffortLevel);
    } catch (error) {
      this.recordAndBroadcast({
        type: "notice",
        kind: "error",
        text: `Couldn't set the effort: ${commandErrorText(error)}.`,
      });
    }
  }

  public async setApprovalsLevel(mode: string): Promise<void> {
    if (!(APPROVAL_CHOICES as string[]).includes(mode)) {
      return;
    }
    const choice = mode as ApprovalChoice;
    if (choice === this.lastApprovals) {
      return;
    }
    try {
      const { host, root } = await this.slashHost();
      if (choice === "all") {
        const confirm = await vscode.window.showWarningMessage(
          "Muse will run any command in this chat without asking — even outside this folder. Turn it on for this chat only?",
          "Turn on All",
          "Cancel",
        );
        if (confirm !== "Turn on All") {
          return;
        }
        await host.setApprovalAll(root);
        this.lastApprovals = "all";
        this.storeSet(this.tabKey(APPROVAL_ALL_KEY), this.loadSessionId() ?? "");
      } else {
        if (this.lastApprovals === "all") {
          await host.clearApprovalAll(root);
          this.storeSet(this.tabKey(APPROVAL_ALL_KEY), undefined);
        }
        host.setLocalApprovalMode(choice);
        this.lastApprovals = choice;
        this.storeSet(this.tabKey(APPROVALS_KEY), choice);
      }
      this.broadcast({ type: "approvals", mode: this.lastApprovals, modes: approvalsMenu(this.lastApprovals) });
    } catch (error) {
      this.recordAndBroadcast({
        type: "notice",
        kind: "error",
        text: `Couldn't switch approvals: ${commandErrorText(error)}.`,
      });
      this.broadcast({ type: "approvals", mode: this.lastApprovals, modes: approvalsMenu(this.lastApprovals) });
    }
  }

  /** Clear the panel view: the chat, undos and brain all stay. */
  public clearView(): void {
    this.history = [];
    this.storeSet(this.tabKey(TRANSCRIPT_KEY), undefined);
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
    this.postMemoryNoteOnce();
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
      if (!needsCatchUp(this.storage.get<number>(this.tabKey(LAST_MESSAGE_KEY)), Date.now(), afterHours)) {
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
    const hanging = previousUserLeftHanging(this.history);
    const background = buildBackgroundBlock(
      { me, project, tricks, todayLog },
      {
        greeting: isGreetingMessage(text),
        // A bare slash run leaves no assistant reply; that isn't unfinished.
        unfinished: hanging && !parseSlashCommand(hanging) ? hanging : undefined,
      },
    );
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
    if (lockHolder() !== undefined) {
      // A save is a turn too: it waits for the lock with the rest. Quick
      // saves just skip a round; a full save says so and retries.
      if (!quick) {
        this.pendingSave = "full";
        this.broadcast({
          type: "notice",
          kind: "info",
          text: "Muse is busy in another chat — I'll save when it's free.",
        });
        this.ensureRetry();
      }
      return;
    }
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
    try {
      await host.send(quick ? QUICK_SAVE_PROMPT : SAVE_MY_DAY_PROMPT, folder.uri.fsPath);
    } catch (error) {
      if (error instanceof TurnBusyError) {
        this.saveRun = undefined;
        this.setStatus("Ready");
        if (!quick) {
          this.pendingSave = "full";
          this.broadcast({
            type: "notice",
            kind: "info",
            text: "Muse is busy in another chat — I'll save when it's free.",
          });
          this.ensureRetry();
        }
        return;
      }
      throw error;
    }
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
      // An ignored brain (like this repo's own) never gets a commit prompt.
      execFile("git", ["check-ignore", "-q", "brain"], { cwd: root }, (ignoreError) => {
        const offer = brainCommitOffer(ignoreError);
        if (offer === "quiet") {
          return;
        }
        if (offer === "error") {
          this.broadcast({ type: "notice", kind: "error", text: "Couldn't commit the brain." });
          return;
        }
        void vscode.window
          .showInformationMessage("Also commit the brain?", "Commit brain")
          .then((choice) => {
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
    const warning = undoCommitWarning(target.committed);
    if (warning) {
      lines.unshift(warning, "");
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

  private async takeBeforeSnapshot(folder: vscode.WorkspaceFolder): Promise<BeforeState | undefined> {
    try {
      const shadow = await this.shadowFor(folder);
      if (!shadow) {
        return undefined;
      }
      const snapshot = await shadow.snapshot("before turn");
      const bin = this.shadowCache?.bin ?? "";
      const headBefore = await readGitHead(bin, folder.uri.fsPath);
      return { sha: snapshot.sha, at: Date.now(), excluded: snapshot.excluded, headBefore };
    } catch (error) {
      this.snapshotFailed(error);
      return undefined;
    }
  }

  /** After-snapshot, then an Undo button when the turn changed files. */
  private async finishTurnSnapshot(before: BeforeState | undefined): Promise<void> {
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
      const headAfter = await readGitHead(this.shadowCache?.bin ?? "", folder.uri.fsPath);
      const committed = gitHeadMoved(before.headBefore, headAfter);
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
        ...(committed ? { committed: true } : {}),
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

  /**
   * New opens a fresh tab and focuses it. This chat is untouched: no
   * confirm, nothing is lost.
   */
  public newChat(): void {
    this.tabHost.onNewTab();
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
    this.disposed = true;
    clearInterval(this.tickTimer);
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.dropQueue("closing");
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
      // First run once, in the first chat: install → connect → sandbox →
      // test turn, then resume and the welcome carry on below.
      if (this.tabHost.uid === MAIN_TAB_UID) {
        const trust = await this.ensureMemory(folder);
        this.setStatus("Setting Muse up…");
        try {
          await runFirstRun(this.firstRunDeps(folder, trust));
        } finally {
          if (!this.disposed) {
            this.setStatus("Ready");
          }
        }
      }
      const host = await this.ensureHost(folder);
      const savedId = this.loadSessionId();
      if (!savedId?.trim()) {
        this.log("Resume: none (no saved session)");
      } else {
        this.replaying = true;
        const resumeId = savedId.trim() || undefined;
        this.replayer = new UndoReplayer([...this.undos.values()], resumeId);
        try {
          // A fork replays its seed, never server history: the seed is the
          // full source transcript (both sides plus step rows).
          const forkSeed =
            this.tabHost.seed?.transcript !== undefined
              ? cleanTranscript(this.tabHost.seed.transcript)
              : undefined;
          let shown = 0;
          this.quietAttach = forkSeed !== undefined;
          try {
            shown = await host.prepare(folder.uri.fsPath);
          } catch {
            // Leave the panel usable; send() surfaces startup problems properly.
            shown = 0;
          } finally {
            this.quietAttach = false;
          }
          if (forkSeed !== undefined || shown === 0) {
            let stored: TranscriptEntry[];
            if (forkSeed !== undefined) {
              stored = forkSeed;
              this.log(`Resume: fork seed (${stored.length} entries)`);
            } else {
              const own = cleanTranscript(this.storage.get<unknown>(this.tabKey(TRANSCRIPT_KEY)));
              stored = own.length > 0 ? own : cleanTranscript(this.tabHost.seed?.transcript);
              this.log(`Resume: stored transcript (${stored.length} entries)`);
            }
            const replayed = new Set<string>();
            // Replayed turns regroup like live ones: each user entry opens a
            // span, closed with a derived line before the next user entry or
            // the end. Entries before the first user stay flat (their turn is
            // cut off, so no span can be known).
            let span:
              | {
                  userAt?: number;
                  lastAt?: number;
                  finalId?: string;
                  reads: number;
                  commands: number;
                  edits: number;
                }
              | undefined;
            const closeSpan = (): void => {
              if (!span) {
                return;
              }
              const seconds =
                span.userAt !== undefined && span.lastAt !== undefined
                  ? Math.max(0, Math.round((span.lastAt - span.userAt) / 1000))
                  : 0;
              const done = {
                type: "turn" as const,
                state: "done" as const,
                replay: true,
                ...(span.finalId ? { finalId: span.finalId } : {}),
                line: formatWorkLog({
                  seconds,
                  reads: span.reads,
                  commands: span.commands,
                  edits: span.edits,
                }),
              };
              span = undefined;
              this.recordAndBroadcast(done);
            };
            stored.forEach((entry, index) => {
              if (entry.role === "undo" && entry.id) {
                this.emitReplayedUndo(entry.id);
                replayed.add(entry.id);
                this.log(`${entry.id}: replayed from stored transcript`);
              } else if (entry.role === "nudge" && entry.id && entry.answer) {
                this.recordAndBroadcast({ type: "nudgeAnswered", id: entry.id, answer: entry.answer });
              } else if (entry.role === "tool") {
                if (span) {
                  if (entry.group === "read" || entry.group === "search") {
                    span.reads += 1;
                  } else if (entry.group === "command") {
                    span.commands += 1;
                  } else if (entry.group === "edit") {
                    span.edits += 1;
                  }
                }
                this.recordAndBroadcast({
                  type: "tool",
                  id: entry.id ?? `stored-${index}`,
                  text: entry.text,
                  done: true,
                  ...(entry.group ? { group: entry.group as StepGroup } : {}),
                  ...(entry.failed === true ? { failed: true } : {}),
                });
              } else if (entry.role === "thinking") {
                this.recordAndBroadcast({
                  type: "thinking",
                  id: entry.id ?? `stored-${index}`,
                  text: entry.text,
                });
              } else if (entry.role === "user") {
                closeSpan();
                this.recordAndBroadcast({
                  type: "user",
                  text: entry.text,
                  at: entry.at,
                  ...sentAttachments(entry.attachments ?? []),
                });
                this.recordAndBroadcast({ type: "turn", state: "started", replay: true });
                span = { userAt: entry.at, reads: 0, commands: 0, edits: 0 };
              } else {
                if (span) {
                  span.lastAt = entry.at ?? span.lastAt;
                  span.finalId = `stored-${index}`;
                }
                this.recordAndBroadcast({
                  type: "assistant",
                  id: `stored-${index}`,
                  text: entry.text,
                  at: entry.at,
                });
              }
            });
            closeSpan();
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
    this.host = this.createHost(trustWorkspace, await this.readApiKey());
    return this.host;
  }

  /** The saved API key, if any. SecretStorage failures read as "no key". */
  private async readApiKey(): Promise<string | undefined> {
    try {
      return (await this.secrets?.get(API_KEY_SECRET))?.trim() || undefined;
    } catch {
      return undefined;
    }
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
    const seed = this.tabHost.seed;
    if (seed?.labelId) {
      // A revived tab keeps its own label; whoever loads first wins it.
      this.sessionId = seed.labelId;
      this.sessionTopic = seed.topic ?? "";
      const live = cleanLiveLabels(this.storage.get<unknown>(LIVE_LABELS_KEY));
      if (isLabelTaken(seed.labelId, live, Date.now())) {
        this.diverged = true;
        this.sessionId = createSessionId();
      }
      this.broadcastSessionLabel();
      this.tabChanged({ labelId: this.sessionId, topic: this.sessionTopic });
      this.heartbeat();
      return;
    }
    if (seed?.topic) {
      // A forked tab inherits the source topic; its id stays its own.
      this.sessionTopic = seed.topic;
      this.broadcastSessionLabel();
      this.tabChanged({ labelId: this.sessionId, topic: this.sessionTopic });
      this.heartbeat();
      return;
    }
    // Only the first tab adopts the pre-tabs label; a fresh tab keeps the
    // id it minted, and its title follows it from there.
    if (adoptsStoredLabel(this.tabHost.uid, seed)) {
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
        this.tabChanged({ labelId: this.sessionId, topic: this.sessionTopic });
      }
    }
    this.heartbeat();
  }

  private persistSessionLabel(): void {
    this.labelSettled = true;
    // The shared key is the first tab's; other tabs keep theirs in the record.
    if (!this.diverged && this.tabHost.uid === MAIN_TAB_UID) {
      this.storeSet(SESSION_LABEL_KEY, { id: this.sessionId, topic: this.sessionTopic });
    }
    this.tabChanged({ labelId: this.sessionId, topic: this.sessionTopic });
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

  /**
   * The first-run checklist's world: real processes, secrets, cards and a
   * throwaway test turn. The key travels to child envs, never to cards.
   */
  private firstRunDeps(folder: vscode.WorkspaceFolder, trustWorkspace: boolean): FirstRunDeps {
    const config = vscode.workspace.getConfiguration("metaBetta");
    const museDir = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "muse");
    return {
      platform: process.platform,
      workaroundOn: config.get<boolean>("windowsSandboxWorkaround", true),
      settingBin: config.get<string>("museBin", ""),
      museDir,
      dirFiles: () => {
        try {
          return fs.readdirSync(museDir);
        } catch {
          return [];
        }
      },
      fileExists: (target) => {
        try {
          return fs.existsSync(target);
        } catch {
          return false;
        }
      },
      pathHas: (name) => this.firstRunPathHas(name),
      run: (spec) => this.runFirstRunProc(spec),
      testTurn: () => this.runFirstRunTestTurn(folder, trustWorkspace),
      secrets: {
        get: async () => this.secrets?.get(API_KEY_SECRET),
        set: async (value) => {
          await this.secrets?.store(API_KEY_SECRET, value);
        },
        remove: async () => {
          await this.secrets?.delete(API_KEY_SECRET);
        },
      },
      store: {
        readyCached: () => this.globalState?.get<boolean>(FIRST_RUN_READY_KEY) ?? false,
        setReadyCached: () => {
          void this.globalState?.update(FIRST_RUN_READY_KEY, true);
        },
      },
      ui: {
        showCard: (card, handlers) => this.showCard(card, handlers),
        updateCard: (id, card) => this.updateCard(id, card),
        notice: (kind, text) => this.recordAndBroadcast({ type: "notice", kind, text }),
        openUrl: (url) => {
          void this.openLink(url);
        },
      },
      log: (message) => this.log(message),
    };
  }

  /** `where` on Windows, `command -v` elsewhere: is this name on PATH? */
  private async firstRunPathHas(name: string): Promise<boolean> {
    const spec: RunSpec =
      process.platform === "win32"
        ? { command: "where", args: [name], label: `where ${name}`, timeoutMs: 10_000 }
        : {
            command: "sh",
            args: ["-c", `command -v -- ${shQuote(name)}`],
            label: `command -v ${name}`,
            timeoutMs: 10_000,
          };
    const result = await this.runFirstRunProc(spec);
    return result.exitCode === 0;
  }

  /**
   * One first-run background process: hidden window, ignored stdin, capped
   * output. Always resolves; spawn failures come back as exit code 1.
   */
  private runFirstRunProc(spec: RunSpec): Promise<RunResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (exitCode: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve({ exitCode, stdout, stderr, timedOut });
      };
      const grow = (current: string, text: string): string => {
        const next = current + text;
        return next.length > 65_536 ? next.slice(next.length - 65_536) : next;
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spec.command, spec.args, {
          stdio: ["ignore", "pipe", "pipe"],
          ...(spec.env ? { env: spec.env } : {}),
          windowsHide: true,
        });
      } catch {
        done(1);
        return;
      }
      if (spec.timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill();
          done(1);
        }, spec.timeoutMs);
        timer.unref?.();
      }
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        stdout = grow(stdout, text);
        spec.onChunk?.(text);
      });
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        stderr = grow(stderr, text);
        spec.onChunk?.(text);
      });
      child.on("error", () => done(1));
      child.on("close", (code) => done(code ?? 1));
    });
  }

  /**
   * The setup proof: a throwaway host asks for "ready" with no panel
   * attached, so the chat stays clean whatever comes back.
   */
  private async runFirstRunTestTurn(
    folder: vscode.WorkspaceFolder,
    trustWorkspace: boolean,
  ): Promise<{ ok: boolean; reason?: string }> {
    const config = vscode.workspace.getConfiguration("metaBetta");
    const key = await this.readApiKey();
    let assistant = "";
    let failure: string | undefined;
    const host = new MuseHost({
      museBin: findMuseBin(config.get<string>("museBin", "")),
      version: readVersion(this.extensionUri),
      trustWorkspace,
      apiKey: key,
      emit: (event) => {
        if (event.type === "assistant") {
          assistant += event.text;
        } else if (event.type === "notice" && event.kind === "error" && !failure) {
          failure = event.text;
        }
      },
      askApproval: () => Promise.resolve(undefined),
      log: (message) => this.log(message),
      sandboxWorkaround: config.get<boolean>("windowsSandboxWorkaround", true),
      turnOwner: `firstrun-${Date.now().toString(36)}`,
    });
    const send = host.send("Reply with just: ready", folder.uri.fsPath);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      send.then(
        () => "sent" as const,
        (error: unknown) => ({ error }) as const,
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), TEST_TURN_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (outcome === "timeout") {
      this.log("First run: the test turn timed out");
      await host.dispose().catch(() => undefined);
      send.catch(() => undefined);
      return { ok: false, reason: "it took too long" };
    }
    await host.dispose().catch(() => undefined);
    if (typeof outcome !== "string") {
      if (outcome.error instanceof TurnBusyError) {
        return { ok: false, reason: "Muse is busy in another chat" };
      }
      return { ok: false, reason: shortReason(outcome.error) };
    }
    if (failure) {
      return { ok: false, reason: failure };
    }
    if (!assistant.trim()) {
      return { ok: false, reason: "the reply came back empty" };
    }
    return { ok: true };
  }

  /** Starting failed later on: clear "ready" and offer the setup again. */
  private setupNeeded(info: SetupNeededInfo): void {
    void this.globalState?.update(FIRST_RUN_READY_KEY, undefined);
    if (this.disposed || this.setupCardOpen) {
      return;
    }
    if (!vscode.workspace.workspaceFolders?.[0]) {
      return;
    }
    this.setupCardOpen = true;
    const body =
      info.problem === "missing"
        ? "I can't find Muse Code."
        : info.problem === "login"
          ? "Muse isn't connected."
          : `Starting Muse didn't work (${info.reason}).`;
    this.showCard(
      { title: "Muse needs setting up again", body, buttons: [{ id: "setup", label: "Run setup" }] },
      {
        onButton: (button) => {
          if (button !== "setup" || this.disposed) {
            return;
          }
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (!folder) {
            return;
          }
          this.setupCardOpen = false;
          void this.rerunSetup(folder);
        },
      },
    );
  }

  private async rerunSetup(folder: vscode.WorkspaceFolder): Promise<void> {
    // Fixed from another chat while the card sat here: nothing to do.
    if (this.globalState?.get<boolean>(FIRST_RUN_READY_KEY)) {
      return;
    }
    const trust = await this.ensureMemory(folder);
    this.setStatus("Setting Muse up…");
    try {
      await runFirstRun(this.firstRunDeps(folder, trust));
    } finally {
      if (!this.disposed) {
        this.setStatus("Ready");
      }
    }
  }

  /** A session left in All when the window closed (the host reverts it on resume). */
  private approvalAllFlag(): string | undefined {
    const flag = this.storage.get<unknown>(this.tabKey(APPROVAL_ALL_KEY));
    return typeof flag === "string" && flag !== "" ? flag : undefined;
  }

  /** Forget the saved API key. The host is rebuilt keyless on next send. */
  public async forgetApiKey(): Promise<void> {
    try {
      await this.secrets?.delete(API_KEY_SECRET);
    } catch {
      // Missing is fine; the key is gone either way.
    }
    if (this.host) {
      await this.host.dispose().catch(() => undefined);
      this.host = undefined;
    }
    if (this.lastApprovals === "all") {
      // The rebuilt host reverts the session via the leftover flag; the UI
      // goes back to Auto now so the two never disagree.
      this.lastApprovals = "auto";
      this.storeSet(this.tabKey(APPROVALS_KEY), "auto");
      this.broadcast({ type: "approvals", mode: "auto", modes: approvalsMenu("auto") });
    }
    void this.globalState?.update(FIRST_RUN_READY_KEY, undefined);
    this.recordAndBroadcast({
      type: "notice",
      kind: "info",
      text: "Forgotten — your API key is gone from this machine.",
    });
  }

  private createHost(trustWorkspace: boolean, apiKey?: string): MuseHost {
    const config = vscode.workspace.getConfiguration("metaBetta");
    const workaround = config.get<boolean>("windowsSandboxWorkaround", true);
    this.shellWorkaround = process.platform === "win32" && workaround;
    return new MuseHost({
      museBin: findMuseBin(config.get<string>("museBin", "")),
      version: readVersion(this.extensionUri),
      trustWorkspace,
      apiKey,
      onSetupNeeded: (info) => this.setupNeeded(info),
      approvalMode: this.lastApprovals === "ask" ? "ask" : "auto",
      approvalAllLeftOn: this.approvalAllFlag(),
      onApprovalAllReverted: () => this.storeSet(this.tabKey(APPROVAL_ALL_KEY), undefined),
      emit: (event) => this.onHostEvent(event),
      askApproval: (card) => this.askApproval(card),
      log: (message) => this.log(message),
      sandboxWorkaround: workaround,
      turnOwner: this.tabHost.uid,
      sessionStore: {
        loadId: () => this.loadSessionId(),
        saveId: (id) => {
          this.museSessionId = id;
          this.tabChanged({ session: id });
          if (this.tabHost.uid === MAIN_TAB_UID) {
            this.storeSet(SESSION_ID_KEY, id);
          }
        },
        clear: () => {
          this.tabChanged({ session: undefined });
          // The dead session id goes; the stored transcript and clock stay
          // as the fallback, so a failed resume never wipes the visible chat.
          for (const key of clearedKeysOnFailedResume(this.tabHost.uid)) {
            this.storeSet(key, undefined);
          }
          // Undo history stays: the snapshots are still valid.
          this.anchorHigh = 0;
        },
      },
    });
  }

  private storeSet(key: string, value: unknown): void {
    void this.storage.update(key, value).then(undefined, () => undefined);
  }

  /** This tab's id. */
  public get tabUid(): string {
    return this.tabHost.uid;
  }

  /** The status bar text for the active-tab handoff. */
  public statusBarText(): string {
    return formatStatusBar(this.lastUsage);
  }

  /**
   * Per-tab storage key. The first tab keeps the pre-tabs keys (no
   * migration); other tabs suffix their own.
   */
  private tabKey(base: string): string {
    return tabStorageKey(base, this.tabHost.uid);
  }

  /** Report a session/label/topic change for the tab record + title. */
  private tabChanged(record: TabRecord): void {
    this.tabHost.onChanged(record);
  }

  private persistTranscript(): void {
    this.storeSet(this.tabKey(TRANSCRIPT_KEY), buildTranscript(this.history));
  }

  /** The session to resume: the tab's seed, else (first tab) the pre-tabs key. */
  private loadSessionId(): string | undefined {
    return (
      this.tabHost.seed?.session ??
      (this.tabHost.uid === MAIN_TAB_UID ? this.storage.get<string>(SESSION_ID_KEY) : undefined)
    );
  }

  private persistUndos(): void {
    this.storeSet(UNDOS_KEY, [...this.undos.values()].slice(-100));
  }

  private onHostEvent(event: MuseHostEvent): void {
    // Fork attach: the session still connects, but its history stays out —
    // the seed transcript replays instead, steps and all.
    if (
      this.quietAttach &&
      (event.type === "user" || event.type === "assistant" || event.type === "thinking")
    ) {
      return;
    }
    // State updates, not chat: they apply during saves too.
    if (event.type === "usage") {
      this.recordUsage(event.usage);
      return;
    }
    if (event.type === "goal") {
      this.lastGoal = event.goal;
      this.storeSet(this.tabKey(GOAL_KEY), event.goal);
      this.broadcast({ type: "goal", goal: event.goal });
      return;
    }
    if (event.type === "effort") {
      this.lastEffort = event.level;
      this.storeSet(this.tabKey(EFFORT_KEY), event.level);
      this.broadcast({ type: "effort", level: event.level });
      return;
    }
    if (event.type === "model") {
      // No persistent display; /model lists fresh.
      return;
    }
    if (event.type === "draft") {
      // A rejected picture: the words go back in the box, unrecorded.
      this.broadcast({ type: "draft", text: event.text });
      return;
    }
    const save = this.saveRun;
    if (save) {
      this.onSaveEvent(event, save);
      return;
    }
    if (event.type === "turn") {
      if (event.replay === true) {
        // A resumed span regroups the panel, with none of a live turn's chores.
        this.recordAndBroadcast(event);
        return;
      }
      this.running = event.state === "started";
      this.recordAndBroadcast(event);
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
      this.broadcast({ ...event, save: true });
      if (!this.running) {
        this.persistTranscript();
      }
      return;
    }
    if (event.type === "status") {
      // Keep "Saving…" until the save itself reports.
      return;
    }
    if (event.type === "picker" || event.type === "approvalDone") {
      // Pickers are never recorded: an answered request leaves only its row.
      this.broadcast(event);
      return;
    }
    // Thinking and tool rows stay out of the chat during a save.
  }

  private askApproval(picker: PickerEvent): Promise<ApprovalAnswer | undefined> {
    if (this.sinks.size === 0 || !this.running) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.approvalResolvers.set(picker.id, resolve);
      this.maybeShellNotice(picker);
      // Broadcast, never recorded: the answered row is the history.
      this.broadcast(picker);
    });
  }

  /**
   * One plain line the first time a command picker appears (Windows
   * workaround only), then never again for this folder.
   */
  private maybeShellNotice(picker: PickerEvent): void {
    if (picker.kind !== "shell" || !this.shellWorkaround) {
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

/** Route one webview message to the controller. Shared by every chat tab. */
export function routeViewMessage(controller: ChatController, message: unknown): void {
  if (!isRecord(message)) {
    return;
  }
  if (message.type === "stop") {
    controller.stop();
    return;
  }
  if (message.type === "dequeue" && typeof message.id === "string") {
    controller.cancelQueued(message.id);
    return;
  }
  if (message.type === "steerQueue" && typeof message.id === "string") {
    void controller.steerQueued(message.id);
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
    controller.newChat();
    return;
  }
  if (message.type === "goToHolder") {
    controller.goToHolder();
    return;
  }
  if (message.type === "stopHolder") {
    controller.stopHolder();
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
  if (message.type === "shortcut" && typeof message.id === "string") {
    controller.runShortcut(message.id);
    return;
  }
  if (
    message.type === "shortcutPick" &&
    typeof message.index === "number" &&
    Number.isInteger(message.index) &&
    typeof message.id === "string"
  ) {
    controller.pickShortcut(message.index, message.id);
    return;
  }
  if (message.type === "shortcutReset") {
    controller.resetShortcuts();
    return;
  }
  if (message.type === "effortSet" && typeof message.level === "string") {
    void controller.setEffortLevel(message.level);
    return;
  }
  if (message.type === "approvalsSet" && typeof message.mode === "string") {
    void controller.setApprovalsLevel(message.mode);
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
  if (message.type === "dropFiles" && Array.isArray(message.paths)) {
    const paths = message.paths.filter((entry): entry is string => typeof entry === "string");
    if (paths.length > 0) {
      void controller.resolveDrop(paths);
    }
    return;
  }
  if (message.type === "pasteFileBytes" && typeof message.name === "string" && typeof message.base64Data === "string") {
    void controller.pasteFileBytes(message.name, message.base64Data);
    return;
  }
  if (message.type === "attachNote" && typeof message.text === "string" && message.text.trim() !== "") {
    controller.attachNote(message.text.trim());
    return;
  }
  const send = parseSendWithImages(message);
  if (send !== undefined) {
    void controller.send(send.text, send.images);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Picture names riding on a user or queued message, when there are any. */
function sentAttachments(names: readonly string[]): { attachments: string[] } | Record<string, never> {
  const kept = names.filter((name) => name !== "");
  return kept.length > 0 ? { attachments: [...kept] } : {};
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
