// The brain: Markdown files in the user's workspace that Muse reads every
// session. All file access goes through BrainFs so tests use a fake.

import { randomBytes } from "node:crypto";
import { appendFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { nudgeHintsText } from "./nudges.js";

export interface BrainFs {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  /** Modification time in ms, or undefined when the file is missing. */
  mtimeMs(path: string): Promise<number | undefined>;
}

export const nodeBrainFs: BrainFs = {
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readFile: async (path) => {
    return readFile(path, "utf8");
  },
  writeFile: async (path, content) => {
    await writeFile(path, content, "utf8");
  },
  appendFile: async (path, content) => {
    await appendFile(path, content, "utf8");
  },
  mtimeMs: async (path) => {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return undefined;
    }
  },
};

const BRAIN_FILES: { file: string; template: string }[] = [
  {
    file: "me.md",
    template: `# About me

Who you are and how you like answers (short or full, plain words). The welcome chat fills this in — or just edit it.
`,
  },
  {
    file: "project.md",
    template: `## START HERE

What we're building, in a line or two. The welcome chat writes this with you.

## Updates

_Entries appear here, newest at the bottom, each tagged with its chat._
`,
  },
  {
    file: "tricks.md",
    template: `# Tricks

Workarounds that worked, one per line, newest first.
`,
  },
  {
    file: "good-for.md",
    template: `# Good for

Things Muse has actually done for you, in plain words. It grows as we work together.
`,
  },
];

/** Create the brain folder and starter files. Never overwrites anything. */
export async function ensureBrain(root: string, fs: BrainFs = nodeBrainFs): Promise<void> {
  const brainDir = join(root, "brain");
  await fs.mkdir(join(brainDir, "log"));
  for (const { file, template } of BRAIN_FILES) {
    const target = join(brainDir, file);
    if (!(await fs.exists(target))) {
      await fs.writeFile(target, template);
    }
  }
}

const FRONT_DOOR_START = "<!-- meta-betta:start -->";
const FRONT_DOOR_END = "<!-- meta-betta:end -->";

export const FRONT_DOOR_SECTION = `<!-- meta-betta:start -->
<!-- meta-betta:version 2 -->
## Meta Betta brain (read first, every session)
1. Read brain/me.md, brain/project.md (START HERE plus the last 10 entries under Updates), brain/tricks.md and today's brain/log file if it exists.
2. Unless brain/me.md is still the starter template (the extension runs a welcome instead), open your first reply with "Here's where we're up to:" and 2–3 plain lines from the latest updates, then ask what we're doing today. If the user says "continue working on X", use the latest entries about X and carry on from there.
3. Talk to the user the way brain/me.md says. Plain English, no jargon.
4. Before building, propose the simplest version in one or two lines and wait for a yes.
5. When something fails, try 2–3 other ways before giving up, and say plainly which one worked. Mention any workaround that worked, and it gets saved to brain/tricks.md when we save.
6. Match your wrap-up to the size of the job. Tiny job: one line (e.g. "Added eggs to notes.txt."). Bigger job: end with "Done: …", "To use it: …" (click by click, simplest way first, e.g. "double-click index.html"). Only add "I couldn't check: …", or a problem, when there actually is one — never write "Couldn't check: nothing". No code dumps unless asked.
7. Never edit files outside this workspace.
8. Never rewrite or delete anything in brain/. The brain only grows; the extension adds new entries for you when we save.
9. Before changing an existing file, copy it to .backups/<date>/<same path> first, and say where the copy is in one line.
10. Nudge new tricks, at most one per session: only right after a job that went well, only if it fits what they just did, never anything listed in brain/good-for.md or declined in brain/me.md ("not interested: …"). Format, exactly: "💡 Did you know I can also <thing>? Want me to show you on <their actual file>?" If they say no, reply briefly and never suggest that thing again. (The extension files "not interested: <thing>" in brain/me.md when they press Not now.) Things you may offer, each with when it fits:
${nudgeHintsText()}
11. The first time you use a technical word with this person (e.g. .gitignore, commit, dependency), explain it in a few plain words in brackets, e.g. "added .backups/ to your .gitignore (the list of files git won't upload)". After that, just use the word. If brain/me.md says they already know it, skip the explanation.
12. If the user is just noticing something (e.g. "I have to click yes a lot", "that icon looks like Java") and hasn't asked for anything, don't change anything. Reply briefly and ask: "Want me to look at that?" Only act on a clear ask ("can you", "let's", "fix", "go", "do it"). If brain/me.md says how this person signals, follow that.
<!-- meta-betta:end -->`;

