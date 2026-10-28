// Meta Betta chat panel. Vanilla JS, no framework.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const emptyStateEl = document.getElementById("empty-state");
  const statusEl = document.getElementById("status");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function addBubble(role, text) {
    emptyStateEl.hidden = true;
    const bubble = document.createElement("div");
    bubble.className = "bubble " + role;
    bubble.textContent = text;
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }
    addBubble("user", text);
    input.value = "";
    setStatus("");
    vscode.postMessage({ type: "send", text });
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
    if (message.type === "reply" && typeof message.text === "string") {
      setStatus("");
      addBubble("assistant", message.text);
    } else if (message.type === "status" && typeof message.text === "string") {
      setStatus(message.text);
    }
  });

  input.focus();
})();
