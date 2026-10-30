import * as vscode from "vscode";
import { buildChatHtml } from "../chatHtml.js";
import type { UsageViewData } from "./usage.js";

/** Sidebar Usage view: today's numbers plus the free-credits line. */
export class UsageViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "metaBetta.usage";

  private view?: vscode.WebviewView;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onRefresh: () => void,
    private readonly onDetails: () => void,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = buildChatHtml(webviewView.webview, this.extensionUri, "usage");
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
      const type = (message as { type?: unknown }).type;
      if (type === "usageReady") {
        this.onRefresh();
      } else if (type === "usageDetails") {
        this.onDetails();
      }
    });
    this.onRefresh();
  }

  public show(data: UsageViewData): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: "usage", data });
    }
  }
}
