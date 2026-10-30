import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { CardHandlers, CardSpec } from "../commands/slash.js";
import {
  API_KEY_IN_USE,
  LOGIN_IN_USE,
  appendCapped,
  binName,
  decideConnected,
  decideSandbox,
  findInstalledBin,
  installPlan,
  parseLoginOutput,
  parseUsageProbe,
  psQuote,
  runFirstRun,
  sandboxSetupPlan,
  shQuote,
  type FirstRunDeps,
  type RunResult,
  type RunSpec,
} from "../setup/firstRun.js";

const OK: RunResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
const USAGE_KEY = JSON.stringify({ schemaVersion: 1, allowance: null, reason: "api_key", hint: null });
const USAGE_LOGIN = JSON.stringify({
  schemaVersion: 1,
  allowance: { weekly: "10%" },
  reason: "plan",
  hint: null,
});

interface ScriptedRun {
  match: (spec: RunSpec) => boolean;
  result: RunResult;
  chunks?: string[];
}

interface FakeUi {
  cards: { id: string; card: CardSpec }[];
  paints: { id: string; card: CardSpec }[];
  notices: { kind: string; text: string }[];
  urls: string[];
  handlers: Map<string, CardHandlers>;
  onCard: ((id: string) => void) | undefined;
  onPaint: ((id: string, card: CardSpec) => void) | undefined;
}

function makeUi(): FakeUi {
  const ui: FakeUi = {
    cards: [],
    paints: [],
    notices: [],
    urls: [],
    handlers: new Map(),
    onCard: undefined,
    onPaint: undefined,
  };
  return ui;
}

interface Fakes {
  deps: FirstRunDeps;
  ui: FakeUi;
  calls: string[];
  specs: RunSpec[];
  secretsValue: string | undefined;
  ready: boolean;
  click: (id: string, button: string) => void;
  type: (id: string, text: string) => void;
  latestPaint: (id: string) => CardSpec | undefined;
}

function makeFakes(options: {
  platform?: string;
  workaroundOn?: boolean;
  settingBin?: string;
  dirFiles?: string[];
  pathHas?: (name: string) => boolean;
  runs?: ScriptedRun[];
  testTurn?: () => Promise<{ ok: boolean; reason?: string }>;
  secretsValue?: string;
}): Fakes {
  const ui = makeUi();
  const calls: string[] = [];
  const specs: RunSpec[] = [];
  let counter = 0;
  const fakes = {
    deps: null as unknown as FirstRunDeps,
    ui,
    calls,
    specs,
    secretsValue: options.secretsValue,
    ready: false,
    click: (id: string, button: string) => {
      ui.handlers.get(id)?.onButton?.(button);
    },
    type: (id: string, text: string) => {
      ui.handlers.get(id)?.onInput?.(text);
    },
    latestPaint: (id: string) => [...ui.paints].reverse().find((paint) => paint.id === id)?.card,
  };
  const pathHas = options.pathHas ?? (() => false);
  fakes.deps = {
    platform: options.platform ?? "win32",
    workaroundOn: options.workaroundOn ?? true,
    settingBin: options.settingBin ?? "",
    museDir: "C:\\muse",
    dirFiles: () => {
      calls.push("dirFiles");
      return options.dirFiles ?? [];
    },
    fileExists: (target) => target === "C:\\tools\\muse.exe",
    pathHas: async (name) => {
      calls.push(`pathHas:${name}`);
      return pathHas(name);
    },
    run: async (spec) => {
      calls.push(`run:${spec.command} ${spec.args.join(" ")}`.trim());
      specs.push(spec);
      const scripted = (options.runs ?? []).find((entry) => entry.match(spec));
      for (const chunk of scripted?.chunks ?? []) {
        spec.onChunk?.(chunk);
      }
      return scripted?.result ?? { ...OK, exitCode: 1 };
    },
    testTurn: async () => {
      calls.push("testTurn");
      return options.testTurn ? options.testTurn() : { ok: true };
    },
    secrets: {
      get: async () => fakes.secretsValue,
      set: async (value) => {
        calls.push("secrets.set");
        fakes.secretsValue = value;
      },
      remove: async () => {
        calls.push("secrets.remove");
        fakes.secretsValue = undefined;
      },
    },
    store: {
      readyCached: () => fakes.ready,
      setReadyCached: () => {
        fakes.ready = true;
      },
    },
    ui: {
      showCard: (card, handlers) => {
        counter += 1;
        const id = `card-${counter}`;
        ui.cards.push({ id, card });
        if (handlers) {
          ui.handlers.set(id, handlers);
        }
        ui.onCard?.(id);
        return id;
      },
      updateCard: (id, card) => {
        ui.paints.push({ id, card });
        ui.onPaint?.(id, card);
      },
      notice: (kind, text) => {
        ui.notices.push({ kind, text });
      },
      openUrl: (url) => {
        ui.urls.push(url);
      },
    },
    log: (message) => {
      calls.push(`log:${message}`);
    },
  };
  return fakes;
}

