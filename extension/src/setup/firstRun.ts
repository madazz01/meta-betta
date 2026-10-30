// First-run setup: install Muse, connect it, fix the Windows sandbox, then
// prove it works — all as friendly cards in the chat. Processes, secrets,
// cards and the test turn arrive as injected deps, so tests drive the whole
// flow with fakes. No VS Code imports.

import type { CardHandlers, CardSpec } from "../commands/slash.js";
import { serveEnv } from "../muse/museHost.js";
import { resolveMuseBin } from "../muse/resolveBin.js";
import { parseSandboxReady, shortReason } from "../lib/startup.js";

/** Meta's Windows one-liner (brief 09; dev.meta.ai is Meta's own host). */
export const WINDOWS_INSTALL_LINE = "irm https://dev.meta.ai/install.ps1 | iex";
/** Meta's Mac/Linux one-liner (Meta's own docs, same host). */
export const SHELL_INSTALL_LINE = "curl -fsSL https://dev.meta.ai/install.sh | sh";

export const API_KEY_IN_USE =
  "Using your API key (billed to your Meta API account: credits or pay as you go)";
export const LOGIN_IN_USE = "Using your Meta login (your Muse Code plan)";

/** Quick probes must answer fast; the user is staring at the panel. */
export const PROBE_TIMEOUT_MS = 15_000;
/** Signing in waits on the browser; ten minutes is generous. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** Show-details keeps this many lines (the tail that matters). */
export const DETAILS_LINES = 60;

