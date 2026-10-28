import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseSendMessage } from "./lib/chat.js";
import { createNonce } from "./lib/nonce.js";
import { type ApprovalCardEvent, MuseHost } from "./muse/museHost.js";
import { findMuseBin } from "./muse/resolveBin.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "metaBetta.chat";

  private view?: vscode.WebviewView;
  private host?: MuseHost;
  private running = false;
  private approvalResolvers = new Map<string, (choiceId: string | undefined) => void>();

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
      // The panel is gone, so pending approvals fall back to the safest choice.
      for (const resolve of this.approvalResolvers.values()) {
        resolve(undefined);
      }
      this.approvalResolvers.clear();
    });
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (isRecord(message) && message.type === "approve") {
        if (typeof message.id === "string" && typeof message.choiceId === "string") {
          this.approvalResolvers.get(message.id)?.(message.choiceId);
          this.approvalResolvers.delete(message.id);
        }
        return;
      }
      if (isRecord(message) && message.type === "stop") {
        this.host?.stop();
        return;
      }
      const text = parseSendMessage(message);
      if (text === undefined) {
        return;
      }
      void this.send(text);
    });
  }

  public async dispose(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    if (host) {
      await host.dispose();
    }
  }

  private async send(text: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({
        type: "notice",
        kind: "info",
        text: "Open a folder first, then ask me something — I work inside your project.",
      });
      this.post({ type: "turn", state: "done" });
      return;
    }
    if (!this.host) {
      const museBin = findMuseBin(vscode.workspace.getConfiguration("metaBetta").get<string>("museBin", ""));
      this.host = new MuseHost({
        museBin,
        version: readVersion(this.extensionUri),
        emit: (event) => this.post(event),
        askApproval: (card) => this.askApproval(card),
      });
    }
    await this.host.send(text, folder.uri.fsPath);
  }

  private askApproval(card: ApprovalCardEvent): Promise<string | undefined> {
    if (!this.view || !this.running) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.approvalResolvers.set(card.id, resolve);
      this.post(card);
    });
  }

  private post(message: unknown): void {
    if (isRecord(message) && message.type === "turn") {
      this.running = message.state === "started";
    }
    void this.view?.webview.postMessage(message);
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
