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
  role: "user" | "assistant" | "undo";
  text: string;
  /** Undo button id (undo entries only). */
  id?: string;
}

const TRANSCRIPT_LIMIT = 20;
const TEXT_LIMIT = 4000;

/** The last messages and Undo buttons, bounded for storage. */
export function buildTranscript(events: readonly { type: string; text?: string; id?: string }[]): TranscriptEntry[] {
  const kept: TranscriptEntry[] = [];
  for (const event of events) {
    if ((event.type === "user" || event.type === "assistant") && event.text) {
      kept.push({ role: event.type, text: event.text.slice(0, TEXT_LIMIT) });
    } else if (event.type === "undo" && event.id) {
      kept.push({ role: "undo", text: "", id: event.id });
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
      kept.push(
        entry.role === "undo"
          ? { role: "undo", text: "", id: entry.id }
          : { role: entry.role, text: entry.text.slice(0, TEXT_LIMIT) },
      );
    }
  }
  return kept.slice(-TRANSCRIPT_LIMIT);
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as { role?: unknown; text?: unknown; id?: unknown };
  if (entry.role === "undo") {
    return typeof entry.id === "string" && entry.id !== "";
  }
  return (entry.role === "user" || entry.role === "assistant") && typeof entry.text === "string";
}

export interface StoredUndoFile {
  path: string;
  change: "modified" | "added" | "deleted";
}

export interface StoredUndo {
  id: string;
  before: string;
  after: string;
  at: number;
  files: StoredUndoFile[];
  /** How many user messages into the chat this reply was (resume anchor). */
  anchor: number;
  undone: boolean;
}

/** Stored undo targets are capped: older snapshots are pruned away anyway. */
const UNDO_LIMIT = 100;

/** Validate stored undo targets; anything else is forgotten. */
export function cleanUndos(value: unknown): StoredUndo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: StoredUndo[] = [];
  for (const entry of value) {
    const undo = cleanUndo(entry);
    if (undo) {
      kept.push(undo);
    }
  }
  return kept.slice(-UNDO_LIMIT);
}

function cleanUndo(value: unknown): StoredUndo | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entry = value as {
    id?: unknown;
    before?: unknown;
    after?: unknown;
    at?: unknown;
    files?: unknown;
    anchor?: unknown;
    undone?: unknown;
  };
  if (
    typeof entry.id !== "string" ||
    entry.id === "" ||
    typeof entry.before !== "string" ||
    entry.before === "" ||
    typeof entry.after !== "string" ||
    entry.after === "" ||
    typeof entry.at !== "number" ||
    !Number.isFinite(entry.at) ||
    !Number.isInteger(entry.anchor) ||
    (entry.anchor as number) < 0 ||
    typeof entry.undone !== "boolean" ||
    !Array.isArray(entry.files) ||
    entry.files.length === 0
  ) {
    return undefined;
  }
  const files: StoredUndoFile[] = [];
  for (const file of entry.files) {
    if (typeof file !== "object" || file === null) {
      return undefined;
    }
    const candidate = file as { path?: unknown; change?: unknown };
    if (typeof candidate.path !== "string" || candidate.path === "") {
      return undefined;
    }
    if (candidate.change !== "modified" && candidate.change !== "added" && candidate.change !== "deleted") {
      return undefined;
    }
    files.push({ path: candidate.path, change: candidate.change });
  }
  return {
    id: entry.id,
    before: entry.before,
    after: entry.after,
    at: entry.at,
    files,
    anchor: entry.anchor as number,
    undone: entry.undone,
  };
}

/**
 * Puts Undo buttons back while resumed history replays: each button was
 * anchored to its reply's user-message count, so it lands under the right
 * reply even though the server's history never contained it.
 */
export class UndoReplayer {
  private users = 0;
  private pending: string[] = [];

  public constructor(private readonly undos: readonly { id: string; anchor: number }[]) {}

  /** Undo ids to emit BEFORE recording this replayed user message. */
  public userArrived(): string[] {
    const flush = this.pending;
    this.pending = [];
    this.users += 1;
    for (const undo of this.undos) {
      if (undo.anchor === this.users) {
        this.pending.push(undo.id);
      }
    }
    return flush;
  }

  /** Undo ids to emit AFTER recording this replayed assistant message. */
  public assistantArrived(): string[] {
    const flush = this.pending;
    this.pending = [];
    return flush;
  }

  /** Leftovers (anchors past the history end) go at the bottom. */
  public finish(): string[] {
    const flush = this.pending;
    this.pending = [];
    return flush;
  }
}
