import * as vscode from "vscode";
import { ChatController } from "./chatController.js";
import { openChatPanel } from "./chatPanel.js";
import { ChatViewProvider, readOpenIn } from "./chatView.js";

let controller: ChatController | undefined;
let viewProvider: ChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new ChatController(context.extensionUri);
  viewProvider = new ChatViewProvider(context.extensionUri, controller, () => {
    if (controller) {
      openChatPanel(context.extensionUri, controller);
    }
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("metaBetta.open", async () => {
      if (readOpenIn() === "sidebar") {
        await vscode.commands.executeCommand("metaBetta.chat.focus");
      } else if (controller) {
        openChatPanel(context.extensionUri, controller);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("metaBetta.openIn")) {
        viewProvider?.sync();
      }
    }),
  );
}

export function deactivate(): Promise<void> | void {
  const current = controller;
  controller = undefined;
  viewProvider = undefined;
  if (current) {
    return current.dispose();
  }
}