/**
 * Make sure the workspace AGENTS.md carries our front-door section: create
 * the file when missing, append the section when it has no markers, replace
 * only the marked section on later runs. Never touches anything else.
 */
export async function ensureFrontDoor(root: string, fs: BrainFs = nodeBrainFs): Promise<void> {
  const target = join(root, "AGENTS.md");
  if (!(await fs.exists(target))) {
    await fs.writeFile(target, `${FRONT_DOOR_SECTION}\n`);
    return;
  }
  const content = await fs.readFile(target);
  const start = content.indexOf(FRONT_DOOR_START);
  const end = start === -1 ? -1 : content.indexOf(FRONT_DOOR_END, start);
  if (start === -1 || end === -1) {
    // No complete section: append a fresh one and keep everything else.
    await fs.writeFile(target, `${content.replace(/\n*$/, "")}\n\n${FRONT_DOOR_SECTION}\n`);
    return;
  }
  const after = end + FRONT_DOOR_END.length;
  await fs.writeFile(target, `${content.slice(0, start)}${FRONT_DOOR_SECTION}${content.slice(after)}`);
}

/**
 * Make sure the workspace .gitignore lists an entry (e.g. ".backups/"):
 * create the file when missing, append the entry when absent. Never replaces
 * anything. Returns true when it added the entry.
 */
export async function ensureGitignoreEntry(
  root: string,
  entry: string,
  fs: BrainFs = nodeBrainFs,
): Promise<boolean> {
  const target = join(root, ".gitignore");
  if (!(await fs.exists(target))) {
    await fs.writeFile(target, `${entry}\n`);
    return true;
  }
  const content = await fs.readFile(target);
  const bare = entry.replace(/\/$/, "");
  const listed = content
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === entry || line === bare);
  if (listed) {
    return false;
  }
  await fs.writeFile(target, `${content.replace(/\n*$/, "")}\n${entry}\n`);
  return true;
}

/** True when me.md is missing or still the starter template (welcome needed). */
export function isStarterMe(content: string | undefined): boolean {
  if (!content) {
    return true;
  }
  const template = BRAIN_FILES.find((file) => file.file === "me.md")?.template ?? "";
  return content.trim() === template.trim();
}

/**
 * Append a `Name: <name>` line, unless one is already there (first wins).
 */
export function withNameLine(content: string, name: string): string {
  if (
    content
      .split("\n")
      .map((line) => line.trim())
      .some((line) => /^name:/i.test(line))
  ) {
    return content;
  }
  return `${content.replace(/\n*$/, "")}\n\nName: ${name.trim()}\n`;
}

/** A declined nudge, noted once per thing so it's never suggested again. */
export function withNotInterested(content: string, thing: string): string {
  const clean = thing.replace(/\s+/g, " ").trim().slice(0, 80);
  if (clean === "") {
    return content;
  }
  const line = `not interested: ${clean}`;
  if (
    content
      .split("\n")
      .map((entry) => entry.trim().toLowerCase())
      .includes(line.toLowerCase())
  ) {
    return content;
  }
  return `${content.replace(/\n*$/, "")}\n\n${line}\n`;
}

/**
 * Set the START HERE section body, keeping the rest of the file. Adds the
 * section on top when the file has none.
 */
export function withStartHere(content: string, body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") {
    return content;
  }
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## START HERE");
  if (start === -1) {
    return `## START HERE\n\n${trimmed}\n\n${content.replace(/^\n+/, "")}`;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("## "));
  const after = end === -1 ? [] : rest.slice(end);
  return [...lines.slice(0, start), "## START HERE", "", trimmed, "", ...after].join("\n");
}

