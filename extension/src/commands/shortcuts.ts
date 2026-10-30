// Shortcut pills: the four user slots under the message box. The master
// list is the / menu's own registry (same ids, same descriptions), curated
// to the fourteen that make sense on a button. Slot choices live in
// globalState so they follow the user to every project.

import {
  APPROVAL_CHOICES,
  APPROVAL_LABELS,
  EFFORT_LABELS,
  EFFORT_LEVELS,
  findSlashCommand,
  type ApprovalChoice,
  type EffortLevel,
} from "./slash.js";

export interface ShortcutDef {
  /** Slash command id ("goal", "save" …). */
  id: string;
  /** Pill label ("Goal", "Save my day" …). */
  label: string;
  description: string;
}

/** The fourteen pill-worthy shortcuts, in popup order. */
export const SHORTCUT_IDS = [
  "goal",
  "side",
  "fork",
  "usage",
  "recap",
  "compact",
  "model",
  "effort",
  "tasks",
  "skills",
  "plugins",
  "export",
  "resume",
  "save",
];

/** Four pills; a fresh user gets Goal · Side · Fork · Usage. */
export const SHORTCUT_SLOT_COUNT = 4;
export const DEFAULT_SHORTCUT_SLOTS = ["goal", "side", "fork", "usage"];

const SHORTCUT_LABELS: Record<string, string> = {
  save: "Save my day",
};

function shortcutLabel(id: string): string {
  return SHORTCUT_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** The master list: pills, popup rows and the / menu share one source. */
export function shortcutDefs(): ShortcutDef[] {
  const defs: ShortcutDef[] = [];
  for (const id of SHORTCUT_IDS) {
    const slash = findSlashCommand(id);
    if (slash) {
      defs.push({ id, label: shortcutLabel(id), description: slash.description });
    }
  }
  return defs;
}

/** How a pill runs: Goal asks for the goal, the rest run their / command. */
export function shortcutDispatch(id: string): "askGoal" | "slash" | undefined {
  if (id === "goal") {
    return "askGoal";
  }
  return findSlashCommand(id) ? "slash" : undefined;
}

/** Stored slots back into shape: four known ids, defaults filling gaps. */
export function cleanShortcutSlots(value: unknown): string[] {
  const known = new Set(SHORTCUT_IDS);
  const slots: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && known.has(entry) && !slots.includes(entry)) {
        slots.push(entry);
      }
      if (slots.length >= SHORTCUT_SLOT_COUNT) {
        break;
      }
    }
  }
  for (const fallback of DEFAULT_SHORTCUT_SLOTS) {
    if (slots.length >= SHORTCUT_SLOT_COUNT) {
      break;
    }
    if (!slots.includes(fallback)) {
      slots.push(fallback);
    }
  }
  return slots;
}

/**
 * Put a shortcut on a pill. Picking one that's already on another pill
 * swaps the two, so no shortcut ever sits on two pills at once.
 */
export function swapShortcutSlot(slots: readonly string[], index: number, id: string): string[] {
  const clean = cleanShortcutSlots(slots);
  if (!SHORTCUT_IDS.includes(id) || index < 0 || index >= SHORTCUT_SLOT_COUNT) {
    return clean;
  }
  const next = [...clean];
  const other = next.indexOf(id);
  if (other !== -1 && other !== index) {
    next[other] = next[index] as string;
  }
  next[index] = id;
  return next;
}

export interface EffortMenuRow {
  id: EffortLevel;
  label: string;
  ticked: boolean;
}

/** The Effort button menu: every supported level, the current one ticked. */
export function effortMenu(current: EffortLevel): EffortMenuRow[] {
  return EFFORT_LEVELS.map((id) => ({ id, label: EFFORT_LABELS[id], ticked: id === current }));
}

export interface ApprovalsMenuRow {
  id: ApprovalChoice;
  label: string;
  ticked: boolean;
}

/** The Approvals button menu: Ask, Auto, All, the current one ticked. */
export function approvalsMenu(current: ApprovalChoice): ApprovalsMenuRow[] {
  return APPROVAL_CHOICES.map((id) => ({ id, label: APPROVAL_LABELS[id], ticked: id === current }));
}
