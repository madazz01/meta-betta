import * as vscode from "vscode";
import { buildChatHtml } from "../chatHtml.js";
import type { SessionRow } from "./sessions.js";

/** Sidebar Sessions view: this folder's chats, newest first. */
export class SessionsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "metaBetta.sessions";

  private view?: vscode.WebviewView;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onRefresh: () => void,
    private readonly onNewChat: () => void,
    private readonly onOpen: (uid: string) => void,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = buildChatHtml(webviewView.webview, this.extensionUri, "sessions");
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.onRefresh();
      }
    });
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message !== "object" || message === null) {
        return;
      }
      const incoming = message as { type?: unknown; uid?: unknown };
      if (incoming.type === "sessionsReady") {
        this.onRefresh();
      } else if (incoming.type === "newSession") {
        this.onNewChat();
      } else if (incoming.type === "openSession" && typeof incoming.uid === "string") {
        this.onOpen(incoming.uid);
      }
    });
    this.onRefresh();
  }

  public show(rows: SessionRow[]): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: "sessions", rows });
    }
  }
}
