import * as vscode from "vscode";
import { BrainViewProvider } from "./brain/brainView.js";
import { ChatController } from "./chatController.js";
import { openChatPanel } from "./chatPanel.js";
import { ChatViewProvider, readOpenIn } from "./chatView.js";

let controller: ChatController | undefined;
let viewProvider: ChatViewProvider | undefined;
let brainProvider: BrainViewProvider | undefined;
let brainSideProvider: BrainViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Meta Betta");
  context.subscriptions.push(output);
  controller = new ChatController(
    context.extensionUri,
    context.workspaceState,
    (files) => {
      for (const provider of [brainProvider, brainSideProvider]) {
        if (provider) {
          void provider.refresh().then(
            () => provider.flash(files),
            () => undefined,
          );
        }
      }
    },
    context.storageUri?.fsPath,
    (message) => output.appendLine(`[${new Date().toLocaleTimeString("en-GB")}] ${message}`),
    () => {
      brainProvider?.outline();
      brainSideProvider?.outline();
    },
  );
  viewProvider = new ChatViewProvider(context.extensionUri, controller, () => {
    if (controller) {
      openChatPanel(context.extensionUri, controller);
    }
  });
  brainProvider = new BrainViewProvider(context.extensionUri);
  brainSideProvider = new BrainViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(BrainViewProvider.viewType, brainProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(
      BrainViewProvider.sideViewType,
      brainSideProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    vscode.commands.registerCommand("metaBetta.open", async () => {
      if (readOpenIn() === "sidebar") {
        await vscode.commands.executeCommand("metaBetta.chat.focus");
      } else if (controller) {
        openChatPanel(context.extensionUri, controller);
      }
    }),
    vscode.commands.registerCommand("metaBetta.saveMyDay", () => {
      void controller?.saveMyDay();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("metaBetta.openIn")) {
        viewProvider?.sync();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void controller?.trustGranted();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      controller?.refreshFolder();
      void brainProvider?.refresh();
      void brainSideProvider?.refresh();
    }),
  );
}

export function deactivate(): Promise<void> | void {
  const current = controller;
  controller = undefined;
  viewProvider = undefined;
  brainProvider = undefined;
  brainSideProvider = undefined;
  if (current) {
    return current.dispose();
  }
}
