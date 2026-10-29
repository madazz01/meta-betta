// Meta Betta chat panel. Vanilla JS, no framework.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const emptyStateEl = document.getElementById("empty-state");
  const statusEl = document.getElementById("status");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const sendButton = document.getElementById("send");
  const newChatButton = document.getElementById("new-chat");
  const saveDayButton = document.getElementById("save-day");
  const undoLastButton = document.getElementById("undo-last");
  const skipWelcomeButton = document.getElementById("skip-welcome");
  const sessionLabelButton = document.getElementById("session-label");
  const noFolderEl = document.getElementById("no-folder");
  const openFolderButton = document.getElementById("open-folder");

  let running = false;
  let catchingUpEl = null;
  const assistantEls = new Map();
  const thinkingEls = new Map();
  const toolEls = new Map();
  const approvalEls = new Map();
  const undoEls = new Map();

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideEmptyState() {
    emptyStateEl.hidden = true;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function setRunning(next) {
    running = next;
    input.disabled = next;
    sendButton.textContent = next ? "Stop" : "Send";
    if (!next) {
      dropCatchingUp();
      input.focus();
    }
  }

  function showCatchingUp(text) {
    hideEmptyState();
    if (!catchingUpEl) {
      catchingUpEl = document.createElement("div");
      catchingUpEl.className = "bubble assistant catching-up";
      messagesEl.appendChild(catchingUpEl);
    }
    catchingUpEl.textContent = text;
    scrollToBottom();
  }

  function dropCatchingUp() {
    if (catchingUpEl) {
      catchingUpEl.remove();
      catchingUpEl = null;
    }
  }

  function renderReply(text) {
    if (window.MetaBettaMarkdown) {
      return window.MetaBettaMarkdown.renderMarkdown(text);
    }
    const fallback = document.createElement("div");
    fallback.textContent = text;
    return fallback.innerHTML;
  }

  function addUserBubble(text) {
    hideEmptyState();
    const bubble = document.createElement("div");
    bubble.className = "bubble user";
    bubble.textContent = text;
    messagesEl.appendChild(bubble);
    scrollToBottom();
  }

  function upsertAssistant(id, text) {
    hideEmptyState();
    dropCatchingUp();
    let bubble = assistantEls.get(id);
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "bubble assistant";
      messagesEl.appendChild(bubble);
      assistantEls.set(id, bubble);
    }
    bubble.innerHTML = renderReply(text);
    scrollToBottom();
  }

  function upsertThinking(id, text) {
    hideEmptyState();
    let details = thinkingEls.get(id);
    if (!details) {
      details = document.createElement("details");
      details.className = "thinking";
      const summary = document.createElement("summary");
      summary.textContent = "Thinking…";
      const body = document.createElement("div");
      body.className = "thinking-text";
      details.appendChild(summary);
      details.appendChild(body);
      messagesEl.appendChild(details);
      thinkingEls.set(id, details);
    }
    details.querySelector(".thinking-text").textContent = text;
    scrollToBottom();
  }

  function upsertTool(id, text, done) {
    hideEmptyState();
    let row = toolEls.get(id);
    if (!row) {
      row = document.createElement("div");
      row.className = "tool";
      messagesEl.appendChild(row);
      toolEls.set(id, row);
    }
    row.textContent = text;
    row.classList.toggle("done", Boolean(done));
    scrollToBottom();
  }

  function addApproval(message) {
    hideEmptyState();
    const card = document.createElement("div");
    card.className = "approval";
    const title = document.createElement("p");
    title.className = "approval-title";
    title.textContent = message.title;
    card.appendChild(title);
    if (typeof message.detail === "string" && message.detail) {
      const detail = document.createElement("pre");
      detail.textContent = message.detail;
      card.appendChild(detail);
    }
    const choices = document.createElement("div");
    choices.className = "approval-choices";
    for (const choice of message.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.textContent = choice.label;
      button.addEventListener("click", () => {
        vscode.postMessage({ type: "approve", id: message.id, choiceId: choice.id });
        disableApproval(message.id, button);
      });
      choices.appendChild(button);
    }
    card.appendChild(choices);
    messagesEl.appendChild(card);
    approvalEls.set(message.id, card);
    scrollToBottom();
  }

  function disableApproval(id, chosen) {
    const card = approvalEls.get(id);
    if (!card) {
      return;
    }
    for (const button of card.querySelectorAll("button")) {
      button.disabled = true;
      if (button === chosen) {
        button.classList.add("chosen");
      }
    }
  }

  function addSaved(message) {
    hideEmptyState();
    const card = document.createElement("div");
    card.className = "saved";
    const title = document.createElement("p");
    title.className = "saved-title";
    title.textContent = message.text;
    card.appendChild(title);
    if (typeof message.backup === "string" && message.backup) {
      const backup = document.createElement("p");
      backup.className = "saved-backup";
      backup.textContent = message.backup;
      card.appendChild(backup);
    }
    if (Array.isArray(message.sections)) {
      for (const section of message.sections) {
        if (!section || typeof section.title !== "string" || typeof section.text !== "string") {
          continue;
        }
        const details = document.createElement("details");
        details.className = "saved-section";
        const summary = document.createElement("summary");
        summary.textContent = section.title;
        const body = document.createElement("div");
        body.className = "saved-text";
        body.innerHTML = renderReply(section.text);
        details.appendChild(summary);
        details.appendChild(body);
        card.appendChild(details);
      }
    }
    messagesEl.appendChild(card);
    scrollToBottom();
  }

  function addUndo(message) {
    hideEmptyState();
    let wrap = undoEls.get(message.id);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "undo";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn small";
      button.textContent = message.label;
      button.addEventListener("click", () => {
        button.disabled = true;
        vscode.postMessage({ type: "undo", id: message.id });
      });
      wrap.appendChild(button);
      messagesEl.appendChild(wrap);
      undoEls.set(message.id, wrap);
    }
    scrollToBottom();
  }

  function setUndoDone(id, state) {
    const wrap = undoEls.get(id);
    if (!wrap) {
      return;
    }
    const button = wrap.querySelector("button");
    if (!button) {
      return;
    }
    if (state === "undone") {
      button.disabled = true;
      button.textContent = "Undone ✓";
    } else if (state === "gone") {
      button.disabled = true;
      button.textContent = "Too old to undo";
    } else {
      button.disabled = false;
    }
  }

  function outlineForAWhile(el) {
    if (!el) {
      return;
    }
    el.classList.remove("outline-flash");
    void el.offsetWidth;
    el.classList.add("outline-flash");
    setTimeout(() => {
      el.classList.remove("outline-flash");
    }, 5000);
  }

  function addMemory(message) {
    hideEmptyState();
    const card = document.createElement("div");
    card.className = "memory";
    const body = document.createElement("div");
    body.className = "memory-text";
    body.innerHTML = renderReply(message.text);
    card.appendChild(body);
    const details = document.createElement("details");
    details.className = "memory-more";
    const summary = document.createElement("summary");
    summary.textContent = "How does this work?";
    const more = document.createElement("div");
    more.className = "memory-detail";
    more.innerHTML = renderReply(message.detail);
    details.appendChild(summary);
    details.appendChild(more);
    card.appendChild(details);
    messagesEl.appendChild(card);
    scrollToBottom();
    outlineForAWhile(saveDayButton);
  }

  function addNotice(message) {
    hideEmptyState();
    const notice = document.createElement("div");
    notice.className = "notice" + (message.kind === "error" ? " error" : "");
    const span = document.createElement("span");
    span.textContent = message.text;
    notice.appendChild(span);
    if (typeof message.copy === "string" && message.copy) {
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "btn small";
      copyButton.textContent = "Copy";
      copyButton.addEventListener("click", async () => {
        await copyText(message.copy);
        copyButton.textContent = "Copied";
      });
      notice.appendChild(copyButton);
    }
    messagesEl.appendChild(notice);
    scrollToBottom();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  }

  function clearChat() {
    dropCatchingUp();
    messagesEl.replaceChildren();
    assistantEls.clear();
    thinkingEls.clear();
    toolEls.clear();
    approvalEls.clear();
    undoEls.clear();
    emptyStateEl.hidden = false;
    setStatus("");
    setRunning(false);
  }

  newChatButton.addEventListener("click", () => {
    vscode.postMessage({ type: "newChat" });
  });

  saveDayButton.addEventListener("click", () => {
    vscode.postMessage({ type: "saveMyDay" });
  });

  undoLastButton.addEventListener("click", () => {
    vscode.postMessage({ type: "undoLast" });
  });

  skipWelcomeButton.addEventListener("click", () => {
    vscode.postMessage({ type: "skipWelcome" });
  });

  sessionLabelButton.addEventListener("click", () => {
    vscode.postMessage({ type: "renameSession" });
  });

  openFolderButton.addEventListener("click", () => {
    vscode.postMessage({ type: "openFolder" });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (running) {
      vscode.postMessage({ type: "stop" });
      return;
    }
    const text = input.value.trim();
    if (!text) {
      return;
    }
    input.value = "";
    setStatus("");
    vscode.postMessage({ type: "send", text });
  });

  messagesEl.addEventListener("click", (event) => {
    const anchor = event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) {
      return;
    }
    event.preventDefault();
    vscode.postMessage({ type: "openLink", url: anchor.getAttribute("href") });
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.type) {
      case "user":
        if (typeof message.text === "string") {
          addUserBubble(message.text);
        }
        break;
      case "assistant":
        if (typeof message.id === "string" && typeof message.text === "string") {
          upsertAssistant(message.id, message.text);
        }
        break;
      case "thinking":
        if (typeof message.id === "string" && typeof message.text === "string") {
          upsertThinking(message.id, message.text);
        }
        break;
      case "tool":
        if (typeof message.id === "string" && typeof message.text === "string") {
          upsertTool(message.id, message.text, message.done);
        }
        break;
      case "status":
        if (typeof message.text === "string") {
          setStatus(message.text);
        }
        break;
      case "approval":
        if (typeof message.id === "string" && typeof message.title === "string" && Array.isArray(message.choices)) {
          addApproval(message);
        }
        break;
      case "approvalDone":
        if (typeof message.id === "string") {
          disableApproval(message.id, undefined);
        }
        break;
      case "notice":
        if (typeof message.text === "string") {
          addNotice(message);
        }
        break;
      case "saved":
        if (typeof message.text === "string") {
          addSaved(message);
        }
        break;
      case "undo":
        if (typeof message.id === "string" && typeof message.label === "string") {
          addUndo(message);
        }
        break;
      case "undoDone":
        if (typeof message.id === "string" && (message.state === "undone" || message.state === "ready" || message.state === "gone")) {
          setUndoDone(message.id, message.state);
        }
        break;
      case "headerUndo":
        if (typeof message.enabled === "boolean") {
          undoLastButton.disabled = !message.enabled;
          if (typeof message.tip === "string") {
            undoLastButton.title = message.tip;
          }
        }
        break;
      case "memory":
        if (typeof message.text === "string" && typeof message.detail === "string") {
          addMemory(message);
        }
        break;
      case "welcomeSkip":
        if (typeof message.show === "boolean") {
          skipWelcomeButton.hidden = !message.show;
        }
        break;
      case "turn":
        if (message.state === "started" || message.state === "done") {
          setRunning(message.state === "started");
        }
        break;
      case "clear":
        clearChat();
        break;
      case "catchingUp":
        if (typeof message.text === "string") {
          showCatchingUp(message.text);
        }
        break;
      case "sessionLabel":
        if (typeof message.label === "string") {
          sessionLabelButton.textContent = message.label;
        }
        break;
      case "noFolder":
        noFolderEl.hidden = false;
        break;
      case "hideNoFolder":
        noFolderEl.hidden = true;
        break;
      default:
        break;
    }
  });

  input.focus();
})();
