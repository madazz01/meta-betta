import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { formatEcho, parseSendMessage } from "./lib/chat";
import { createNonce } from "./lib/nonce";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "metaBetta.chat";

  private view?: vscode.WebviewView;

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      const text = parseSendMessage(message);
      if (text === undefined) {
        return;
      }
      void this.view?.webview.postMessage({ type: "status", text: "Thinking…" });
      // Fake reply for now; brief 02 wires this to Muse Code.
      setTimeout(() => {
        void this.view?.webview.postMessage({ type: "reply", text: formatEcho(text) });
      }, 300);
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const mediaPath = path.join(this.extensionUri.fsPath, "media");
    const html = fs.readFileSync(path.join(mediaPath, "chat.html"), "utf8");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.js"));
    return html
      .replaceAll("__CSP_SOURCE__", webview.cspSource)
      .replaceAll("__STYLE_URI__", styleUri.toString())
      .replaceAll("__SCRIPT_URI__", scriptUri.toString())
      .replaceAll("__NONCE__", createNonce());
  }
}
