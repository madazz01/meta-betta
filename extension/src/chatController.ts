import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseSendMessage } from "./lib/chat.js";
import { parseFileLink } from "./lib/links.js";
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
  private approvalResolvers = new Map<string, (choiceId: string | undefined) => void>();

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public bind(sink: ChatSink): void {
    this.sinks.add(sink);
    for (const event of this.history) {
      sink.post(event);
    }
    sink.post({ type: "turn", state: this.running ? "started" : "done" });
    sink.post({ type: "status", text: this.lastStatus });
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
      this.recordAndBroadcast({
        type: "notice",
        kind: "info",
        text: "Open a folder first, then ask me something — I work inside your project.",
      });
      return;
    }
    this.host ??= new MuseHost({
      museBin: findMuseBin(vscode.workspace.getConfiguration("metaBetta").get<string>("museBin", "")),
      version: readVersion(this.extensionUri),
      emit: (event) => this.onHostEvent(event),
      askApproval: (card) => this.askApproval(card),
    });
    this.recordAndBroadcast({ type: "user", text });
    await this.host.send(text, folder.uri.fsPath);
  }

  public stop(): void {
    this.host?.stop();
  }

  public approve(id: string, choiceId: string): void {
    this.approvalResolvers.get(id)?.(choiceId);
    this.approvalResolvers.delete(id);
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

  private onHostEvent(event: MuseHostEvent): void {
    if (event.type === "turn") {
      this.running = event.state === "started";
      this.broadcast(event);
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
