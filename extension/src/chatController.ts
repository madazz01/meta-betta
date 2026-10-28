import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseSendMessage } from "./lib/chat.js";
import { parseFileLink } from "./lib/links.js";
import { buildTranscript, cleanTranscript } from "./lib/session.js";
import { shortReason } from "./lib/startup.js";
import {
  cleanSessionLabel,
  cleanTopic,
  continuedTopic,
  createSessionId,
  ensureBrain,
  ensureFrontDoor,
  formatSessionLabel,
  topicFromFirstMessage,
} from "./brain/brain.js";
import { singleFlight } from "./lib/singleFlight.js";
import { findMuseBin } from "./muse/resolveBin.js";
import { type ApprovalCardEvent, MuseHost, type MuseHostEvent } from "./muse/museHost.js";

/** One attached chat surface: the editor panel or the sidebar view. */
export interface ChatSink {
  post(message: unknown): void;
}

type TranscriptEvent =
  | { type: "user"; text: string }
  | { type: "assistant"; id: string; text: string }
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; text: string; done: boolean }
  | ApprovalCardEvent
  | { type: "approvalDone"; id: string }
  | { type: "notice"; text: string; copy?: string; kind: "info" | "error" };

const HISTORY_LIMIT = 500;
const SESSION_ID_KEY = "metaBetta.sessionId";
const SESSION_LABEL_KEY = "metaBetta.sessionLabel";
const TRANSCRIPT_KEY = "metaBetta.transcript";

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
  private sessionId = createSessionId();
  private sessionTopic = "";
  private labelSettled = false;
  private approvalResolvers = new Map<string, (choiceId: string | undefined) => void>();
  private readonly createHostShared = singleFlight((folder: vscode.WorkspaceFolder) =>
    this.createHostAsync(folder),
  );

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: vscode.Memento,
  ) {}

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
    const host = await this.ensureHost(folder);
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
    await host.send(text, folder.uri.fsPath);
  }

  public stop(): void {
    void this.host?.stop();
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
    this.running = false;
    this.lastStatus = "";
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
    // boot keeps what it has.
    if (this.labelSettled) {
      return;
    }
    this.labelSettled = true;
    const stored = cleanSessionLabel(this.storage.get<unknown>(SESSION_LABEL_KEY));
    if (stored) {
      this.sessionId = stored.id;
      this.sessionTopic = stored.topic;
      this.broadcastSessionLabel();
    }
  }

  private persistSessionLabel(): void {
    this.labelSettled = true;
    this.storeSet(SESSION_LABEL_KEY, { id: this.sessionId, topic: this.sessionTopic });
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
    if (event.type === "turn") {
      this.running = event.state === "started";
      this.broadcast(event);
      if (!this.running) {
        this.persistTranscript();
      }
      return;
    }
    if (event.type === "status") {
      this.lastStatus = event.text;
      this.broadcast(event);
      return;
    }
    this.recordAndBroadcast(event);
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
