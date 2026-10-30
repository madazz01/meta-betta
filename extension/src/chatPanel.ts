import * as vscode from "vscode";
import { type ChatController, type ChatSink, routeViewMessage } from "./chatController.js";
import { buildChatHtml } from "./chatHtml.js";

export const CHAT_PANEL_VIEW_TYPE = "metaBetta.chatPanel";

/** Open a chat tab for a controller, focused. */
export function openChatTab(
  extensionUri: vscode.Uri,
  controller: ChatController,
  title: string,
  onDispose: () => void,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    CHAT_PANEL_VIEW_TYPE,
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    },
  );
  bindChatPanel(panel, extensionUri, controller, onDispose);
  panel.reveal(vscode.ViewColumn.Active);
  return panel;
}

/** Attach a controller to a panel (fresh or revived after reload). */
export function bindChatPanel(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
  controller: ChatController,
  onDispose: () => void,
): void {
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
  };
  panel.webview.html = buildChatHtml(panel.webview, extensionUri, "chat");
  const sink: ChatSink = {
    post: (message: unknown) => {
      void panel.webview.postMessage(message);
    },
  };
  controller.bind(sink);
  panel.webview.onDidReceiveMessage((message: unknown) => {
    routeViewMessage(controller, message);
  });
  panel.onDidDispose(() => {
    controller.unbind(sink);
    onDispose();
  });
}
