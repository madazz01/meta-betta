// Pure approval helpers: plain-English card titles and the safest-choice
// fallback used when the panel is closed. No VS Code imports.

export interface ApprovalChoiceView {
  choiceId: string;
  decision: string;
  label: string;
}

export interface ApprovalStageView {
  argv: string[];
  position: number;
  totalStages: number;
}

export interface ApprovalSubjectView {
  kind: string;
  command?: string;
  access?: string;
  host?: string;
  port?: number;
  protocol?: string;
  path?: string;
  target?: string;
  toolName?: string;
  stages?: ApprovalStageView[];
}

export interface ApprovalCard {
  title: string;
  detail?: string;
  /** "(step 2 of 3) …" for a multi-stage shell command; the full command stays in detail. */
  stageLine?: string;
}

/**
 * The stage awaiting a decision: position equals sourceIndex + 1, else the
 * first stage, else undefined when the server sent no stages.
 */
export function currentStage(
  stages: ApprovalStageView[] | undefined,
  sourceIndex: number,
): ApprovalStageView | undefined {
  if (!stages || stages.length === 0) {
    return undefined;
  }
  return stages.find((stage) => stage.position === sourceIndex + 1) ?? stages[0];
}

/** Plain-English card for an approval request. Unknown kinds stay generic. */
export function approvalCard(
  subject: ApprovalSubjectView,
  toolName: string,
  rawArgs: string,
  sourceIndex = 0,
): ApprovalCard {
  switch (subject.kind) {
    case "shell": {
      const stage = currentStage(subject.stages, sourceIndex);
      const full = truncate(subject.command ?? "", 300) || undefined;
      if (stage && stage.totalStages > 1) {
        return {
          title: "Muse wants to run a command",
          detail: full,
          stageLine: `(step ${stage.position} of ${stage.totalStages}) ${truncate(stage.argv.join(" "), 200)}`,
        };
      }
      return { title: "Muse wants to run a command", detail: full };
    }
    case "fileAccess": {
      const verb = subject.access === "write" ? "change" : subject.access === "read" ? "read" : "open";
      return { title: `Muse wants to ${verb} a file`, detail: subject.path };
    }
    case "network": {
      const where = subject.host
        ? `${subject.protocol ?? "https"}://${subject.host}${subject.port ? `:${subject.port}` : ""}`
        : undefined;
      return { title: "Muse wants to reach the network", detail: where };
    }
    case "process":
      return { title: "Muse wants to control a process", detail: subject.target };
    default: {
      const who = subject.toolName ?? toolName;
      return {
        title: who ? `Muse wants to use ${who}` : "Muse wants your permission",
        detail: truncate(rawArgs, 200) || undefined,
      };
    }
  }
}

/**
 * A hover hint for the "always allow in this workspace" choice (a saved
 * rule, not a one-off). Matched by scope/decision, never by label or id.
 */
export function choiceHint(choice: { scope: string; decision: string }): string | undefined {
  if (choice.scope === "localPersistent" || choice.decision === "approvedPolicyAmendment") {
    return "Muse won't ask again for commands starting with this, in this project only.";
  }
  return undefined;
}

/**
 * The safest offered choice: a denial first, then abort, else the first
 * choice. Used when the panel is closed and the user can't click.
 */
export function safestChoiceId(choices: ApprovalChoiceView[]): string | undefined {
  return (
    choices.find((choice) => choice.decision === "denied")?.choiceId ??
    choices.find((choice) => choice.decision.startsWith("denied"))?.choiceId ??
    choices.find((choice) => choice.decision === "abort")?.choiceId ??
    choices[0]?.choiceId
  );
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