const WELCOME_REFUSALS =
  /^(?:no\b|nope|nah\b|skip\b|pass\b|none\b|rather\s+not|prefer\s+not|do\s+not\s+call\s+me|don't\s+call\s+me)/i;
const WELCOME_GREETING = /^(?:hi|hey|hello|g['’]?day|good|morning|afternoon|evening|yo)\b[,\s]*/i;
const WELCOME_TRAILER = /(?:^|\s+)(?:here|there|thanks|thank you|thx|ty)[.?…!]*$/i;
const WELCOME_LEAD_IN_WORDS = "my name is|i'm|i’m|i am|im|it's|it’s|its|call me|name's|name’s|names";
const WELCOME_SKIP_WORDS =
  "a|an|the|me|you|he|she|it|we|they|us|them|him|her|his|hers|this|that|here|there" +
  "|good|fine|ok|okay|great|well";
const WELCOME_LEAD_INS = new RegExp(`\\b(?:${WELCOME_LEAD_IN_WORDS})\\s+([A-Za-z][A-Za-z'-]*)`, "gi");
const WELCOME_SKIP = new RegExp(`^(?:${WELCOME_SKIP_WORDS})$`, "i");
const WELCOME_NOTHING = new RegExp(
  `^(?:${WELCOME_LEAD_IN_WORDS}|thanks|thank you|thx|ty|${WELCOME_SKIP_WORDS}|h+i+|hey+|hello+|y+o+)\\.?$`,
  "i",
);

/**
 * A name from a welcome answer: greetings stripped ("hi im Bryan"),
 * "I'm/it's/call me/…" lead-ins accepted, else a short bare answer
 * ("Bryan", "Bob Smith"). Once a lead-in matches, the name comes from it
 * or nowhere ("I'm good" is not a name called Good). Refusals and
 * rambles give undefined.
 */
export function welcomeName(text: string): string | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  if (WELCOME_REFUSALS.test(clean)) {
    return undefined;
  }
  let stripped = clean;
  for (;;) {
    const next = stripped
      .replace(WELCOME_GREETING, "")
      .replace(WELCOME_TRAILER, "")
      .replace(/^[^A-Za-z0-9]+/, "")
      .trim();
    if (next === stripped) {
      break;
    }
    stripped = next;
  }
  if (stripped === "") {
    return undefined;
  }
  const matches = [...stripped.matchAll(WELCOME_LEAD_INS)];
  if (matches.length > 0) {
    for (const match of matches) {
      const word = match[1] ?? "";
      if (!WELCOME_SKIP.test(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
    }
    return undefined;
  }
  const bare = stripped.replace(/[.?…!,)]+$/, "").trim();
  const words = bare.split(" ").filter((word) => word !== "");
  if (
    words.length >= 1 &&
    words.length <= 3 &&
    bare.length <= 40 &&
    /[A-Za-z]/.test(bare) &&
    !WELCOME_NOTHING.test(bare)
  ) {
    return bare.charAt(0).toUpperCase() + bare.slice(1);
  }
  return undefined;
}

/** `### 2026-10-28 09:41 · Session 7f3a · login page` (local time). */
export function entryHeading(now: Date, sessionLabel: string): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `### ${date} ${time} · ${sessionLabel}`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/**
 * Add one entry to the end of a brain file. A plain append — never
 * read-modify-write — so two windows saving at once can't wipe each other.
 * `file` is relative to brain/, e.g. "project.md" or "log/2026-10-28.md".
 */
export async function appendEntry(
  root: string,
  file: string,
  sessionLabel: string,
  text: string,
  fs: BrainFs = nodeBrainFs,
  now: Date = new Date(),
): Promise<void> {
  const target = join(root, "brain", file);
  await fs.appendFile(target, `\n${entryHeading(now, sessionLabel)}\n\n${text.trim()}\n`);
}

/** Today's log file, relative to brain/, e.g. "log/2026-10-28.md". */
export function todayLogFile(now: Date = new Date()): string {
  return `log/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`;
}

/** Short random id for a chat session label, e.g. "7f3a". */
export function createSessionId(): string {
  return randomBytes(2).toString("hex");
}

const TOPIC_LIMIT = 40;

/** Clean a topic for display: one line, bounded. */
export function cleanTopic(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TOPIC_LIMIT);
}

/**
 * The topic declared by "continue working on X", or undefined for any other
 * message. Always re-declares the chat's topic, even mid-conversation.
 */
export function continuedTopic(text: string): string | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = clean.match(/^continue working on (.+)$/i);
  if (!match) {
    return undefined;
  }
  const topic = match[1].trim().replace(/[.?…]+$/, "").slice(0, TOPIC_LIMIT);
  return topic === "" ? undefined : topic;
}

/**
 * The chat's topic from its first message: "continue working on X" names X,
 * otherwise the first line, bounded. A bare greeting ("hi") is no topic:
 * returning "" leaves the label untitled until the first real message.
 */
export function topicFromFirstMessage(text: string): string {
  const continued = continuedTopic(text);
  if (continued !== undefined) {
    return continued;
  }
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean !== "" && isGreetingOnly(clean)) {
    return "";
  }
  return clean.replace(/[.?…]+$/, "").slice(0, TOPIC_LIMIT);
}

