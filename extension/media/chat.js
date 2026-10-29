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
  const sessionLabelButton = document.getElementById("session-label");
  const noFolderEl = document.getElementById("no-folder");
  const openFolderButton = document.getElementById("open-folder");

  let running = false;
  let catchingUpEl = null;
  const assistantEls = new Map();
  const thinkingEls = new Map();
  const toolEls = new Map();
  const approvalEls = new Map();

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
    emptyStateEl.hidden = false;
    setStatus("");
    setRunning(false);
  }

  newChatButton.addEventListener("click", () => {
    vscode.postMessage({ type: "newChat" });
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
