// Pure startup helpers: classifying spawn failures and reading the sandbox
// check. No VS Code imports, no child processes (those live in museHost).

/** True when `muse sandbox windows check` output reports the sandbox ready. */
export function parseSandboxReady(output: string): boolean {
  return /\bstatus\s*=\s*ready\b/i.test(output);
}

export type SpawnProblem = "missing" | "login" | "other";

/**
 * Classify a `MuseClient.spawn` / `startSession` failure so the panel can show
 * the right friendly card: "missing" (not installed), "login" (not logged in),
 * or "other" (caller runs the sandbox check next).
 */
export function classifySpawnError(error: unknown): SpawnProblem {
  if (isMissingBinary(error)) {
    return "missing";
  }
  if (mentionsLogin(errorText(error))) {
    return "login";
  }
  return "other";
}

/** First line of an error, bounded — safe to show after "Something went wrong: ". */
export function shortReason(error: unknown, maxLength = 160): string {
  const message = errorText(error).replace(/\s+/g, " ").trim();
  if (!message) {
    return "it didn't say why";
  }
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}

function isMissingBinary(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const withCode = error as { code?: unknown; failure?: unknown };
  // A raw Node spawn error, or the SDK's typed spawnFailed arm.
  if (withCode.code === "ENOENT") {
    return true;
  }
  if (typeof withCode.failure === "object" && withCode.failure !== null) {
    const failure = withCode.failure as { kind?: unknown; error?: unknown };
    if (
      failure.kind === "spawnFailed" &&
      typeof failure.error === "object" &&
      failure.error !== null &&
      (failure.error as { code?: unknown }).code === "ENOENT"
    ) {
      return true;
    }
  }
  return /\bENOENT\b/i.test(errorMessage(error));
}

function mentionsLogin(text: string): boolean {
  return /\b(auth|login|logged in|sign in|unauthorized|unauthenticated)\b/i.test(text);
}

function errorText(error: unknown): string {
  const tail = stderrTail(error);
  const message = errorMessage(error);
  return tail ? `${message}\n${tail}` : message;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "";
}

function stderrTail(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const tail = (error as { stderrTail?: unknown }).stderrTail;
  if (Array.isArray(tail) && tail.every((line): line is string => typeof line === "string")) {
    return tail.join("\n");
  }
  return "";
}