/** One background process. Always resolves; failures come back as exit codes. */
export interface RunSpec {
  command: string;
  args: string[];
  /** Short label for Show details. Never contains the API key. */
  label: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onChunk?: (text: string) => void;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RunProcess = (spec: RunSpec) => Promise<RunResult>;

export interface FirstRunUi {
  showCard: (card: CardSpec, handlers?: CardHandlers) => string;
  updateCard: (id: string, card: CardSpec) => void;
  notice: (kind: "info" | "error", text: string) => void;
  openUrl: (url: string) => void;
}

export interface FirstRunSecrets {
  get: () => Promise<string | undefined>;
  set: (value: string) => Promise<void>;
  remove: () => Promise<void>;
}

export interface FirstRunStore {
  readyCached: () => boolean;
  setReadyCached: () => void;
}

export interface TestTurnResult {
  ok: boolean;
  reason?: string;
}

export interface FirstRunDeps {
  platform: string;
  workaroundOn: boolean;
  settingBin: string;
  museDir: string;
  dirFiles: () => string[];
  fileExists: (path: string) => boolean;
  pathHas: (name: string) => Promise<boolean>;
  run: RunProcess;
  testTurn: () => Promise<TestTurnResult>;
  secrets: FirstRunSecrets;
  store: FirstRunStore;
  ui: FirstRunUi;
  log: (message: string) => void;
}

/**
 * The checklist: installed? → connected? → sandbox? → test turn? Each fix
 * shows its card and waits for the user; the loop re-checks from the top
 * after every fix. Resolves only when Muse is ready.
 */
export async function runFirstRun(deps: FirstRunDeps): Promise<"ready"> {
  if (deps.store.readyCached()) {
    deps.log("First run: ready (cached)");
    return "ready";
  }
  deps.log("First run: starting the checklist");
  for (;;) {
    const bin = await findInstalledBin(deps);
    if (!bin) {
      deps.log("First run: Muse is not installed");
      await fixInstalled(deps);
      continue;
    }
    const stored = (await deps.secrets.get().catch(() => undefined))?.trim() || undefined;
    const probe = await probeConnection(deps, bin, stored);
    const connected = decideConnected({ storedKey: stored !== undefined, probe });
    if (connected.state !== "ok") {
      deps.log("First run: Muse is not connected");
      await fixConnected(deps, bin, connected);
      continue;
    }
    const sandbox = await checkSandbox(deps, bin);
    if (sandbox.state !== "ok") {
      deps.log("First run: the Windows sandbox needs setup");
      await fixSandbox(deps, bin, sandbox);
      continue;
    }
    const test = await deps.testTurn();
    if (!test.ok) {
      deps.log(`First run: the test turn failed (${test.reason ?? "no reason"})`);
      await fixTestTurn(deps, test.reason);
      continue;
    }
    deps.store.setReadyCached();
    deps.log("First run: ready");
    deps.ui.notice("info", `Muse is ready ✓\n${connected.inUse}`);
    return "ready";
  }
}

/** The installed binary, reusing the extension's bin finder. */
export async function findInstalledBin(deps: {
  settingBin: string;
  museDir: string;
  dirFiles: () => string[];
  fileExists: (path: string) => boolean;
  pathHas: (name: string) => Promise<boolean>;
}): Promise<string | undefined> {
  const setting = deps.settingBin.trim();
  const bin = resolveMuseBin({ setting, museDir: deps.museDir, dirFiles: deps.dirFiles() });
  if (setting) {
    // A bare name means "on PATH"; anything with a separator must exist.
    if (/[/\\]/.test(setting)) {
      return deps.fileExists(bin) ? bin : undefined;
    }
    return (await deps.pathHas(setting)) ? bin : undefined;
  }
  // The newest installed exe exists by construction; "muse" needs a PATH check.
  if (bin !== "muse") {
    return bin;
  }
  return (await deps.pathHas("muse")) ? "muse" : undefined;
}

export interface ConnectionProbe {
  ok: boolean;
  /** True when the allowance is billed to an API key rather than a plan. */
  keyBilling: boolean;
}

/** Read a `muse usage --json` run: exit 0 plus a valid schema means connected. */
export function parseUsageProbe(exitCode: number, stdout: string): ConnectionProbe {
  const failed = { ok: false, keyBilling: false };
  if (exitCode !== 0) {
    return failed;
  }
  try {
    const parsed = JSON.parse(stdout) as { schemaVersion?: unknown; reason?: unknown };
    if (parsed.schemaVersion !== 1) {
      return failed;
    }
    return { ok: true, keyBilling: parsed.reason === "api_key" };
  } catch {
    return failed;
  }
}

export type ConnectedVerdict =
  | { state: "ok"; inUse: string }
  | { state: "fixable"; keyRejected: boolean };

export function decideConnected(facts: { storedKey: boolean; probe: ConnectionProbe }): ConnectedVerdict {
  if (facts.probe.ok) {
    return {
      state: "ok",
      inUse: facts.storedKey || facts.probe.keyBilling ? API_KEY_IN_USE : LOGIN_IN_USE,
    };
  }
  return { state: "fixable", keyRejected: facts.storedKey };
}

/** The connection probe runs with the stored key, exactly like `muse serve`. */
async function probeConnection(
  deps: FirstRunDeps,
  bin: string,
  key: string | undefined,
): Promise<ConnectionProbe> {
  const env = serveEnv(key);
  const result = await deps.run({
    command: bin,
    args: ["usage", "--json"],
    label: `${binName(bin)} usage --json`,
    ...(env ? { env } : {}),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return parseUsageProbe(result.exitCode, result.stdout);
}

export type SandboxVerdict = { state: "ok" } | { state: "fixable" } | { state: "blocked" };

export function decideSandbox(facts: {
  platform: string;
  workaroundOn: boolean;
  sandboxReady: boolean;
  runningAsAdmin: boolean;
}): SandboxVerdict {
  if (facts.workaroundOn || facts.platform !== "win32") {
    return { state: "ok" };
  }
  if (facts.sandboxReady) {
    return { state: "ok" };
  }
  if (facts.runningAsAdmin) {
    return { state: "blocked" };
  }
  return { state: "fixable" };
}

async function checkSandbox(deps: FirstRunDeps, bin: string): Promise<SandboxVerdict> {
  if (deps.workaroundOn || deps.platform !== "win32") {
    return { state: "ok" };
  }
  let ready = false;
  try {
    const result = await deps.run({
      command: bin,
      args: ["sandbox", "windows", "check"],
      label: `${binName(bin)} sandbox windows check`,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    ready = result.exitCode === 0 && parseSandboxReady(result.stdout);
  } catch {
    ready = false;
  }
  if (ready) {
    return { state: "ok" };
  }
  return decideSandbox({
    platform: deps.platform,
    workaroundOn: false,
    sandboxReady: false,
    runningAsAdmin: await isAdmin(deps),
  });
}

/** `net session` answers only for admins; anywhere else it is denied. */
async function isAdmin(deps: FirstRunDeps): Promise<boolean> {
  try {
    const result = await deps.run({
      command: "net",
      args: ["session"],
      label: "net session",
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function gate(): { wait: Promise<void>; done: () => void } {
  let done!: () => void;
  const wait = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { wait, done };
}

async function fixInstalled(deps: FirstRunDeps): Promise<void> {
  const plan = installPlan(deps.platform);
  const { wait, done } = gate();
  const id = deps.ui.showCard(
    {
      title: "Muse Code isn't installed yet",
      body: "I can install it for you — it takes a minute or two.",
      buttons: [
        { id: "install", label: "Install it for me" },
        { id: "manual", label: "How to do it myself" },
      ],
    },
    {
      onButton: (button) => {
        if (button === "install" || button === "retry") {
          void runInstall(deps, id, plan, done);
        } else if (button === "manual") {
          showManual(deps, id, plan);
        } else if (button === "done-manual") {
          done();
        }
      },
    },
  );
  await wait;
}

function showManual(deps: FirstRunDeps, id: string, plan: InstallPlan): void {
  deps.ui.updateCard(id, {
    title: "Install it yourself",
    body: `1. Open ${plan.terminal}.\n2. Run: \`${plan.label}\`\n3. Come back here and click below.`,
    buttons: [{ id: "done-manual", label: "I've installed it" }],
  });
}

async function runInstall(
  deps: FirstRunDeps,
  id: string,
  plan: InstallPlan,
  done: () => void,
): Promise<void> {
  let details = `$ ${plan.label}`;
  let chunks = 0;
  let latest = "";
  const paint = (title: string, body: string, buttons?: CardSpec["buttons"]): void => {
    deps.ui.updateCard(id, {
      title,
      body,
      ...(buttons ? { buttons } : {}),
      details: { label: "Show details", text: details },
    });
  };
  paint("Installing Muse Code…", "This takes a minute or two.");
  const result = await deps.run({
    command: plan.command,
    args: plan.args,
    label: plan.label,
    onChunk: (text) => {
      details = appendCapped(details, text);
      const line = text.split("\n").filter((entry) => entry.trim() !== "").at(-1);
      if (line) {
        latest = line.trim().slice(0, 120);
      }
      chunks += 1;
      if (chunks === 1 || chunks % 10 === 0) {
        paint("Installing Muse Code…", latest || "This takes a minute or two.");
      }
    },
  });
  details = appendCapped(details, `(finished, exit code ${result.exitCode})`);
  if (result.exitCode === 0) {
    deps.log("First run: the installer finished");
    paint("Muse Code installed ✓", "Checking it landed…");
    done();
    return;
  }
  deps.log(`First run: the installer failed (exit ${result.exitCode})`);
  paint("Installing didn't work", `Installing didn't work (${shortReason(result.stderr.trim() || result.stdout.trim())}).`, [
    { id: "retry", label: "Try again" },
  ]);
}

async function fixConnected(
  deps: FirstRunDeps,
  bin: string,
  verdict: Extract<ConnectedVerdict, { state: "fixable" }>,
): Promise<void> {
  const { wait, done } = gate();
  const login: { url?: string } = {};
  const id = deps.ui.showCard(
    {
      title: "Connect Muse",
      body: verdict.keyRejected
        ? "That API key didn't work. Try another, or sign in with Meta instead."
        : "Paste an API key, or sign in with Meta.",
      buttons: [{ id: "signin", label: "Sign in with Meta" }],
      input: { id: "key", placeholder: "Paste your API key…", buttonLabel: "Save key", secret: true },
    },
    {
      onButton: (button) => {
        if (button === "signin" || button === "retry") {
          void runLogin(deps, bin, id, login, done);
        } else if (button === "open" && login.url) {
          deps.ui.openUrl(login.url);
        }
      },
      onInput: (text) => {
        void saveKey(deps, id, text, done);
      },
    },
  );
  await wait;
}

/** The key goes to secret storage and nowhere else — never a card or a log. */
async function saveKey(
  deps: FirstRunDeps,
  id: string,
  text: string,
  done: () => void,
): Promise<void> {
  const key = text.trim();
  if (!key) {
    return;
  }
  try {
    await deps.secrets.set(key);
  } catch {
    deps.ui.updateCard(id, {
      title: "Connect Muse",
      body: "Couldn't save that key here. Try again?",
      buttons: [{ id: "signin", label: "Sign in with Meta" }],
      input: { id: "key", placeholder: "Paste your API key…", buttonLabel: "Save key", secret: true },
    });
    return;
  }
  deps.log("First run: the API key is saved");
  deps.ui.updateCard(id, { title: "Connect Muse", body: "Key saved. Checking it works…" });
  done();
}

async function runLogin(
  deps: FirstRunDeps,
  bin: string,
  id: string,
  login: { url?: string },
  done: () => void,
): Promise<void> {
  // A stored key would shadow the login everywhere; the login wins from here.
  await deps.secrets.remove().catch(() => undefined);
  login.url = undefined;
  deps.ui.updateCard(id, { title: "Sign in with Meta", body: "Starting sign-in…" });
  let output = "";
  let painted = "";
  const result = await deps.run({
    command: bin,
    args: ["login"],
    label: `${binName(bin)} login`,
    timeoutMs: LOGIN_TIMEOUT_MS,
    onChunk: (text) => {
      output += text;
      const found = parseLoginOutput(output);
      login.url = found.url;
      const stamp = `${found.code ?? ""}|${found.url ?? ""}`;
      if (stamp !== painted) {
        painted = stamp;
        deps.ui.updateCard(id, loginCard(found));
      }
    },
  });
  if (result.exitCode === 0) {
    deps.log("First run: signed in");
    deps.ui.updateCard(id, { title: "Signed in ✓", body: "Checking you're connected…" });
    done();
    return;
  }
  const why = result.timedOut
    ? "it timed out waiting for the browser"
    : shortReason(result.stderr.trim() || result.stdout.trim());
  deps.ui.updateCard(id, {
    title: "Sign in with Meta",
    body: `Signing in didn't work (${why}).`,
    buttons: [{ id: "retry", label: "Try again" }],
  });
}

function loginCard(found: { code?: string; url?: string }): CardSpec {
  if (found.code && found.url) {
    return {
      title: "Sign in with Meta",
      body: `Your code: \`${found.code}\`\n\nApprove it in your browser, then wait here — I'll notice.`,
      buttons: [{ id: "open", label: "Open the Meta sign-in page" }],
    };
  }
  if (found.url) {
    return {
      title: "Sign in with Meta",
      body: "Continue in your browser, then wait here — I'll notice.",
      buttons: [{ id: "open", label: "Open the Meta sign-in page" }],
    };
  }
  return { title: "Sign in with Meta", body: "Waiting for the sign-in code…" };
}

async function fixSandbox(deps: FirstRunDeps, bin: string, verdict: SandboxVerdict): Promise<void> {
  const { wait, done } = gate();
  if (verdict.state === "blocked") {
    deps.ui.showCard(
      {
        title: "One thing before the safety setup",
        body: "You're running VS Code as an Administrator. The safety setup is per user, so close VS Code and open it normally — I'll pick up where we left off.",
        buttons: [{ id: "recheck", label: "Check again" }],
      },
      {
        onButton: (button) => {
          if (button === "recheck") {
            done();
          }
        },
      },
    );
    await wait;
    return;
  }
  const id = deps.ui.showCard(
    {
      title: "Muse needs a one-time safety setup",
      body: "Windows will ask you to allow this once. That's the only thing outside this panel.",
      buttons: [{ id: "setup", label: "Set it up" }],
    },
    {
      onButton: (button) => {
        if (button === "setup" || button === "retry") {
          void runSetup(deps, bin, id, done);
        }
      },
    },
  );
  await wait;
}

async function runSetup(
  deps: FirstRunDeps,
  bin: string,
  id: string,
  done: () => void,
): Promise<void> {
  const plan = sandboxSetupPlan(bin);
  let details = `$ ${plan.label}`;
  const paint = (title: string, body: string, buttons?: CardSpec["buttons"]): void => {
    deps.ui.updateCard(id, {
      title,
      body,
      ...(buttons ? { buttons } : {}),
      details: { label: "Show details", text: details },
    });
  };
  paint("Setting up…", "Waiting for the Windows Yes/No…");
  const result = await deps.run({
    command: plan.command,
    args: plan.args,
    label: plan.label,
    onChunk: (text) => {
      details = appendCapped(details, text);
    },
  });
  details = appendCapped(details, `(finished, exit code ${result.exitCode})`);
  if (result.exitCode === 0) {
    deps.log("First run: the sandbox setup finished");
    paint("Safety setup done ✓", "Checking it's ready…");
    done();
    return;
  }
  const cancelled = /cancel/i.test(`${result.stderr}\n${result.stdout}`);
  const why = cancelled
    ? "you clicked No on the Windows permission"
    : shortReason(result.stderr.trim() || result.stdout.trim());
  deps.log(`First run: the sandbox setup failed (exit ${result.exitCode})`);
  paint("The setup didn't finish", `The setup didn't finish (${why}).`, [{ id: "retry", label: "Try again" }]);
}

async function fixTestTurn(deps: FirstRunDeps, reason: string | undefined): Promise<void> {
  const { wait, done } = gate();
  deps.ui.showCard(
    {
      title: "Muse isn't answering yet",
      body: reason ? `One quick check didn't pass (${reason}).` : "One quick check didn't pass.",
      buttons: [{ id: "retry", label: "Try again" }],
    },
    {
      onButton: (button) => {
        if (button === "retry") {
          done();
        }
      },
    },
  );
  await wait;
}

export interface InstallPlan {
  command: string;
  args: string[];
  /** The exact one-liner, shown in Show details and the manual steps. */
  label: string;
  /** Where the manual steps tell the user to type it. */
  terminal: string;
}

/** Meta's official installer, run as a background process. */
export function installPlan(platform: string): InstallPlan {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", WINDOWS_INSTALL_LINE],
      label: WINDOWS_INSTALL_LINE,
      terminal: "PowerShell",
    };
  }
  return {
    command: "sh",
    args: ["-c", SHELL_INSTALL_LINE],
    label: SHELL_INSTALL_LINE,
    terminal: "Terminal",
  };
}

export interface SetupPlan {
  command: string;
  args: string[];
  label: string;
}

/**
 * The sandbox setup, elevated: Start-Process pops Windows' own admin Yes/No
 * (the setup can't lift itself — without this it just fails).
 */
export function sandboxSetupPlan(bin: string): SetupPlan {
  const script = `$p = Start-Process -FilePath ${psQuote(bin)} -ArgumentList 'sandbox','windows','setup' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-Command", script],
    label: `${binName(bin)} sandbox windows setup (as admin)`,
  };
}

/** Read the sign-in code and page from `muse login` output, whatever its shape. */
export function parseLoginOutput(output: string): { code?: string; url?: string } {
  const rawUrl = output.match(/https?:\/\/[^\s)>"']+/)?.[0];
  const url = rawUrl?.replace(/[.,;]+$/, "") || undefined;
  const explicit = output.match(/(?:code|passcode|device code)\s*[:\-–]\s*([A-Za-z0-9][A-Za-z0-9-]{2,})/i)?.[1];
  if (explicit) {
    return { code: explicit, ...(url ? { url } : {}) };
  }
  const lone = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){1,3}$/.test(line));
  return { ...(lone ? { code: lone } : {}), ...(url ? { url } : {}) };
}

/** Grow a details buffer, keeping the last lines. */
export function appendCapped(buffer: string, text: string, limit = DETAILS_LINES): string {
  const lines = `${buffer}\n${text}`.split("\n");
  return (lines.length > limit ? lines.slice(lines.length - limit) : lines).join("\n");
}

/** `C:\a\muse.exe` → `muse.exe`, for short progress labels. */
export function binName(bin: string): string {
  return bin.split(/[\\/]/).pop() || bin;
}

/** Single-quote a word for `sh -c`. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote a word for PowerShell. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
