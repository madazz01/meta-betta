// Pure file-link parsing for links in chat replies: "src/app.ts",
// "src/app.ts:12", "src/app.ts:12:4", or a file:// URI. Relative paths
// resolve against the workspace root. No VS Code imports.

import { isAbsolute, join, normalize } from "node:path";

export interface FileLink {
  fsPath: string;
  line?: number;
  column?: number;
}

export function parseFileLink(target: string, workspaceRoot: string): FileLink | undefined {
  let rest = target.trim();
  if (!rest) {
    return undefined;
  }
  rest = rest.replace(/^file:\/\//i, "");
  if (!rest || hasScheme(rest)) {
    return undefined;
  }
  try {
    rest = decodeURIComponent(rest);
  } catch {
    return undefined;
  }
  // A leading slash before a Windows drive ("file:///C:/x") is not part of the path.
  rest = rest.replace(/^\/([a-zA-Z]:[\\/])/, "$1");

  let line: number | undefined;
  let column: number | undefined;
  const position = rest.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (position) {
    rest = position[1];
    line = Math.max(1, Number(position[2]));
    if (position[3] !== undefined) {
      column = Math.max(1, Number(position[3]));
    }
  }
  if (!rest) {
    return undefined;
  }
  const fsPath = isAbsolute(rest) ? normalize(rest) : normalize(join(workspaceRoot, rest));
  const link: FileLink = { fsPath };
  if (line !== undefined) {
    link.line = line;
  }
  if (column !== undefined) {
    link.column = column;
  }
  return link;
}

/** True for "scheme:..." targets that are not a Windows drive path. */
function hasScheme(target: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(target)) {
    return false;
  }
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);
}
