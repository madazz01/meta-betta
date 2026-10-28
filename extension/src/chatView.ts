import * as vscode from "vscode";
import { type ChatController, type ChatSink, routeViewMessage } from "./chatController.js";
import { buildChatHtml } from "./chatHtml.js";

/** Where the chat lives, from the metaBetta.openIn setting. */
export function readOpenIn(): "editor" | "sidebar" {
  return vscode.workspace.getConfiguration("metaBetta").get<string>("openIn", "editor") === "sidebar"
    ? "sidebar"
    : "editor";
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "metaBetta.chat";

  private view?: vscode.WebviewView;
  private sink?: ChatSink;
  private mode?: "chat" | "stub";

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
    private readonly openPanel: () => void,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.onDidDispose(() => {
      this.unbindSink();
      this.view = undefined;
      this.mode = undefined;
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sync();
      }
    });
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (isRecord(message) && message.type === "openChat") {
        this.openPanel();
        return;
      }
      routeViewMessage(this.controller, message);
    });
    this.sync();
  }

  /**
   * Show the full chat or the stub, per metaBetta.openIn. In editor mode the
   * stub also opens the editor tab, so clicking the icon opens the chat.
   */
  public sync(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    if (readOpenIn() === "sidebar") {
      if (this.mode !== "chat") {
        this.unbindSink();
        view.webview.html = buildChatHtml(view.webview, this.extensionUri, "chat");
        const sink: ChatSink = {
          post: (message: unknown) => {
            void view.webview.postMessage(message);
          },
        };
        this.sink = sink;
        this.controller.bind(sink);
        this.mode = "chat";
      }
      return;
    }
    if (this.mode !== "stub") {
      this.unbindSink();
      view.webview.html = buildChatHtml(view.webview, this.extensionUri, "stub");
      this.mode = "stub";
    }
    if (view.visible) {
      this.openPanel();
    }
  }

  private unbindSink(): void {
    if (this.sink) {
      this.controller.unbind(this.sink);
      this.sink = undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
