// Pure transcript helpers: one-line tool rows and collapsed thinking text.
// No VS Code imports.

export interface ToolItemView {
  kind: string;
  tool?: string;
  displayLabel?: { active: string; done: string; neutral: string };
  status: string;
  failureReason?: string;
  fallbackText?: string;
  commandText?: string;
}

export interface ToolRow {
  text: string;
  done: boolean;
  failed: boolean;
}

/** One short row for a toolCall, userShell, or any other work item. */
export function toolRowText(item: ToolItemView): ToolRow {
  const failed = item.status === "failed" || item.status === "rejected" || item.status === "timedOut";
  const done = item.status !== "inProgress";
  let text: string;
  if (item.kind === "userShell") {
    text = `▶ ${truncate(item.commandText?.trim() || "shell command", 80)}`;
  } else if (item.kind === "toolCall") {
    text = `${toolIcon(item.tool)} ${toolLabel(item)}`;
  } else {
    const extra = item.fallbackText ? ` — ${truncate(singleLine(item.fallbackText), 100)}` : "";
    text = `Working…${extra}`;
  }
  if (failed) {
    const why = item.failureReason ? `: ${truncate(singleLine(item.failureReason), 80)}` : "";
    text += ` (didn't work${why})`;
  } else if (done) {
    text += " ✓";
  }
  return { text, done, failed };
}

/** Collapsed thinking text: streamed summary parts, or raw text where exposed. */
export function reasoningText(
  summary: readonly string[] | undefined,
  text: string | undefined,
): string {
  const joined = (summary ?? []).join("");
  return joined || text || "";
}

function toolLabel(item: ToolItemView): string {
  const label = item.displayLabel;
  if (!label) {
    return item.tool ?? "tool";
  }
  if (item.status === "completed") {
    return label.done;
  }
  if (item.status === "inProgress") {
    return label.active;
  }
  return label.neutral;
}

function toolIcon(tool: string | undefined): string {
  const name = (tool ?? "").toLowerCase();
  if (/(write|edit|create|apply|patch|save)/.test(name)) {
    return "📄";
  }
  if (/(exec|bash|shell|command|run|test|build|npm|cargo)/.test(name)) {
    return "▶";
  }
  if (/(read|list|glob|grep|search|find)/.test(name)) {
    return "🔍";
  }
  return "🔧";
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