/** Drive the cards by title or body: click a button or type into the input. */
function scriptCards(fakes: Fakes, steps: { text: string; button?: string; input?: string }[]): void {
  const fire = (id: string, card: CardSpec, inputHere: boolean): void => {
    const step = steps.find((entry) => `${card.title}\n${card.body}`.includes(entry.text));
    // A tick later, like a real click: the card id exists by then.
    if (step?.button) {
      queueMicrotask(() => fakes.click(id, step.button as string));
    }
    // Typed once, when the card appears: progress repaints must not retype.
    if (inputHere && step?.input !== undefined) {
      const input = step.input;
      queueMicrotask(() => fakes.type(id, input));
    }
  };
  fakes.ui.onCard = (id) => {
    const card = fakes.ui.cards.find((entry) => entry.id === id)?.card;
    if (card) {
      fire(id, card, true);
    }
  };
  fakes.ui.onPaint = (id, card) => fire(id, card, false);
}

function shownText(fakes: Fakes): string[] {
  return [
    ...fakes.ui.cards.map((entry) => `${entry.card.title}\n${entry.card.body}`),
    ...fakes.ui.paints.map((entry) => `${entry.card.title}\n${entry.card.body}`),
    ...fakes.ui.notices.map((entry) => entry.text),
    ...fakes.calls.filter((call) => call.startsWith("log:")),
  ];
}

describe("installPlan", () => {
  it("runs Meta's one-liner per platform", () => {
    const windows = installPlan("win32");
    assert.equal(windows.command, "powershell.exe");
    assert.deepEqual(windows.args, ["-NoProfile", "-Command", "irm https://dev.meta.ai/install.ps1 | iex"]);
    assert.equal(windows.terminal, "PowerShell");
    for (const platform of ["darwin", "linux"]) {
      const shell = installPlan(platform);
      assert.equal(shell.command, "sh");
      assert.deepEqual(shell.args, ["-c", "curl -fsSL https://dev.meta.ai/install.sh | sh"]);
      assert.equal(shell.terminal, "Terminal");
    }
  });
});

describe("findInstalledBin", () => {
  const base = {
    museDir: "C:\\muse",
    fileExists: (target: string) => target === "C:\\tools\\muse.exe",
    pathHas: async () => false,
  };

  it("trusts a setting that exists, rejects one that does not", async () => {
    assert.equal(
      await findInstalledBin({ ...base, settingBin: "C:\\tools\\muse.exe", dirFiles: () => [] }),
      "C:\\tools\\muse.exe",
    );
    assert.equal(
      await findInstalledBin({ ...base, settingBin: "C:\\tools\\gone.exe", dirFiles: () => [] }),
      undefined,
    );
  });

  it("looks a bare setting name up on PATH", async () => {
    assert.equal(
      await findInstalledBin({
        ...base,
        settingBin: "muse-beta",
        dirFiles: () => [],
        pathHas: async (name) => name === "muse-beta",
      }),
      "muse-beta",
    );
    assert.equal(await findInstalledBin({ ...base, settingBin: "muse-beta", dirFiles: () => [] }), undefined);
  });

  it("prefers the newest installed exe, else muse on PATH", async () => {
    assert.equal(
      await findInstalledBin({
        ...base,
        settingBin: "",
        dirFiles: () => ["muse-bin-1.4.13.exe", "muse-bin-1.4.14-R7309.1.exe"],
      }),
      "C:\\muse\\muse-bin-1.4.14-R7309.1.exe",
    );
    assert.equal(
      await findInstalledBin({ ...base, settingBin: "", dirFiles: () => [], pathHas: async () => true }),
      "muse",
    );
    assert.equal(await findInstalledBin({ ...base, settingBin: "", dirFiles: () => [] }), undefined);
  });
});