/** True when nothing is left after the welcome's greetings are stripped. */
function isGreetingOnly(clean: string): boolean {
  let rest = clean;
  for (;;) {
    const next = rest
      .replace(WELCOME_GREETING, "")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/[^A-Za-z0-9]+$/, "")
      .trim();
    if (next === rest) {
      break;
    }
    rest = next;
  }
  return rest === "";
}

/** `Session 7f3a · login page`, or `Session 7f3a` before the topic is known. */
export function formatSessionLabel(id: string, topic: string): string {
  return topic ? `Session ${id} · ${topic}` : `Session ${id}`;
}

export interface BrainFiles {
  me?: string;
  project?: string;
  tricks?: string;
  todayLog?: string;
}

const BACKGROUND_START = "[Background:";
const BACKGROUND_END = "[End of background.]";
const BACKGROUND_BUDGET = 8000;
const SECTION_BUDGETS = { me: 1500, startHere: 1500, tricks: 1000, todayLog: 1000 };

/**
 * The background block sent with the first message of a chat: what the brain
 * remembers, marked as background, with a note telling Muse to open with
 * "Here's where we're up to:" from it. Missing sections are skipped; when the
 * block would run over budget, the oldest updates are dropped first so the
 * newest are always kept. Empty when the brain has nothing to say.
 */
