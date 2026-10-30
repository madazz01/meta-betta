import * as vscode from "vscode";
import { buildChatHtml } from "../chatHtml.js";
import { brainCardInputs, buildBrainCards, ensureBrain, nodeBrainFs } from "./brain.js";

export class BrainViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "metaBetta.brain";
  public static readonly sideViewType = "metaBetta.brainSidebar";

  private view?: vscode.WebviewView;
  private watcher?: vscode.FileSystemWatcher;

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = buildChatHtml(webviewView.webview, this.extensionUri, "brain");
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.watcher?.dispose();
      this.watcher = undefined;
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refresh();
      }
    });
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message !== "object" || message === null) {
        return;
      }
      const incoming = message as { type?: unknown; file?: unknown };
      // A restored view loads after our first refresh; its ready note
      // re-sends the cards so the panel is never blank after a reload.
      if (incoming.type === "brainReady") {
        void this.refresh();
        return;
      }
      if (incoming.type === "openBrainFile" && typeof incoming.file === "string") {
        void this.openFile(incoming.file);
      }
    });
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.watcher?.dispose();
    if (folder) {
      this.watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, "brain/**"),
      );
      this.watcher.onDidCreate(() => void this.refresh());
      this.watcher.onDidChange(() => void this.refresh());
      this.watcher.onDidDelete(() => void this.refresh());
    }
    void this.refresh();
  }

  /** Briefly highlight the cards for these brain files (after a save). */
  public flash(files: string[]): void {
    if (this.view && files.length > 0) {
      void this.view.webview.postMessage({ type: "brainFlash", files });
    }
  }

  /** Briefly outline the whole panel (welcome tour). */
  public outline(): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: "brainOutline" });
    }
  }

  public async refresh(): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void view.webview.postMessage({ type: "brainStatus", text: "Open a folder to start." });
      return;
    }
    const inputs = brainCardInputs((file) => ({ mtimeMs: undefined, content: undefined }));
    const cards = buildBrainCards(
      await Promise.all(
        inputs.map(async (input) => {
          const target = vscode.Uri.joinPath(folder.uri, "brain", input.file);
          try {
            const [bytes, fileStat] = await Promise.all([
              vscode.workspace.fs.readFile(target),
              vscode.workspace.fs.stat(target),
            ]);
            return { ...input, mtimeMs: fileStat.mtime, content: new TextDecoder().decode(bytes) };
          } catch {
            return input;
          }
        }),
      ),
    );
    void view.webview.postMessage({ type: "brain", cards });
  }

  private async openFile(file: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    try {
      await ensureBrain(folder.uri.fsPath, nodeBrainFs);
      const uri = vscode.Uri.joinPath(folder.uri, "brain", file);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        if (!file.startsWith("log/")) {
          return;
        }
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`# ${file.slice(4, -3)}\n`));
      }
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    } catch {
      // Clicking a card that can't open stays quiet; the card is still there.
    }
  }
}
