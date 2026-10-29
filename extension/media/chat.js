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
  const headerGoalButton = document.getElementById("header-goal");
  const headerSideButton = document.getElementById("header-side");
  const headerForkButton = document.getElementById("header-fork");
  const headerUsageButton = document.getElementById("header-usage");
  const noFolderEl = document.getElementById("no-folder");
  const openFolderButton = document.getElementById("open-folder");
  const goalEl = document.getElementById("goal");
  const slashMenuEl = document.getElementById("slash-menu");
  const effortButton = document.getElementById("effort");
  const plusButton = document.getElementById("plus");

  // A reply shows its time only after a long gap in the conversation.
  const LONG_GAP_MS = 30 * 60 * 1000;

  let running = false;
  let catchingUpEl = null;
  let turnEl = null;
  let lastStampAt = 0;
  const assistantEls = new Map();
  const thinkingEls = new Map();
  const toolEls = new Map();
  const pickerQueue = [];
  let pickerShown = null;
  let pickerSelected = 0;
  const undoEls = new Map();
  const nudgeEls = new Map();
  const cardEls = new Map();
  let slashList = [];
  let slashOpen = false;
  let slashIndex = 0;
  let slashQuery = "";

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideEmptyState() {
    emptyStateEl.hidden = true;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  // One turn's steps share a container, so the timeline can join them with
  // one faint line. Your messages and day dividers always start fresh.
  function openTurn() {
    turnEl = document.createElement("div");
    turnEl.className = "turn";
    messagesEl.appendChild(turnEl);
  }

  function closeTurn() {
    turnEl = null;
  }

  function stepParent() {
    if (!turnEl) {
      openTurn();
    }
    return turnEl;
  }

  // The message box stays disabled while a picker is up.
  function updateComposer() {
    input.disabled = running || pickerQueue.length > 0;
  }

  function setRunning(next) {
    running = next;
    updateComposer();
    sendButton.textContent = next ? "Stop" : "Send";
    if (!next) {
      dropCatchingUp();
      input.focus();
    }
    updateNudgeButtons();
  }

  // Nudge answers send a new turn, so the buttons wait like the composer.
  function updateNudgeButtons() {
    for (const card of nudgeEls.values()) {
      if (card.dataset.answered) {
        continue;
      }
      for (const button of card.querySelectorAll("button")) {
        button.disabled = running;
      }
    }
  }

  function showCatchingUp(text) {
    hideEmptyState();
    if (!catchingUpEl) {
      catchingUpEl = document.createElement("div");
      catchingUpEl.className = "catching-up";
      stepParent().appendChild(catchingUpEl);
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

  function addUserMessage(text, time) {
    hideEmptyState();
    closeTurn();
    if (typeof time === "string" && time) {
      const clock = document.createElement("div");
      clock.className = "user-time";
      clock.textContent = time;
      messagesEl.appendChild(clock);
    }
    lastStampAt = Date.now();
    const box = document.createElement("div");
    box.className = "user-msg";
    box.textContent = text;
    messagesEl.appendChild(box);
    scrollToBottom();
  }

  function upsertAssistant(id, text, time) {
    hideEmptyState();
    dropCatchingUp();
    let reply = assistantEls.get(id);
    if (!reply) {
      reply = document.createElement("div");
      reply.className = "assistant-reply";
      if (typeof time === "string" && time && Date.now() - lastStampAt > LONG_GAP_MS) {
        lastStampAt = Date.now();
        const clock = document.createElement("div");
        clock.className = "reply-time";
        clock.textContent = time;
        reply.appendChild(clock);
      }
      const body = document.createElement("div");
      body.className = "assistant-text";
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      const fork = document.createElement("button");
      fork.type = "button";
      fork.className = "fork-btn";
      fork.textContent = "Try another way";
      fork.title = "Try another way from here";
      fork.addEventListener("click", () => {
        vscode.postMessage({ type: "forkMessage", id });
      });
      meta.appendChild(fork);
      reply.appendChild(body);
      reply.appendChild(meta);
      stepParent().appendChild(reply);
      assistantEls.set(id, reply);
    }
    const nudge = findNudge(text);
    const bodyText = nudge ? text.replace(nudge.paragraph, "").trim() : text;
    reply.querySelector(".assistant-text").innerHTML = renderReply(bodyText);
    reply.style.display = nudge && !bodyText ? "none" : "";
    if (nudge) {
      upsertNudgeCard(id, nudge);
    }
    scrollToBottom();
  }

  // A 💡 paragraph (front-door rule 10) becomes a card with buttons.
  function findNudge(text) {
    const paragraphs = String(text).split(/\n\s*\n/);
    for (const paragraph of paragraphs) {
      const match = paragraph.match(/💡\s*Did you know I can also (.+?)\?/is);
      if (match) {
        return { paragraph, thing: match[1].replace(/\s+/g, " ").trim().slice(0, 120) };
      }
    }
    return null;
  }

  function upsertNudgeCard(id, nudge) {
    let card = nudgeEls.get(id);
    if (!card) {
      card = document.createElement("div");
      card.className = "nudge";
      const body = document.createElement("div");
      body.className = "nudge-text";
      const buttons = document.createElement("div");
      buttons.className = "nudge-buttons";
      const showButton = document.createElement("button");
      showButton.type = "button";
      showButton.className = "btn";
      showButton.textContent = "Show me";
      showButton.addEventListener("click", () => {
        vscode.postMessage({ type: "nudgeAnswer", id, answer: "show", thing: nudge.thing });
        disableNudge(id, "show");
      });
      const notnowButton = document.createElement("button");
      notnowButton.type = "button";
      notnowButton.className = "btn";
      notnowButton.textContent = "Not now";
      notnowButton.addEventListener("click", () => {
        vscode.postMessage({ type: "nudgeAnswer", id, answer: "notnow", thing: nudge.thing });
        disableNudge(id, "notnow");
      });
      buttons.appendChild(showButton);
      buttons.appendChild(notnowButton);
      card.appendChild(body);
      card.appendChild(buttons);
      stepParent().appendChild(card);
      nudgeEls.set(id, card);
    }
    if (!card.dataset.answered) {
      card.querySelector(".nudge-text").innerHTML = renderReply(nudge.paragraph);
    }
    updateNudgeButtons();
    scrollToBottom();
  }

  function disableNudge(id, answer) {
    const card = nudgeEls.get(id);
    if (!card || card.dataset.answered) {
      return;
    }
    card.dataset.answered = "yes";
    const buttons = card.querySelectorAll("button");
    for (const button of buttons) {
      button.disabled = true;
    }
    const chosen = answer === "show" ? buttons[0] : answer === "notnow" ? buttons[1] : undefined;
    if (chosen) {
      chosen.classList.add("chosen");
    }
  }

  function addDayDivider(label) {
    hideEmptyState();
    closeTurn();
    const divider = document.createElement("div");
    divider.className = "day-divider";
    divider.textContent = `── ${label} ──`;
    messagesEl.appendChild(divider);
    scrollToBottom();
  }

  function renderCard(message) {
    hideEmptyState();
    let card = cardEls.get(message.id);
    if (!card) {
      card = document.createElement("div");
      card.className = "card";
      stepParent().appendChild(card);
      cardEls.set(message.id, card);
    }
    card.replaceChildren();
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = message.title;
    const body = document.createElement("div");
    body.className = "card-body";
    body.innerHTML = renderReply(message.body);
    card.appendChild(title);
    card.appendChild(body);
    if (Array.isArray(message.buttons) && message.buttons.length > 0) {
      const row = document.createElement("div");
      row.className = "card-buttons";
      for (const button of message.buttons) {
        if (!button || typeof button.id !== "string" || typeof button.label !== "string") {
          continue;
        }
        const el = document.createElement("button");
        el.type = "button";
        el.className = "btn";
        el.textContent = button.label;
        el.addEventListener("click", () => {
          vscode.postMessage({ type: "cardButton", cardId: message.id, buttonId: button.id });
          disableCard(message.id);
        });
        row.appendChild(el);
      }
      card.appendChild(row);
    }
    const spec = message.input;
    if (spec && typeof spec.id === "string" && typeof spec.placeholder === "string") {
      const formEl = document.createElement("form");
      formEl.className = "card-input";
      const field = document.createElement("input");
      field.type = "text";
      field.placeholder = spec.placeholder;
      field.setAttribute("aria-label", spec.placeholder);
      const go = document.createElement("button");
      go.type = "submit";
      go.className = "btn";
      go.textContent = typeof spec.buttonLabel === "string" ? spec.buttonLabel : "Send";
      formEl.appendChild(field);
      formEl.appendChild(go);
      formEl.addEventListener("submit", (event) => {
        event.preventDefault();
        vscode.postMessage({ type: "cardInput", cardId: message.id, inputId: spec.id, text: field.value });
        field.value = "";
      });
      card.appendChild(formEl);
    }
    scrollToBottom();
  }

  function disableCard(id) {
    const card = cardEls.get(id);
    if (!card) {
      return;
    }
    for (const el of card.querySelectorAll("button, input")) {
      el.disabled = true;
    }
  }

  function renderGoal(goal) {
    goalEl.replaceChildren();
    if (
      !goal ||
      typeof goal.objective !== "string" ||
      typeof goal.percentComplete !== "number" ||
      typeof goal.status !== "string"
    ) {
      goalEl.hidden = true;
      return;
    }
    goalEl.hidden = false;
    const percent = Math.min(100, Math.max(0, Math.round(goal.percentComplete)));
    const head = document.createElement("div");
    head.className = "goal-head";
    const name = document.createElement("span");
    name.className = "goal-name";
    name.textContent = `🎯 ${goal.objective}`;
    const pct = document.createElement("span");
    pct.className = "goal-percent";
    pct.textContent = `${percent}% · ${goal.status}`;
    head.appendChild(name);
    head.appendChild(pct);
    const bar = document.createElement("div");
    bar.className = "goal-bar";
    const fill = document.createElement("div");
    fill.className = "goal-fill";
    fill.style.width = `${percent}%`;
    bar.appendChild(fill);
    goalEl.appendChild(head);
    goalEl.appendChild(bar);
    const flow = [goal.currentWork, goal.nextWork].filter(
      (part) => typeof part === "string" && part.trim() !== "",
    );
    if (flow.length > 0) {
      const sub = document.createElement("div");
      sub.className = "goal-sub";
      sub.textContent = flow.join(" · ");
      goalEl.appendChild(sub);
    }
    const row = document.createElement("div");
    row.className = "goal-buttons";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn small";
    const paused = goal.status === "paused";
    toggle.textContent = paused ? "Resume" : "Pause";
    toggle.addEventListener("click", () => {
      vscode.postMessage({ type: "goalAction", action: paused ? "resume" : "pause" });
    });
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "btn small";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      vscode.postMessage({ type: "goalAction", action: "clear" });
    });
    row.appendChild(toggle);
    row.appendChild(clear);
    goalEl.appendChild(row);
  }

  function updateEffort(level) {
    const labels = { quick: "Quick", normal: "Normal", deep: "Deep" };
    const label = labels[level] || "Normal";
    effortButton.textContent = `⚡ ${label}`;
    effortButton.title = `Thinking effort: ${label} — click to change`;
  }

  function closeSlashMenu() {
    slashOpen = false;
    slashMenuEl.hidden = true;
  }

  function slashMatches(query) {
    return slashList.filter((def) => def.name.startsWith(query));
  }

  function updateSlashMenu() {
    const value = input.value;
    if (!value.startsWith("/") || value.includes("\n")) {
      closeSlashMenu();
      return;
    }
    const query = value.slice(1).trim().toLowerCase();
    if (query !== slashQuery) {
      slashQuery = query;
      slashIndex = 0;
    }
    const matches = slashMatches(query);
    if (matches.length === 0) {
      closeSlashMenu();
      return;
    }
    slashOpen = true;
    slashIndex = Math.min(slashIndex, matches.length - 1);
    slashMenuEl.replaceChildren();
    matches.forEach((def, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "slash-item" + (index === slashIndex ? " selected" : "");
      const name = document.createElement("span");
      name.className = "slash-name";
      name.textContent = `/${def.name}`;
      const desc = document.createElement("span");
      desc.className = "slash-desc";
      desc.textContent = def.description;
      item.appendChild(name);
      item.appendChild(desc);
      item.addEventListener("click", () => completeSlash(def.name));
      slashMenuEl.appendChild(item);
    });
    slashMenuEl.hidden = false;
  }

  function completeSlash(name) {
    input.value = `/${name} `;
    closeSlashMenu();
    input.focus();
  }

  function upsertThinking(id, text) {
    hideEmptyState();
    let entry = thinkingEls.get(id);
    if (!entry) {
      const details = document.createElement("details");
      details.className = "thinking";
      const summary = document.createElement("summary");
      summary.textContent = "Thought";
      const body = document.createElement("div");
      body.className = "thinking-text";
      details.appendChild(summary);
      details.appendChild(body);
      stepParent().appendChild(details);
      entry = { el: details, started: Date.now() };
      thinkingEls.set(id, entry);
    }
    entry.el.querySelector(".thinking-text").textContent = text;
    const elapsed = Math.floor((Date.now() - entry.started) / 1000);
    entry.el.querySelector("summary").textContent = elapsed >= 1 ? `Thought for ${elapsed}s` : "Thought";
    scrollToBottom();
  }

  function upsertTool(id, text, done) {
    hideEmptyState();
    let row = toolEls.get(id);
    if (!row) {
      row = document.createElement("div");
      row.className = "tool";
      stepParent().appendChild(row);
      toolEls.set(id, row);
    }
    row.textContent = text;
    row.classList.toggle("done", Boolean(done));
    scrollToBottom();
  }

  // One picker at a time over the message box; the rest wait their turn.
  function onPicker(message) {
    hideEmptyState();
    pickerQueue.push(message);
    renderPicker();
  }

  function dropPicker(id) {
    const index = pickerQueue.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return;
    }
    pickerQueue.splice(index, 1);
    renderPicker();
  }

  function renderPicker() {
    document.getElementById("picker")?.remove();
    updateComposer();
    const message = pickerQueue[0];
    if (!message) {
      pickerShown = null;
      return;
    }
    pickerShown = message.id;
    pickerSelected = 0;
    const wrap = document.getElementById("composer-wrap");
    const panel = document.createElement("div");
    panel.id = "picker";
    panel.tabIndex = 0;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", message.title);

    const head = document.createElement("div");
    head.className = "picker-head";
    const title = document.createElement("p");
    title.className = "picker-title";
    title.textContent = message.title;
    head.appendChild(title);
    if (pickerQueue.length > 1) {
      const count = document.createElement("span");
      count.className = "picker-count";
      count.textContent = `1 of ${pickerQueue.length}`;
      head.appendChild(count);
    }
    panel.appendChild(head);

    if (Array.isArray(message.stages) && message.stages.length > 0) {
      const stages = document.createElement("ol");
      stages.className = "picker-stages";
      for (const line of message.stages) {
        const item = document.createElement("li");
        item.textContent = line;
        stages.appendChild(item);
      }
      panel.appendChild(stages);
    }

    const list = document.createElement("ol");
    list.className = "picker-choices";
    const rows = [];
    message.choices.forEach((choice, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "picker-choice";
      const number = document.createElement("span");
      number.className = "picker-number";
      number.textContent = String(index + 1);
      button.appendChild(number);
      const label = document.createElement("span");
      label.textContent = choice.isReject ? "No, tell Muse what to do instead…" : choice.label;
      button.appendChild(label);
      if (typeof choice.hint === "string" && choice.hint) {
        button.title = choice.hint;
      }
      button.addEventListener("click", () => activatePickerChoice(index));
      item.appendChild(button);
      list.appendChild(item);
      rows.push(button);
    });
    panel.appendChild(list);

    const why = document.createElement("input");
    why.type = "text";
    why.className = "picker-why";
    why.placeholder = "Tell Muse what to do instead… (empty = just don't)";
    why.setAttribute("aria-label", "Tell Muse what to do instead");
    why.hidden = true;
    panel.appendChild(why);

    if (typeof message.detail === "string" && message.detail) {
      if (Array.isArray(message.stages) && message.stages.length > 0) {
        const full = document.createElement("details");
        full.className = "picker-full";
        const summary = document.createElement("summary");
        summary.textContent = "Full command";
        full.appendChild(summary);
        const pre = document.createElement("pre");
        pre.textContent = message.detail;
        full.appendChild(pre);
        panel.appendChild(full);
      } else {
        const detail = document.createElement("pre");
        detail.className = "picker-detail";
        detail.textContent = message.detail;
        panel.appendChild(detail);
      }
    }

    panel.addEventListener("keydown", (event) => {
      if (event.target === why) {
        if (event.key === "Enter") {
          event.preventDefault();
          answerPicker(pickerRejectId(), why.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          answerPicker(pickerRejectId(), undefined);
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        movePickerSelection(1, rows);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        movePickerSelection(-1, rows);
      } else if (event.key === "Enter") {
        event.preventDefault();
        activatePickerChoice(pickerSelected);
      } else if (event.key === "Escape") {
        event.preventDefault();
        answerPicker(pickerRejectId(), undefined);
      } else if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        activatePickerChoice(Number(event.key) - 1);
      }
    });

    wrap.appendChild(panel);
    paintPickerSelection(rows);
    panel.focus({ preventScroll: true });
  }

  function movePickerSelection(step, rows) {
    if (rows.length === 0) {
      return;
    }
    pickerSelected = (pickerSelected + step + rows.length) % rows.length;
    paintPickerSelection(rows);
  }

  function paintPickerSelection(rows) {
    rows.forEach((button, index) => {
      button.classList.toggle("selected", index === pickerSelected);
    });
  }

  function activatePickerChoice(index) {
    const message = pickerQueue[0];
    const choice = message?.choices[index];
    if (!message || !choice) {
      return;
    }
    if (choice.isReject) {
      const why = document.querySelector("#picker .picker-why");
      if (why) {
        why.hidden = false;
        why.focus();
      }
      return;
    }
    answerPicker(choice.id, undefined);
  }

  // Esc always means plain reject; without a reject choice there is nothing
  // to do (in practice the server always offers one).
  function pickerRejectId() {
    const message = pickerQueue[0];
    return message?.choices.find((choice) => choice.isReject)?.id;
  }

  function answerPicker(choiceId, feedback) {
    const message = pickerQueue[0];
    if (!message || typeof choiceId !== "string") {
      return;
    }
    const answer = { type: "approve", id: message.id, choiceId };
    if (typeof feedback === "string" && feedback.trim() !== "") {
      answer.feedback = feedback;
    }
    vscode.postMessage(answer);
    dropPicker(message.id);
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
    stepParent().appendChild(card);
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
      stepParent().appendChild(wrap);
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
    stepParent().appendChild(card);
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
    stepParent().appendChild(notice);
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
    closeTurn();
    lastStampAt = 0;
    messagesEl.replaceChildren();
    assistantEls.clear();
    thinkingEls.clear();
    toolEls.clear();
    pickerQueue.length = 0;
    renderPicker();
    undoEls.clear();
    nudgeEls.clear();
    cardEls.clear();
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

  headerGoalButton.addEventListener("click", () => {
    vscode.postMessage({ type: "goalAsk" });
  });

  headerSideButton.addEventListener("click", () => {
    vscode.postMessage({ type: "sideBox" });
  });

  headerForkButton.addEventListener("click", () => {
    vscode.postMessage({ type: "forkNow" });
  });

  headerUsageButton.addEventListener("click", () => {
    vscode.postMessage({ type: "usageNow" });
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

  plusButton.addEventListener("click", () => {
    input.value = "/";
    input.focus();
    updateSlashMenu();
  });

  effortButton.addEventListener("click", () => {
    vscode.postMessage({ type: "effortCycle" });
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
    closeSlashMenu();
    vscode.postMessage({ type: "send", text });
  });

  input.addEventListener("input", () => {
    updateSlashMenu();
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
    if (slashOpen && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === "Escape")) {
      const matches = slashMatches(slashQuery);
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlashMenu();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        slashIndex = (slashIndex + 1) % matches.length;
        updateSlashMenu();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        slashIndex = (slashIndex + matches.length - 1) % matches.length;
        updateSlashMenu();
        return;
      }
      const match = matches[slashIndex];
      if (match) {
        event.preventDefault();
        completeSlash(match.name);
        return;
      }
    }
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
          addUserMessage(message.text, message.time);
        }
        break;
      case "assistant":
        if (typeof message.id === "string" && typeof message.text === "string") {
          upsertAssistant(message.id, message.text, message.time);
        }
        break;
      case "day":
        if (typeof message.label === "string") {
          addDayDivider(message.label);
        }
        break;
      case "nudgeAnswered":
        if (
          typeof message.id === "string" &&
          (message.answer === "show" || message.answer === "notnow")
        ) {
          disableNudge(message.id, message.answer);
        }
        break;
      case "card":
        if (
          typeof message.id === "string" &&
          typeof message.title === "string" &&
          typeof message.body === "string"
        ) {
          renderCard(message);
        }
        break;
      case "cardDone":
        if (typeof message.id === "string") {
          disableCard(message.id);
        }
        break;
      case "goal":
        renderGoal(message.goal);
        break;
      case "effort":
        if (typeof message.level === "string") {
          updateEffort(message.level);
        }
        break;
      case "slashCommands":
        if (Array.isArray(message.commands)) {
          slashList = message.commands.filter(
            (def) => def && typeof def.name === "string" && typeof def.description === "string",
          );
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
      case "picker":
        if (typeof message.id === "string" && typeof message.title === "string" && Array.isArray(message.choices)) {
          onPicker(message);
        }
        break;
      case "approvalDone":
        if (typeof message.id === "string") {
          dropPicker(message.id);
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
          if (message.state === "started") {
            openTurn();
          } else {
            closeTurn();
          }
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
