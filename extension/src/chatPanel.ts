import * as vscode from "vscode";
import { type ChatController, type ChatSink, routeViewMessage } from "./chatController.js";
import { buildChatHtml } from "./chatHtml.js";

let panel: vscode.WebviewPanel | undefined;

/** Open the chat as an editor tab, shared with the sidebar through the controller. */
export function openChatPanel(extensionUri: vscode.Uri, controller: ChatController): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  const webviewPanel = vscode.window.createWebviewPanel("metaBetta.chatPanel", "Meta Betta", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
  });
  panel = webviewPanel;
  webviewPanel.webview.html = buildChatHtml(webviewPanel.webview, extensionUri, "chat");
  const sink: ChatSink = {
    post: (message: unknown) => {
      void webviewPanel.webview.postMessage(message);
    },
  };
  controller.bind(sink);
  webviewPanel.webview.onDidReceiveMessage((message: unknown) => {
    routeViewMessage(controller, message);
  });
  webviewPanel.onDidDispose(() => {
    controller.unbind(sink);
    if (panel === webviewPanel) {
      panel = undefined;
    }
  });
}
