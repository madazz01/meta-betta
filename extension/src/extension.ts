import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    vscode.commands.registerCommand("metaBetta.open", async () => {
      await vscode.commands.executeCommand("metaBetta.chat.focus");
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up yet.
}