export function buildBackgroundBlock(files: BrainFiles): string {
  const me = capSection(files.me, SECTION_BUDGETS.me);
  const startHere = capSection(projectStartHere(files.project), SECTION_BUDGETS.startHere);
  const tricks = capSection(files.tricks, SECTION_BUDGETS.tricks);
  const todayLog = capSection(files.todayLog, SECTION_BUDGETS.todayLog);
  const updates = lastUpdates(files.project, 10);

  const framing =
    `${BACKGROUND_START} what I remember about you and this project. ` +
    `Open with 'Here's where we're up to:' from this. No need to read the brain files. ` +
    `Remember rule 9: back up a file to .backups/ before changing it.]\n\n`;
  const fixed: string[] = [];
  if (me) {
    fixed.push(`## About you\n${me}`);
  }
  if (startHere) {
    fixed.push(`## Project: START HERE\n${startHere}`);
  }
  if (tricks) {
    fixed.push(`## Tricks\n${tricks}`);
  }
  if (todayLog) {
    fixed.push(`## Today's log\n${todayLog}`);
  }

  // Updates take whatever budget is left, newest first so the newest survive.
  let budget = BACKGROUND_BUDGET - framing.length - BACKGROUND_END.length - 4 - fixed.join("\n\n").length;
  const kept: string[] = [];
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    const entry = updates[index] ?? "";
    if (entry.length + 2 <= budget) {
      kept.unshift(entry);
      budget -= entry.length + 2;
    }
  }

  const sections: string[] = [];
  for (const section of fixed) {
    sections.push(section);
    if (kept.length > 0 && section.startsWith("## Project")) {
      sections.push(`## Latest updates\n${kept.join("\n\n")}`);
    }
  }
  if (kept.length > 0 && !startHere) {
    sections.splice(me ? 1 : 0, 0, `## Latest updates\n${kept.join("\n\n")}`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `${framing}${sections.join("\n\n")}\n\n${BACKGROUND_END}`;
}

function capSection(content: string | undefined, maxLength: number): string {
  const text = (content ?? "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** The full START HERE section of project.md, or undefined without one. */
export function projectStartHere(content: string | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## START HERE");
  if (start === -1) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("## "));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return section === "" ? undefined : section;
}

/** Updates entries from project.md, oldest first, newest `count` kept. */
export function lastUpdates(content: string | undefined, count: number): string[] {
  if (!content) {
    return [];
  }
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Updates");
  if (start === -1) {
    return [];
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("## "));
  const section = end === -1 ? rest : rest.slice(0, end);
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of section) {
    if (line.startsWith("### ")) {
      if (current.length > 0) {
        entries.push(current.join("\n").trim());
      }
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    entries.push(current.join("\n").trim());
  }
  return entries.filter((entry) => entry.length > 0).slice(-count);
}

/** Remove our background block from a resumed user message, if present. */
export function stripBackgroundPrefix(text: string): string {
  if (!text.startsWith(BACKGROUND_START)) {
    return text;
  }
  const end = text.indexOf(BACKGROUND_END);
  if (end === -1) {
    return text;
  }
  return text.slice(end + BACKGROUND_END.length).replace(/^\s+/, "");
}

export interface StoredSessionLabel {
  id: string;
  topic: string;
}

/** Validate a stored session label; anything else is forgotten. */
export function cleanSessionLabel(value: unknown): StoredSessionLabel | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const label = value as { id?: unknown; topic?: unknown };
  if (typeof label.id !== "string" || !label.id.trim() || typeof label.topic !== "string") {
    return undefined;
  }
  return { id: label.id, topic: label.topic };
}

export interface BrainCardInput {
  file: string;
  title: string;
  mtimeMs: number | undefined;
  content: string | undefined;
}

export interface BrainCard {
  file: string;
  title: string;
  updated: string;
  excerpt: string;
}

const BRAIN_CARDS: { file: string; title: string }[] = [
  { file: "me.md", title: "About you" },
  { file: "project.md", title: "Project" },
  { file: "tricks.md", title: "Tricks" },
  { file: "good-for.md", title: "Good for" },
];

/** Card inputs for the brain panel: the four files plus today's log. */
export function brainCardInputs(
  read: (file: string) => { mtimeMs: number | undefined; content: string | undefined },
  now: Date = new Date(),
): BrainCardInput[] {
  const inputs = BRAIN_CARDS.map(({ file, title }) => ({ file, title, ...read(file) }));
  const logFile = todayLogFile(now);
  inputs.push({ file: logFile, title: "Today's log", ...read(logFile) });
  return inputs;
}

/** Friendly cards for the brain panel. */
export function buildBrainCards(inputs: BrainCardInput[], nowMs: number = Date.now()): BrainCard[] {
  return inputs.map((input) => ({
    file: input.file,
    title: input.title,
    updated: input.content === undefined ? "Nothing here yet" : formatUpdated(input.mtimeMs, nowMs),
    excerpt:
      input.content === undefined
        ? "Nothing here yet."
        : input.file === "project.md"
          ? startHereSection(input.content)
          : input.file === "tricks.md"
            ? tricksPreview(input.content)
            : firstLines(input.content, 6),
  }));
}

function firstLines(content: string, count: number): string {
  const lines = content.split("\n");
  let first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) {
    return "";
  }
  // Skip a leading "# heading" line; the card already shows the title.
  if (/^#{1,6}\s/.test(lines[first] ?? "")) {
    const afterHeading = lines.findIndex((line, index) => index > first && line.trim() !== "");
    if (afterHeading === -1) {
      return "";
    }
    first = afterHeading;
  }
  return lines.slice(first, first + count).join("\n").trim();
}

/** The START HERE section of project.md (up to the next heading). */
export function startHereSection(content: string): string {
  return firstLines(projectStartHere(content) ?? content, 6);
}

