import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { createNonce } from "./lib/nonce.js";

export type ChatTemplate = "chat" | "brain";

/** Webview HTML for the full chat or the brain panel. */
export function buildChatHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  template: ChatTemplate,
): string {
  const mediaPath = path.join(extensionUri.fsPath, "media");
  const file = template === "chat" ? "chat.html" : "brain.html";
  const html = fs.readFileSync(path.join(mediaPath, file), "utf8");
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat.css"));
  const markdownUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "markdown.js"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat.js"));
  return html
    .replaceAll("__CSP_SOURCE__", webview.cspSource)
    .replaceAll("__STYLE_URI__", styleUri.toString())
    .replaceAll("__MARKDOWN_URI__", markdownUri.toString())
    .replaceAll("__SCRIPT_URI__", scriptUri.toString())
    .replaceAll("__NONCE__", createNonce());
}
