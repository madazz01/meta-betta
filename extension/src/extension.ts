import * as vscode from "vscode";
import { formatSessionLabel, cleanSessionLabel } from "./brain/brain.js";
import { BrainViewProvider } from "./brain/brainView.js";
import { ChatController } from "./chatController.js";
import { bindChatPanel, CHAT_PANEL_VIEW_TYPE, openChatTab } from "./chatPanel.js";
import { ChatViewProvider, readOpenIn } from "./chatView.js";
import {
  cleanTabRecords,
  createTabUid,
  MAIN_TAB_UID,
  reviveSeed,
  tabTitle,
  type TabRecord,
  type TabSeed,
} from "./lib/chatTabs.js";

const TABS_KEY = "metaBetta.tabs";
const SESSION_ID_KEY = "metaBetta.sessionId";
const SESSION_LABEL_KEY = "metaBetta.sessionLabel";

interface ChatTab {
  uid: string;
  controller: ChatController;
  panel?: vscode.WebviewPanel;
}

interface ExtCtx {
  extensionUri: vscode.Uri;
  storage: vscode.Memento;
  globalState: vscode.Memento;
  storageDir: string | undefined;
  log: (message: string) => void;
  brainChanged: (files: string[]) => void;
  outline: () => void;
}

let ctx: ExtCtx | undefined;
let mainTab: ChatTab | undefined;
let extraTabs: ChatTab[] = [];
let activeUid = MAIN_TAB_UID;
let usageBar: vscode.StatusBarItem | undefined;
let viewProvider: ChatViewProvider | undefined;
let brainProvider: BrainViewProvider | undefined;
let brainSideProvider: BrainViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Meta Betta");
  context.subscriptions.push(output);
  usageBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  usageBar.command = "metaBetta.showUsage";
  usageBar.text = "☕ Muse";
  usageBar.tooltip = "Meta Betta usage — click for details";
  usageBar.show();
  ctx = {
    extensionUri: context.extensionUri,
    storage: context.workspaceState,
    globalState: context.globalState,
    storageDir: context.storageUri?.fsPath,
    log: (message) => output.appendLine(`[${new Date().toLocaleTimeString("en-GB")}] ${message}`),
    brainChanged: (files) => {
      for (const provider of [brainProvider, brainSideProvider]) {
        if (provider) {
          void provider.refresh().then(
            () => provider.flash(files),
            () => undefined,
          );
        }
      }
    },
    outline: () => {
      brainProvider?.outline();
      brainSideProvider?.outline();
    },
  };
  // The first chat resumes the saved session; the sidebar mirrors it.
  mainTab = { uid: MAIN_TAB_UID, controller: createController(MAIN_TAB_UID, mainSeed()) };
  viewProvider = new ChatViewProvider(context.extensionUri, mainTab.controller, () => {
    openMainPanel();
  });
  brainProvider = new BrainViewProvider(context.extensionUri);
  brainSideProvider = new BrainViewProvider(context.extensionUri);
  context.subscriptions.push(
    usageBar,
    vscode.commands.registerCommand("metaBetta.showUsage", () => {
      void activeTab().controller.dispatchSlash("usage", "");
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(BrainViewProvider.viewType, brainProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(
      BrainViewProvider.sideViewType,
      brainSideProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    vscode.window.registerWebviewPanelSerializer(CHAT_PANEL_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => reviveTab(panel, state),
    }),
    vscode.commands.registerCommand("metaBetta.open", async () => {
      if (readOpenIn() === "sidebar") {
        await vscode.commands.executeCommand("metaBetta.chat.focus");
      } else {
        const active = findTab(activeUid);
        if (active?.panel) {
          active.panel.reveal(vscode.ViewColumn.Active);
        } else {
          openMainPanel();
        }
      }
    }),
    vscode.commands.registerCommand("metaBetta.saveMyDay", () => {
      void activeTab().controller.saveMyDay();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("metaBetta.openIn")) {
        viewProvider?.sync();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      for (const tab of allTabs()) {
        void tab.controller.trustGranted();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      for (const tab of allTabs()) {
        tab.controller.refreshFolder();
      }
      void brainProvider?.refresh();
      void brainSideProvider?.refresh();
    }),
  );
}

export function deactivate(): Promise<void> | void {
  const tabs = allTabs();
  mainTab = undefined;
  extraTabs = [];
  viewProvider = undefined;
  brainProvider = undefined;
  brainSideProvider = undefined;
  usageBar = undefined;
  ctx = undefined;
  if (tabs.length > 0) {
    return (async () => {
      for (const tab of tabs) {
        await tab.controller.dispose();
      }
    })();
  }
}

function allTabs(): ChatTab[] {
  return mainTab ? [mainTab, ...extraTabs] : [...extraTabs];
}

function findTab(uid: string): ChatTab | undefined {
  return allTabs().find((tab) => tab.uid === uid);
}

function activeTab(): ChatTab {
  return findTab(activeUid) ?? mainTab as ChatTab;
}

function createController(uid: string, seed?: TabSeed): ChatController {
  const context = ctx as ExtCtx;
  return new ChatController(
    context.extensionUri,
    context.storage,
    context.brainChanged,
    context.storageDir,
    context.log,
    context.outline,
    (text) => {
      // The status bar belongs to the active tab, whichever that is.
      if (usageBar && activeUid === uid) {
        usageBar.text = text;
      }
    },
    context.globalState,
    {
      uid,
      seed,
      onChanged: (record) => tabChanged(uid, record),
      onNewTab: () => openTab(createTabUid()),
      onForkTab: (sessionId) => openTab(createTabUid(), { session: sessionId, catchUp: true }),
      labelOf: (other) => labelOf(other),
      revealTab: (other) => revealTab(other),
      stopTab: (other) => stopTab(other),
    },
  );
}

/** The first tab's reload seed: its record, else the pre-tabs keys. */
function mainSeed(): TabSeed | undefined {
  if (!ctx) {
    return undefined;
  }
  return reviveSeed(MAIN_TAB_UID, tabRecords(), {
    session: ctx.storage.get<string>(SESSION_ID_KEY),
    label: cleanSessionLabel(ctx.storage.get<unknown>(SESSION_LABEL_KEY)),
  });
}

function tabRecords(): Record<string, TabRecord> {
  return ctx ? cleanTabRecords(ctx.storage.get<unknown>(TABS_KEY)) : {};
}

/** Merge a tab record change, then retitle its tab. */
function tabChanged(uid: string, patch: TabRecord): void {
  if (!ctx) {
    return;
  }
  const records = tabRecords();
  records[uid] = { ...records[uid], ...patch };
  void ctx.storage.update(TABS_KEY, records);
  const tab = findTab(uid);
  if (tab?.panel) {
    tab.panel.title = tabTitle(records[uid]?.topic ?? "");
  }
}

function labelOf(uid: string): string | undefined {
  const record = tabRecords()[uid];
  if (!record?.labelId) {
    return undefined;
  }
  return formatSessionLabel(record.labelId, record.topic ?? "");
}

function setActiveTab(uid: string): void {
  activeUid = uid;
  const tab = findTab(uid);
  if (tab && usageBar) {
    usageBar.text = tab.controller.statusBarText();
  }
}

/** Open a fresh (or fork-seeded) tab and focus it. */
function openTab(uid: string, seed?: TabSeed): void {
  if (!ctx) {
    return;
  }
  const controller = createController(uid, seed);
  const tab: ChatTab = { uid, controller };
  extraTabs.push(tab);
  const panel = openChatTab(ctx.extensionUri, controller, tabTitle(seed?.topic ?? ""), () =>
    closeTab(uid),
  );
  tab.panel = panel;
  panel.onDidChangeViewState(() => {
    if (panel.active) {
      setActiveTab(uid);
    }
  });
  setActiveTab(uid);
}

/** Open (or reveal) the first chat's tab. */
function openMainPanel(): void {
  if (!ctx || !mainTab) {
    return;
  }
  if (mainTab.panel) {
    mainTab.panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  const panel = openChatTab(ctx.extensionUri, mainTab.controller, mainTitle(), () =>
    closeTab(MAIN_TAB_UID),
  );
  mainTab.panel = panel;
  panel.onDidChangeViewState(() => {
    if (panel.active) {
      setActiveTab(MAIN_TAB_UID);
    }
  });
  setActiveTab(MAIN_TAB_UID);
}

function mainTitle(): string {
  return tabTitle(tabRecords()[MAIN_TAB_UID]?.topic ?? "");
}

/** A tab closed: extra tabs dispose with it; the first chat lives on. */
function closeTab(uid: string): void {
  if (uid === MAIN_TAB_UID) {
    if (mainTab) {
      mainTab.panel = undefined;
    }
    return;
  }
  const index = extraTabs.findIndex((tab) => tab.uid === uid);
  if (index === -1) {
    return;
  }
  const [tab] = extraTabs.splice(index, 1);
  if (tab) {
    void tab.controller.dispose();
  }
  if (ctx) {
    const records = tabRecords();
    delete records[uid];
    void ctx.storage.update(TABS_KEY, records);
  }
  if (activeUid === uid) {
    setActiveTab(MAIN_TAB_UID);
  }
}

function revealTab(uid: string): void {
  const tab = findTab(uid);
  if (!tab || !ctx) {
    return;
  }
  if (tab.panel) {
    tab.panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  // The chat is running panel-less (sidebar): take them to it.
  if (uid === MAIN_TAB_UID) {
    if (readOpenIn() === "sidebar") {
      void vscode.commands.executeCommand("metaBetta.chat.focus");
    } else {
      openMainPanel();
    }
  }
}

function stopTab(uid: string): void {
  findTab(uid)?.controller.stop();
}

/** Reload: each reopened tab resumes its own session id. */
async function reviveTab(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
  if (!ctx) {
    return;
  }
  const tabUid =
    typeof state === "object" && state !== null
      ? (state as Record<string, unknown>).tabUid
      : undefined;
  // A revived panel with no tab id is the pre-tabs chat: the first tab.
  const uid = typeof tabUid === "string" && tabUid ? tabUid : MAIN_TAB_UID;
  const live = findTab(uid);
  if (live?.panel) {
    panel.dispose();
    live.panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  if (uid === MAIN_TAB_UID && mainTab && !mainTab.panel) {
    mainTab.panel = panel;
    bindChatPanel(panel, ctx.extensionUri, mainTab.controller, () => closeTab(MAIN_TAB_UID));
    panel.title = mainTitle();
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        setActiveTab(MAIN_TAB_UID);
      }
    });
    return;
  }
  const seed = reviveSeed(uid, tabRecords());
  const controller = createController(uid, seed);
  const tab: ChatTab = { uid, controller, panel };
  extraTabs.push(tab);
  bindChatPanel(panel, ctx.extensionUri, controller, () => closeTab(uid));
  panel.title = tabTitle(seed?.topic ?? "");
  panel.onDidChangeViewState(() => {
    if (panel.active) {
      setActiveTab(uid);
    }
  });
}
