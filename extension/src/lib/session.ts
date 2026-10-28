// Pure session helpers: which session to open, and the small stored
// transcript used when the server can't serve history. No VS Code imports.

export type SessionAction = "start-fresh" | "resume-saved" | "restart-after-failed-resume";

/**
 * Which session to use: no saved id → start fresh; saved id + resume ok →
 * carry on; saved id + resume failed → start fresh with a one-line notice.
 */
export function decideSession(savedId: string | undefined, resumeSucceeded: boolean): SessionAction {
  if (!savedId?.trim()) {
    return "start-fresh";
  }
  return resumeSucceeded ? "resume-saved" : "restart-after-failed-resume";
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

const TRANSCRIPT_LIMIT = 20;
const TEXT_LIMIT = 4000;

/** The last user/assistant messages, bounded for storage. */
export function buildTranscript(events: readonly { type: string; text?: string }[]): TranscriptEntry[] {
  const kept: TranscriptEntry[] = [];
  for (const event of events) {
    if ((event.type === "user" || event.type === "assistant") && event.text) {
      kept.push({ role: event.type, text: event.text.slice(0, TEXT_LIMIT) });
    }
  }
  return kept.slice(-TRANSCRIPT_LIMIT);
}

/** Validate a stored transcript; anything else becomes an empty list. */
export function cleanTranscript(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: TranscriptEntry[] = [];
  for (const entry of value) {
    if (isTranscriptEntry(entry)) {
      kept.push({ role: entry.role, text: entry.text.slice(0, TEXT_LIMIT) });
    }
  }
  return kept.slice(-TRANSCRIPT_LIMIT);
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as { role?: unknown; text?: unknown };
  return (entry.role === "user" || entry.role === "assistant") && typeof entry.text === "string";
}