describe("parseUsageProbe", () => {
  it("reads the allowance shape", () => {
    assert.deepEqual(parseUsageProbe(0, USAGE_KEY), { ok: true, keyBilling: true });
    assert.deepEqual(parseUsageProbe(0, USAGE_LOGIN), { ok: true, keyBilling: false });
    assert.deepEqual(parseUsageProbe(1, USAGE_KEY), { ok: false, keyBilling: false });
    assert.deepEqual(parseUsageProbe(0, "not json"), { ok: false, keyBilling: false });
    assert.deepEqual(parseUsageProbe(0, JSON.stringify({ schemaVersion: 99 })), {
      ok: false,
      keyBilling: false,
    });
  });
});

describe("decideConnected", () => {
  it("names which billing is in use", () => {
    assert.deepEqual(decideConnected({ storedKey: true, probe: { ok: true, keyBilling: true } }), {
      state: "ok",
      inUse: API_KEY_IN_USE,
    });
    assert.deepEqual(decideConnected({ storedKey: false, probe: { ok: true, keyBilling: true } }), {
      state: "ok",
      inUse: API_KEY_IN_USE,
    });
    assert.deepEqual(decideConnected({ storedKey: false, probe: { ok: true, keyBilling: false } }), {
      state: "ok",
      inUse: LOGIN_IN_USE,
    });
    assert.deepEqual(decideConnected({ storedKey: true, probe: { ok: false, keyBilling: false } }), {
      state: "fixable",
      keyRejected: true,
    });
    assert.deepEqual(decideConnected({ storedKey: false, probe: { ok: false, keyBilling: false } }), {
      state: "fixable",
      keyRejected: false,
    });
  });
});

describe("parseLoginOutput", () => {
  it("reads the code and page however they print", () => {
    assert.deepEqual(parseLoginOutput("Your code: ABCD-1234\nOpen https://meta.example/device ok"), {
      code: "ABCD-1234",
      url: "https://meta.example/device",
    });
    assert.deepEqual(parseLoginOutput("go to https://meta.example/x."), { url: "https://meta.example/x" });
    assert.deepEqual(parseLoginOutput("approve this:\nWXYZ-9876\nthen wait"), { code: "WXYZ-9876" });
    assert.deepEqual(parseLoginOutput("starting…"), {});
  });
});

describe("small builders", () => {
  it("caps details, names bins, quotes shells", () => {
    assert.equal(appendCapped("a\nb", "c\nd", 3), "b\nc\nd");
    assert.equal(binName("C:\\tools\\muse.exe"), "muse.exe");
    assert.equal(binName("muse"), "muse");
    assert.equal(shQuote("a'b"), "'a'\\''b'");
    assert.equal(psQuote("a'b"), "'a''b'");
  });

  it("elevates the sandbox setup", () => {
    const plan = sandboxSetupPlan("C:\\muse\\muse.exe");
    assert.equal(plan.command, "powershell.exe");
    const script = plan.args.join(" ");
    assert.match(script, /-Verb RunAs/);
    assert.match(script, /'sandbox','windows','setup'/);
    assert.match(script, /C:\\muse\\muse\.exe/);
  });
});

describe("decideSandbox", () => {
  it("skips with the workaround on or off Windows", () => {
    assert.deepEqual(
      decideSandbox({ platform: "win32", workaroundOn: true, sandboxReady: false, runningAsAdmin: false }),
      { state: "ok" },
    );
    assert.deepEqual(
      decideSandbox({ platform: "darwin", workaroundOn: false, sandboxReady: false, runningAsAdmin: false }),
      { state: "ok" },
    );
    assert.deepEqual(
      decideSandbox({ platform: "win32", workaroundOn: false, sandboxReady: true, runningAsAdmin: false }),
      { state: "ok" },
    );
  });

  it("blocks as admin, offers setup otherwise", () => {
    assert.deepEqual(
      decideSandbox({ platform: "win32", workaroundOn: false, sandboxReady: false, runningAsAdmin: true }),
      { state: "blocked" },
    );
    assert.deepEqual(
      decideSandbox({ platform: "win32", workaroundOn: false, sandboxReady: false, runningAsAdmin: false }),
      { state: "fixable" },
    );
  });
});