/**
 * Tricks preview, newest entry first. Entries are appended (never prepended),
 * so the last three saved entries lead. Falls back to the first lines for
 * old files without dated entries (already newest first by convention).
 */
export function tricksPreview(content: string): string {
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith("### ")) {
      if (current.length > 0) {
        entries.push(current.join("\n").trim());
      }
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    entries.push(current.join("\n").trim());
  }
  const kept = entries.filter((entry) => entry.length > 0);
  if (kept.length === 0) {
    return firstLines(content, 6);
  }
  return kept.slice(-3).reverse().join("\n\n");
}

/** A first name from me.md: a `Name:` line first, then "I'm…/call me…" fallbacks. */
export function greetingName(meMd: string | undefined): string | undefined {
  if (!meMd) {
    return undefined;
  }
  const named = meMd
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^name:/i.test(line));
  if (named) {
    const name = named.replace(/^name:/i, "").trim();
    if (name !== "") {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  const pattern = /\b(?:my name is|i'm|i’m|i am|call me)\s+([A-Za-z][A-Za-z'-]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(meMd)) !== null) {
    const word = match[1] ?? "";
    if (!/^(a|an|the)$/i.test(word)) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }
  }
  return undefined;
}

/**
 * Whether a resumed chat earns the quiet start: yes when the last message is
 * from an earlier day or older than afterHours, or when we don't know.
 */
export function needsCatchUp(
  lastMessageMs: number | undefined,
  nowMs: number,
  afterHours: number,
): boolean {
  if (lastMessageMs === undefined) {
    return true;
  }
  if (lastMessageMs > nowMs) {
    return false;
  }
  const last = new Date(lastMessageMs);
  const now = new Date(nowMs);
  const sameDay =
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate();
  if (!sameDay) {
    return true;
  }
  return nowMs - lastMessageMs > Math.max(0, afterHours) * 3_600_000;
}

/** "Good morning Bryan, hold on a sec while I catch up…" for the placeholder. */
export function catchUpGreeting(now: Date, meMd: string | undefined): string {
  const hour = now.getHours();
  const part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";
  const name = greetingName(meMd);
  return name
    ? `Good ${part} ${name}, hold on a sec while I catch up…`
    : `Good ${part}, hold on a sec while I catch up…`;
}

export type SaveSection = "project" | "log" | "tricks" | "good-for" | "me";

export type SaveSections = Partial<Record<SaveSection, string>>;

/**
 * Split a save reply into its ## sections. Unknown headings are skipped,
 * empty sections are dropped, repeated sections are joined. Empty when the
 * reply has nothing worth filing.
 */
