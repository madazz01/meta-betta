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
  role: "user" | "assistant" | "undo" | "nudge";
  text: string;
  /** Undo button or nudge card id (undo/nudge entries only). */
  id?: string;
  /** Message time in ms (user/assistant only); a resumed chat shows real times. */
  at?: number;
  /** Which nudge button was pressed (nudge entries only). */
  answer?: "show" | "notnow";
}

const TRANSCRIPT_LIMIT = 20;
const TEXT_LIMIT = 4000;

export interface TranscriptEventView {
  type: string;
  text?: string;
  id?: string;
  at?: number;
  answer?: string;
}

/** The last messages, Undo buttons and nudge answers, bounded for storage. */
export function buildTranscript(events: readonly TranscriptEventView[]): TranscriptEntry[] {
  const kept: TranscriptEntry[] = [];
  for (const event of events) {
    if ((event.type === "user" || event.type === "assistant") && event.text) {
      kept.push({
        role: event.type,
        text: event.text.slice(0, TEXT_LIMIT),
        ...(typeof event.at === "number" && Number.isFinite(event.at) ? { at: event.at } : {}),
      });
    } else if (event.type === "undo" && event.id) {
      kept.push({ role: "undo", text: "", id: event.id });
    } else if (event.type === "nudgeAnswered" && event.id && (event.answer === "show" || event.answer === "notnow")) {
      kept.push({ role: "nudge", text: "", id: event.id, answer: event.answer });
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
      if (entry.role === "undo") {
        kept.push({ role: "undo", text: "", id: entry.id });
      } else if (entry.role === "nudge") {
        kept.push({ role: "nudge", text: "", id: entry.id, answer: entry.answer });
      } else {
        kept.push({
          role: entry.role,
          text: entry.text.slice(0, TEXT_LIMIT),
          ...(typeof entry.at === "number" && Number.isFinite(entry.at) ? { at: entry.at } : {}),
        });
      }
    }
  }
  return kept.slice(-TRANSCRIPT_LIMIT);
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as { role?: unknown; text?: unknown; id?: unknown; answer?: unknown };
  if (entry.role === "undo") {
    return typeof entry.id === "string" && entry.id !== "";
  }
  if (entry.role === "nudge") {
    return (
      typeof entry.id === "string" && entry.id !== "" && (entry.answer === "show" || entry.answer === "notnow")
    );
  }
  return (entry.role === "user" || entry.role === "assistant") && typeof entry.text === "string";
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The small time under a message ("9:41 AM"). */
export function timeLabel(at: number): string {
  const date = new Date(at);
  const hours = date.getHours();
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(date.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

/** The day divider label ("Thu 29 Oct"). */
export function dayLabel(at: number): string {
  const date = new Date(at);
  return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

/** True when two timestamps fall on the same calendar day. */
export function sameDay(a: number, b: number): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

/**
 * The divider label before a message, or undefined when it shares the
 * previous message's day. The first message always labels its day.
 */
export function dividerBefore(prevAt: number | undefined, at: number): string | undefined {
  if (prevAt === undefined || !sameDay(prevAt, at)) {
    return dayLabel(at);
  }
  return undefined;
}

/** A chat message: live ones are stamped at creation, replays keep theirs. */
export interface ChatUserMessage {
  type: "user";
  text: string;
  at?: number;
  time?: string;
}

/** A chat reply: live ones are stamped at creation, replays keep theirs. */
export interface ChatAssistantMessage {
  type: "assistant";
  id: string;
  text: string;
  at?: number;
  time?: string;
}

export type ChatMessageEvent = ChatUserMessage | ChatAssistantMessage;

/**
 * Derive a message's display time from its recorded stamp. A message with no
 * recorded time (from before times existed) shows no time, never "now".
 */
export function stampMessageTime(event: ChatMessageEvent): ChatMessageEvent {
  if (event.at === undefined) {
    return event;
  }
  return { ...event, time: timeLabel(event.at) };
}

/** A streaming update keeps the message's original time. */
export function keepMessageTime(
  previous: ChatMessageEvent | undefined,
  next: ChatMessageEvent,
): ChatMessageEvent {
  if (previous?.at === undefined) {
    return next;
  }
  return { ...next, at: previous.at, time: previous.time ?? timeLabel(previous.at) };
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
  /** Muse session id; anchors only match replays of the same session. */
  session?: string;
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
    session?: unknown;
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
    ...(typeof entry.session === "string" ? { session: entry.session } : {}),
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
  private firedSet = new Set<string>();

  /**
   * @param undos Stored undo targets.
   * @param sessionId The resumed Muse session: only its undos arm (plus
   * legacy ones stored without a session).
   */
  public constructor(
    private readonly undos: readonly { id: string; anchor: number; session?: string }[],
    private readonly sessionId?: string,
  ) {}

  /** Undo ids to emit BEFORE recording this replayed user message. */
  public userArrived(): string[] {
    const flush = this.takePending();
    this.users += 1;
    for (const undo of this.undos) {
      if (undo.anchor === this.users && (undo.session === undefined || undo.session === this.sessionId)) {
        this.pending.push(undo.id);
      }
    }
    return flush;
  }

  /** Undo ids to emit AFTER recording this replayed assistant message. */
  public assistantArrived(): string[] {
    return this.takePending();
  }

  /** Leftovers (anchors past the history end) go at the bottom. */
  public finish(): string[] {
    return this.takePending();
  }

  /** How many user messages replayed so far. */
  public userCount(): number {
    return this.users;
  }

  /** Undo ids whose anchor matched a replayed reply. */
  public firedIds(): readonly string[] {
    return [...this.firedSet];
  }

  private takePending(): string[] {
    const flush = this.pending;
    this.pending = [];
    for (const id of flush) {
      this.firedSet.add(id);
    }
    return flush;
  }
}
