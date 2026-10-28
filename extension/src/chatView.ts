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
  private mode?: "chat" | "blank";

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
      routeViewMessage(this.controller, message);
    });
    this.sync();
  }

  /**
   * Full chat when openIn is sidebar, otherwise a blank view: the icon just
   * opens the chat tab.
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
    if (this.mode !== "blank") {
      this.unbindSink();
      view.webview.html = "<!DOCTYPE html><html><body></body></html>";
      this.mode = "blank";
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