describe("runFirstRun", () => {
  const usageOk = (stdout: string): ScriptedRun => ({
    match: (spec) => spec.args.join(" ") === "usage --json",
    result: { ...OK, stdout },
  });

  it("checks installed → connected → sandbox → test, then caches ready", async () => {
    const fakes = makeFakes({
      workaroundOn: false,
      dirFiles: ["muse-bin-1.4.14.exe"],
      runs: [
        usageOk(USAGE_LOGIN),
        {
          match: (spec) => spec.args.join(" ") === "sandbox windows check",
          result: { ...OK, stdout: "status=ready" },
        },
      ],
    });
    await runFirstRun(fakes.deps);
    const steps = fakes.calls.filter((call) => !call.startsWith("log:"));
    assert.deepEqual(steps, [
      "dirFiles",
      `run:${join("C:\\muse", "muse-bin-1.4.14.exe")} usage --json`,
      `run:${join("C:\\muse", "muse-bin-1.4.14.exe")} sandbox windows check`,
      "testTurn",
    ]);
    assert.equal(fakes.ready, true);
    assert.equal(fakes.ui.notices.length, 1);
    assert.match(fakes.ui.notices[0]?.text ?? "", /Muse is ready ✓/);
    assert.match(fakes.ui.notices[0]?.text ?? "", /Meta login/);
    assert.equal(fakes.ui.cards.length, 0);
  });

  it("skips everything when ready is cached", async () => {
    const fakes = makeFakes({ dirFiles: ["muse-bin-1.4.14.exe"] });
    fakes.ready = true;
    await runFirstRun(fakes.deps);
    assert.deepEqual(
      fakes.calls.filter((call) => !call.startsWith("log:")),
      [],
    );
  });

  it("installs, then re-checks from the top", async () => {
    let installed = false;
    const fakes = makeFakes({ dirFiles: [], pathHas: () => false, runs: [usageOk(USAGE_LOGIN)] });
    fakes.deps.dirFiles = () => {
      fakes.calls.push("dirFiles");
      return installed ? ["muse-bin-1.4.14.exe"] : [];
    };
    scriptCards(fakes, [{ text: "isn't installed", button: "install" }]);
    const inner = fakes.deps.run;
    fakes.deps.run = (async (spec) => {
      if (spec.command === "powershell.exe") {
        fakes.calls.push(`run:${spec.command} ${spec.args.join(" ")}`.trim());
        fakes.specs.push(spec);
        installed = true;
        spec.onChunk?.("downloading…\n");
        return { ...OK, stdout: "done" };
      }
      return inner(spec);
    }) as FirstRunDeps["run"];
    await runFirstRun(fakes.deps);
    const installs = fakes.specs.filter((spec) => spec.command === "powershell.exe");
    assert.equal(installs.length, 1);
    assert.ok(installs[0]?.args.includes("irm https://dev.meta.ai/install.ps1 | iex"));
    assert.match(fakes.ui.paints.at(-1)?.card.title ?? "", /installed ✓/);
    assert.ok(fakes.ui.paints.some((paint) => (paint.card.body ?? "").includes("downloading")));
    const details =
      [...fakes.ui.paints].reverse().find((paint) => paint.card.details)?.card.details?.text ?? "";
    assert.match(details, /irm https:\/\/dev\.meta\.ai\/install\.ps1 \| iex/);
    assert.match(details, /downloading/);
    assert.equal(fakes.ready, true);
  });

  it("retries a failed install from the same card", async () => {
    let attempts = 0;
    const fakes = makeFakes({ dirFiles: ["muse-bin-1.4.14.exe"], runs: [usageOk(USAGE_LOGIN)] });
    fakes.deps.dirFiles = () => {
      fakes.calls.push("dirFiles");
      return attempts >= 2 ? ["muse-bin-1.4.14.exe"] : [];
    };
    scriptCards(fakes, [
      { text: "isn't installed", button: "install" },
      { text: "Installing didn't work", button: "retry" },
    ]);
    const inner = fakes.deps.run;
    fakes.deps.run = (async (spec) => {
      if (spec.command === "powershell.exe") {
        attempts += 1;
        fakes.calls.push(`run:${spec.command} install`);
        return attempts >= 2 ? { ...OK } : { ...OK, exitCode: 1, stderr: "no network" };
      }
      return inner(spec);
    }) as FirstRunDeps["run"];
    // First show the install card by failing the bin check, then succeed.
    fakes.deps.pathHas = async () => false;
    await runFirstRun(fakes.deps);
    assert.equal(attempts, 2);
    assert.equal(fakes.ready, true);
  });

  it("offers the manual steps with the exact one-liner", async () => {
    const fakes = makeFakes({ dirFiles: ["muse-bin-1.4.14.exe"], runs: [usageOk(USAGE_LOGIN)] });
    fakes.deps.dirFiles = () => {
      fakes.calls.push("dirFiles");
      const manual = fakes.ui.paints.some((paint) => paint.card.title === "Install it yourself");
      return manual ? ["muse-bin-1.4.14.exe"] : [];
    };
    fakes.deps.pathHas = async () => false;
    scriptCards(fakes, [
      { text: "isn't installed", button: "manual" },
      { text: "Install it yourself", button: "done-manual" },
    ]);
    await runFirstRun(fakes.deps);
    const body = fakes.ui.paints.find((paint) => paint.card.title === "Install it yourself")?.card.body ?? "";
    assert.match(body, /irm https:\/\/dev\.meta\.ai\/install\.ps1 \| iex/);
    assert.equal(fakes.ready, true);
  });

  it("saves the pasted key and never shows it", async () => {
    const sentinel = "TESTKEY-should-never-show-1";
    const fakes = makeFakes({
      dirFiles: ["muse-bin-1.4.14.exe"],
      runs: [
        {
          match: (spec) => spec.args.join(" ") === "usage --json",
          result: { ...OK, stdout: USAGE_KEY },
        },
      ],
    });
    // The probe only passes once the key rides along, like `muse serve`.
    const inner = fakes.deps.run;
    fakes.deps.run = (async (spec) => {
      if (spec.args.join(" ") === "usage --json" && spec.env?.META_API_KEY !== sentinel) {
        fakes.calls.push(`run:${spec.command} ${spec.args.join(" ")}`.trim());
        return { ...OK, exitCode: 1, stderr: "not logged in" };
      }
      return inner(spec);
    }) as FirstRunDeps["run"];
    scriptCards(fakes, [{ text: "Connect Muse", input: `  ${sentinel}  ` }]);
    await runFirstRun(fakes.deps);
    assert.equal(fakes.secretsValue, sentinel);
    assert.ok(fakes.calls.includes("secrets.set"));
    assert.ok(fakes.specs.some((spec) => spec.env?.META_API_KEY === sentinel));
    for (const text of shownText(fakes)) {
      assert.ok(!text.includes(sentinel), `leaked into: ${text.slice(0, 80)}`);
    }
    for (const spec of fakes.specs) {
      assert.ok(!spec.label.includes(sentinel));
    }
    assert.match(fakes.ui.notices[0]?.text ?? "", /API key/);
    assert.equal(fakes.ready, true);
  });

  it("signs in with a code, opening the page on click", async () => {
    const fakes = makeFakes({
      dirFiles: ["muse-bin-1.4.14.exe"],
      secretsValue: "TESTKEY-rejected-2",
      runs: [
        {
          match: (spec) => spec.args.join(" ") === "usage --json",
          result: { ...OK, exitCode: 1, stderr: "bad key" },
        },
        {
          match: (spec) => spec.args.join(" ") === "login",
          result: { ...OK, stdout: "signed in" },
          chunks: ["Your code: ABCD-1234\n", "Open https://meta.example/device to approve\n"],
        },
      ],
    });
    // After the key is dropped for the login, the probe sees the login.
    let logins = 0;
    const inner = fakes.deps.run;
    fakes.deps.run = (async (spec) => {
      if (spec.args.join(" ") === "login") {
        logins += 1;
      }
      if (spec.args.join(" ") === "usage --json" && fakes.secretsValue === undefined && logins > 0) {
        fakes.calls.push(`run:${spec.command} ${spec.args.join(" ")}`.trim());
        return { ...OK, stdout: USAGE_LOGIN };
      }
      return inner(spec);
    }) as FirstRunDeps["run"];
    scriptCards(fakes, [
      { text: "Connect Muse", button: "signin" },
      { text: "Your code:", button: "open" },
    ]);
    await runFirstRun(fakes.deps);
    assert.ok(fakes.calls.includes("secrets.remove"));
    const codePaint = fakes.ui.paints.find((paint) => (paint.card.body ?? "").includes("ABCD-1234"));
    assert.ok(codePaint, "the code shows in the card");
    assert.deepEqual(fakes.ui.urls, ["https://meta.example/device"]);
    for (const text of shownText(fakes)) {
      assert.ok(!text.includes("TESTKEY-rejected-2"), `leaked into: ${text.slice(0, 80)}`);
    }
    assert.match(fakes.ui.notices[0]?.text ?? "", /Meta login/);
    assert.equal(fakes.ready, true);
  });

  it("retries a failed sign-in", async () => {
    let logins = 0;
    const fakes = makeFakes({
      dirFiles: ["muse-bin-1.4.14.exe"],
      runs: [usageOk(USAGE_LOGIN)],
    });
    const inner = fakes.deps.run;
    fakes.deps.run = (async (spec) => {
      if (spec.args.join(" ") === "login") {
        logins += 1;
        fakes.calls.push(`run:${spec.command} ${spec.args.join(" ")}`.trim());
        return logins >= 2 ? { ...OK } : { ...OK, exitCode: 1, stderr: "denied" };
      }
      if (spec.args.join(" ") === "usage --json") {
        fakes.calls.push(`run:${spec.command} ${spec.args.join(" ")}`.trim());
        return logins >= 2 ? { ...OK, stdout: USAGE_LOGIN } : { ...OK, exitCode: 1 };
      }
      return inner(spec);
    }) as FirstRunDeps["run"];
    scriptCards(fakes, [
      { text: "Connect Muse", button: "signin" },
      { text: "Signing in didn't work", button: "retry" },
    ]);
    await runFirstRun(fakes.deps);
    assert.equal(logins, 2);
    assert.equal(fakes.ready, true);
  });

  it("sets up the sandbox when the workaround is off", async () => {
    let setups = 0;
    const fakes = makeFakes({
      workaroundOn: false,
      dirFiles: ["muse-bin-1.4.14.exe"],
      runs: [usageOk(USAGE_KEY)],
    });
    const inner = fakes.deps.run;
    fakes.deps.run = (async (spec) => {
      const argv = spec.args.join(" ");
      if (argv === "sandbox windows check") {
        fakes.calls.push(`run:${spec.command} ${argv}`);
        return setups > 0 ? { ...OK, stdout: "status=ready" } : { ...OK, stdout: "status=missing" };
      }
      if (spec.command === "powershell.exe") {
        setups += 1;
        fakes.calls.push(`run:${spec.command} setup`);
        fakes.specs.push(spec);
        return { ...OK };
      }
      return inner(spec);
    }) as FirstRunDeps["run"];
    scriptCards(fakes, [{ text: "one-time safety setup", button: "setup" }]);
    await runFirstRun(fakes.deps);
    assert.equal(setups, 1);
    assert.match(fakes.specs.map((spec) => spec.args.join(" ")).join("\n"), /-Verb RunAs/);
    assert.equal(fakes.ready, true);
  });

  it("asks admins to relaunch instead of setting up", async () => {
    const fakes = makeFakes({
      workaroundOn: false,
      dirFiles: ["muse-bin-1.4.14.exe"],
      runs: [usageOk(USAGE_KEY)],
    });
    const inner = fakes.deps.run;
    fakes.deps.run = (async (spec) => {
      const argv = spec.args.join(" ");
      if (argv === "sandbox windows check") {
        fakes.calls.push(`run:${spec.command} ${argv}`);
        const checks = fakes.calls.filter((call) => call.includes("sandbox windows check")).length;
        return checks >= 2 ? { ...OK, stdout: "status=ready" } : { ...OK, stdout: "status=missing" };
      }
      if (spec.command === "net") {
        fakes.calls.push("run:net session");
        return { ...OK };
      }
      return inner(spec);
    }) as FirstRunDeps["run"];
    scriptCards(fakes, [{ text: "before the safety", button: "recheck" }]);
    await runFirstRun(fakes.deps);
    const body = fakes.ui.cards[0]?.card.body ?? "";
    assert.match(body, /Administrator/);
    assert.equal(fakes.ui.cards.length, 1);
    assert.equal(fakes.ready, true);
  });

  it("retries a failed test turn, naming the reason", async () => {
    let turns = 0;
    const fakes = makeFakes({
      dirFiles: ["muse-bin-1.4.14.exe"],
      runs: [usageOk(USAGE_KEY)],
      testTurn: async () => {
        turns += 1;
        return turns >= 2 ? { ok: true } : { ok: false, reason: "it took too long" };
      },
    });
    scriptCards(fakes, [{ text: "isn't answering", button: "retry" }]);
    await runFirstRun(fakes.deps);
    assert.equal(turns, 2);
    assert.match(fakes.ui.cards[0]?.card.body ?? "", /it took too long/);
    assert.equal(fakes.ready, true);
  });
});