export function splitSaveReply(text: string): SaveSections {
  const sections: SaveSections = {};
  let current: SaveSection | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (current === undefined) {
      return;
    }
    const body = lines.join("\n").trim();
    if (body !== "") {
      const previous = sections[current];
      sections[current] = previous === undefined ? body : `${previous}\n\n${body}`;
    }
  };
  for (const line of text.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      flush();
      current = saveSectionName(heading[1] ?? "");
      lines = [];
    } else if (current !== undefined) {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

function saveSectionName(heading: string): SaveSection | undefined {
  switch (heading.toLowerCase().replace(/[^a-z]/g, "")) {
    case "project":
      return "project";
    case "log":
      return "log";
    case "tricks":
      return "tricks";
    case "goodfor":
      return "good-for";
    case "me":
      return "me";
    default:
      return undefined;
  }
}

/** "2:15pm" for the status line after a quick save. */
export function formatSaveTime(now: Date): string {
  const hour24 = now.getHours();
  const meridiem = hour24 < 12 ? "am" : "pm";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${pad(now.getMinutes())}${meridiem}`;
}

/** Thrown when the backup target would endanger the live brain. Nothing is deleted. */
export class UnsafeBackupError extends Error {
  public constructor(root: string, backupFolder: string) {
    super(`Refusing to back up ${root} into ${backupFolder}: the backup must live outside the workspace.`);
    this.name = "UnsafeBackupError";
  }
}

/**
 * True when the backup target is safe: not the live brain itself, neither
 * inside the workspace nor containing it. Pure path math, no disk touched.
 * A relative backup folder counts from the workspace.
 */
export function isBackupTargetSafe(root: string, backupFolder: string): boolean {
  const workspace = normBackupPath(root);
  const live = normBackupPath(join(root, "brain"));
  const target = normBackupPath(join(resolve(root, backupFolder), basename(root), "brain"));
  if (target === live || target === workspace) {
    return false;
  }
  return !target.startsWith(workspace + sep) && !workspace.startsWith(target + sep);
}

function normBackupPath(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** File operations backupBrain needs; a seam so tests can fail a copy halfway. */
export interface BackupOps {
  stat: (path: string) => Promise<unknown>;
  mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
  cp: (src: string, dest: string, options: { recursive: boolean }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
}

const defaultBackupOps: BackupOps = { stat, mkdir, rm, cp, rename };

/**
 * Copy brain/ to <backupFolder>/<workspace name>/brain/, replacing the old
 * copy. Refuses (UnsafeBackupError, nothing deleted) when the target is the
 * live brain, inside the workspace, or contains it. Copies to a temp folder
 * first and swaps it in, so a failed copy never leaves you with no backup.
 * Throws when the backup folder is missing or not writable; the caller says
 * so in one plain line and carries on.
 */
export async function backupBrain(
  root: string,
  backupFolder: string,
  ops: BackupOps = defaultBackupOps,
): Promise<void> {
  if (!isBackupTargetSafe(root, backupFolder)) {
    throw new UnsafeBackupError(root, backupFolder);
  }
  const dest = resolve(root, backupFolder);
  await ops.stat(dest);
  const parent = join(dest, basename(root));
  await ops.mkdir(parent, { recursive: true });
  const target = join(parent, "brain");
  // Our own pid-tagged temp folder, so two windows saving at once don't
  // share one. Only our own is ever cleared: another window's temp folder
  // may hold a copy in progress. (A crash can leave a brain.tmp-<pid>
  // folder behind; it's harmless.)
  const tmp = join(parent, `brain.tmp-${process.pid}`);
  await ops.rm(tmp, { recursive: true, force: true });
  await ops.cp(join(root, "brain"), tmp, { recursive: true });
  await ops.rm(target, { recursive: true, force: true });
  await ops.rename(tmp, target);
}

/**
 * Live session labels: window id -> last heartbeat ms. Two windows on one
 * folder share storage, so a fresh window adopts the stored label only when
 * no live window holds it — otherwise it keeps its own id and saves under
 * its own label.
 */
export type LiveLabels = Record<string, number>;

/** A heartbeat counts as live for 20 seconds (written every 10). */
export const LIVE_LABEL_TTL_MS = 20_000;

/** Validate stored live labels; anything else is forgotten. */
export function cleanLiveLabels(value: unknown): LiveLabels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const kept: LiveLabels = {};
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (id.trim() !== "" && typeof at === "number" && Number.isFinite(at)) {
      kept[id] = at;
    }
  }
  return kept;
}

/** True when another window holds this label with a fresh heartbeat. */
export function isLabelTaken(storedId: string, live: LiveLabels, nowMs: number): boolean {
  const at = live[storedId];
  return at !== undefined && nowMs - at < LIVE_LABEL_TTL_MS;
}

/** "Today, 2:15pm", "Yesterday" or "28 Oct". */
export function formatUpdated(mtimeMs: number | undefined, nowMs: number): string {
  if (mtimeMs === undefined) {
    return "Never";
  }
  const updated = new Date(mtimeMs);
  const now = new Date(nowMs);
  const day = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (day(updated) === day(now)) {
    const hour24 = updated.getHours();
    const meridiem = hour24 < 12 ? "am" : "pm";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `Today, ${hour12}:${pad(updated.getMinutes())}${meridiem}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(updated) === day(yesterday)) {
    return "Yesterday";
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = updated.getFullYear() === now.getFullYear() ? "" : ` ${updated.getFullYear()}`;
  return `${updated.getDate()} ${months[updated.getMonth()]}${year}`;
}
