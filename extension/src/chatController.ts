import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseSendMessage } from "./lib/chat.js";
import { parseFileLink } from "./lib/links.js";
import { buildTranscript, cleanTranscript } from "./lib/session.js";
import { shortReason } from "./lib/startup.js";
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
  formatSaveTime,
  formatSessionLabel,
  isLabelTaken,
  LIVE_LABEL_TTL_MS,
  needsCatchUp,
  nodeBrainFs,
  splitSaveReply,
  todayLogFile,
  topicFromFirstMessage,
  UnsafeBackupError,
  type SaveSection,
  type SaveSections,
} from "./brain/brain.js";
import { QUICK_SAVE_PROMPT, SAVE_MY_DAY_PROMPT } from "./brain/prompts.js";
import { singleFlight } from "./lib/singleFlight.js";
import { findMuseBin } from "./muse/resolveBin.js";
import { type ApprovalCardEvent, MuseHost, type MuseHostEvent } from "./muse/museHost.js";

/** One attached chat surface: the editor panel or the sidebar view. */
export interface ChatSink {
  post(message: unknown): void;
}

export interface SavedSection {
  title: string;
  text: string;
}

type TranscriptEvent =
  | { type: "user"; text: string }
  | { type: "assistant"; id: string; text: string }
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; text: string; done: boolean }
  | ApprovalCardEvent
  | { type: "approvalDone"; id: string }
  | { type: "notice"; text: string; copy?: string; kind: "info" | "error" }
  | { type: "saved"; text: string; backup?: string; sections: SavedSection[] };

const HISTORY_LIMIT = 500;
const SESSION_ID_KEY = "metaBetta.sessionId";
const SESSION_LABEL_KEY = "metaBetta.sessionLabel";
const TRANSCRIPT_KEY = "metaBetta.transcript";
const LAST_MESSAGE_KEY = "metaBetta.lastMessageAt";
const LIVE_LABELS_KEY = "metaBetta.liveLabels";
/** Heartbeat + quick-save check, twice a minute. */
const TICK_MS = 30_000;
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
  private readonly tickTimer: ReturnType<typeof setInterval>;
  private approvalResolvers = new Map<string, (choiceId: string | undefined) => void>();
  private readonly createHostShared = singleFlight((folder: vscode.WorkspaceFolder) =>
    this.createHostAsync(folder),
  );

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: vscode.Memento,
    private readonly onBrainChanged: (files: string[]) => void = () => undefined,
  ) {
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
    // "continue working on X" always starts a newly labelled episode, even
    // mid-conversation; any other first message just names the topic.
    const continued = continuedTopic(text);
    if (continued !== undefined) {
      this.sessionId = createSessionId();
      this.sessionTopic = continued;
      this.persistSessionLabel();
      this.broadcastSessionLabel();
    } else if (!this.sessionTopic) {
      const topic = topicFromFirstMessage(text);
      if (topic) {
        this.sessionTopic = topic;
        this.persistSessionLabel();
        this.broadcastSessionLabel();
      }
    }
    this.recordAndBroadcast({ type: "user", text });
    this.storeSet(LAST_MESSAGE_KEY, Date.now());
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
    await host.send(await this.withBackground(folder, text), folder.uri.fsPath);
  }

  /**
   * On the first send before any live reply (memory on), read the brain and
   * attach it as background, showing a friendly placeholder meanwhile.
   */
  private async withBackground(folder: vscode.WorkspaceFolder, text: string): Promise<string> {
    if (!this.memoryOn || this.liveReplySeen) {
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
      entries.push({ file: "project.md", text: sections.project });
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

  public approve(id: string, choiceId: string): void {
    this.approvalResolvers.get(id)?.(choiceId);
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
    this.forceCatchUp = true;
    this.running = false;
    this.lastStatus = "";
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
    this.storeSet(LIVE_LABELS_KEY, live);
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
      const folder = vscode.workspace.workspaceFolders?.[0];
      const savedId = this.storage.get<string>(SESSION_ID_KEY);
      if (!folder || !savedId?.trim()) {
        return;
      }
      const host = await this.ensureHost(folder);
      let shown = 0;
      try {
        shown = await host.prepare(folder.uri.fsPath);
      } catch {
        // Leave the panel usable; send() surfaces startup problems properly.
        shown = 0;
      }
      if (shown === 0) {
        const stored = cleanTranscript(this.storage.get<unknown>(TRANSCRIPT_KEY));
        stored.forEach((entry, index) => {
          this.recordAndBroadcast(
            entry.role === "user"
              ? { type: "user", text: entry.text }
              : { type: "assistant", id: `stored-${index}`, text: entry.text },
          );
        });
      }
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
    return new MuseHost({
      museBin: findMuseBin(vscode.workspace.getConfiguration("metaBetta").get<string>("museBin", "")),
      version: readVersion(this.extensionUri),
      trustWorkspace,
      emit: (event) => this.onHostEvent(event),
      askApproval: (card) => this.askApproval(card),
      sessionStore: {
        loadId: () => this.storage.get<string>(SESSION_ID_KEY),
        saveId: (id) => this.storeSet(SESSION_ID_KEY, id),
        clear: () => {
          this.storeSet(SESSION_ID_KEY, undefined);
          this.storeSet(TRANSCRIPT_KEY, undefined);
          this.storeSet(LAST_MESSAGE_KEY, undefined);
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

  private onHostEvent(event: MuseHostEvent): void {
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
    if (event.type === "assistant" && this.running) {
      this.liveReplySeen = true;
    }
    this.recordAndBroadcast(event);
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

  private askApproval(card: ApprovalCardEvent): Promise<string | undefined> {
    if (this.sinks.size === 0 || !this.running) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.approvalResolvers.set(card.id, resolve);
      this.recordAndBroadcast(card);
    });
  }

  private recordAndBroadcast(event: TranscriptEvent): void {
    // Streaming updates replace their earlier self, so history stays compact
    // and a replay shows each bubble once, in its final state.
    const upsertId =
      event.type === "assistant" || event.type === "thinking" || event.type === "tool" ? event.id : undefined;
    if (upsertId !== undefined) {
      const index = this.history.findIndex(
        (entry) => entry.type === event.type && (entry as { id?: string }).id === upsertId,
      );
      if (index >= 0) {
        this.history[index] = event;
        this.broadcast(event);
        return;
      }
    }
    this.history.push(event);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    this.broadcast(event);
    if (event.type === "user") {
      this.persistTranscript();
    }
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
    controller.approve(message.id, message.choiceId);
    return;
  }
  if (message.type === "openLink" && typeof message.url === "string") {
    void controller.openLink(message.url);
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
