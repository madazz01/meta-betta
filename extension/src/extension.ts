import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView.js";

let provider: ChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  provider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    vscode.commands.registerCommand("metaBetta.open", async () => {
      await vscode.commands.executeCommand("metaBetta.chat.focus");
    }),
  );
}

export function deactivate(): Promise<void> | void {
  const current = provider;
  provider = undefined;
  if (current) {
    return current.dispose();
  }
}
