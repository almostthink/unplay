"use strict";

const state = {
  inputs: [],
  proxyFile: null,
  running: false,
  total: 0,
  done: 0,
  counters: { success: 0, invalid: 0, error: 0 },
  outputDir: "",
};

const el = (id) => document.getElementById(id);

// --- Small inline icon set (stroke-style, 24x24 viewBox) + avatar/folder helpers ---

const ICONS = {
  inbox: '<rect x="3" y="8" width="18" height="12" rx="2"></rect><polyline points="3,8 9,8 11,11 13,11 15,8 21,8"></polyline>',
  sent: '<polygon points="3,11 21,3 13,21 11,13 3,11"></polygon>',
  drafts: '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"></path>',
  trash: '<path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="M6 7l1 13h10l1-13"></path>',
  spam: '<polygon points="12,3 22,20 2,20"></polygon><line x1="12" y1="9" x2="12" y2="14"></line><circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none"></circle>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>',
  file: '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"></path><polyline points="15,2 15,7 20,7"></polyline>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle>',
  eyeOff: '<path d="M3 3l18 18"></path><path d="M10.6 5.1A11 11 0 0 1 23 12s-1.6 2.8-4.4 4.9"></path><path d="M6.6 6.6C3.7 8.4 1 12 1 12s4 7 11 7a10.4 10.4 0 0 0 4.2-.9"></path><path d="M9.5 9.5a3 3 0 0 0 4.2 4.2"></path>',
  download: '<path d="M12 3v12"></path><polyline points="7,10 12,15 17,10"></polyline><path d="M4 19h16"></path>',
};

function svgIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.folder}</svg>`;
}

function avatarInfo(seed) {
  const s = (seed || "?").trim();
  const m = s.match(/[A-Za-zА-Яа-яЁё0-9]/);
  const letter = m ? m[0].toUpperCase() : "?";
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return { letter, bg: `hsl(${hash % 360} 58% 42%)` };
}

function parseFrom(raw) {
  const s = (raw || "").trim();
  const m = s.match(/^"?([^"<]*?)"?\s*<([^<>]+)>$/);
  if (m) {
    const name = m[1].trim();
    return { name: name || m[2], email: m[2] };
  }
  return { name: s, email: s };
}

function folderIconName(display) {
  const low = (display || "").toLowerCase();
  if (low === "inbox" || low.includes("входящ")) return "inbox";
  if (low.includes("sent") || low.includes("отправ")) return "sent";
  if (low.includes("draft") || low.includes("черновик")) return "drafts";
  if (low.includes("trash") || low.includes("bin") || low.includes("корзин") || low.includes("удал")) return "trash";
  if (low.includes("spam") || low.includes("junk") || low.includes("спам") || low.includes("нежелат")) return "spam";
  return "folder";
}

function renderSkeleton(container, rows, widths) {
  container.innerHTML = "";
  for (let i = 0; i < rows; i++) {
    const li = document.createElement("li");
    li.className = "skeleton-row";
    const w = widths ? widths[i % widths.length] : 70;
    li.innerHTML =
      '<span class="skeleton-bar" style="width:24px;height:24px;border-radius:50%;flex-shrink:0;"></span>' +
      `<span class="skeleton-bar" style="flex:1;width:${w}%;"></span>`;
    container.appendChild(li);
  }
}

function rowActionBtn(iconName, title, onClick, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `icon-btn ${extraClass || ""}`.trim();
  btn.title = title;
  btn.innerHTML = svgIcon(iconName);
  btn.addEventListener("click", onClick);
  return btn;
}

// --- Bridge to the local backend (fetch for calls, WebSocket for live events) ---

async function callApi(name, payload) {
  const res = await fetch(`/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload === undefined ? {} : payload),
  });
  return res.json();
}

async function getApi(name) {
  const res = await fetch(`/api/${name}`);
  return res.json();
}

function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const handler = window[msg.type];
    if (typeof handler === "function") handler(msg.data);
  };
  ws.onclose = () => {
    setTimeout(connectWebSocket, 1000);
  };
}

function refreshInputsUI() {
  const list = el("inputsList");
  list.innerHTML = "";
  state.inputs.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p;
    list.appendChild(li);
  });
  el("inputsCount").textContent =
    state.inputs.length === 0 ? "файлы не выбраны" : `выбрано файлов: ${state.inputs.length}`;
  el("startBtn").disabled = state.inputs.length === 0 || state.running;
}

function refreshProxyUI() {
  el("proxyFileLabel").textContent = state.proxyFile
    ? state.proxyFile
    : "не выбран — прямое подключение";
  el("clearProxyBtn").hidden = !state.proxyFile;
}

function setStatus(kind, text) {
  const pill = el("statusPill");
  pill.className = `pill pill-${kind}`;
  pill.textContent = text;
}

function appendLog(text, cls) {
  const log = el("log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  const div = document.createElement("div");
  div.className = `line ${cls || ""}`;
  div.textContent = text;
  log.appendChild(div);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function resetRunUI() {
  state.done = 0;
  state.total = 0;
  state.counters = { success: 0, invalid: 0, error: 0 };
  el("progressFill").style.width = "0%";
  el("progressLabel").textContent = "0 / 0";
  el("statSuccess").textContent = "0";
  el("statInvalid").textContent = "0";
  el("statError").textContent = "0";
  el("log").innerHTML = "";
  el("outputDirLabel").textContent = "";
  el("doneActions").hidden = true;
}

function updateProgress() {
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  el("progressFill").style.width = `${pct}%`;
  el("progressLabel").textContent = `${state.done} / ${state.total}`;
  el("statSuccess").textContent = state.counters.success;
  el("statInvalid").textContent = state.counters.invalid;
  el("statError").textContent = state.counters.error;
}

// --- Callbacks invoked from the Python backend over the WebSocket ---

window.onStart = function (data) {
  state.total = data.total;
  state.outputDir = data.outputDir;
  el("outputDirLabel").textContent = data.outputDir;
  setStatus("running", "Идёт проверка…");
  appendLog(`Загружено аккаунтов: ${data.total}. Протокол: ${data.protocol}. Потоки: ${data.threads}.`, "line-meta");
  appendLog(data.proxyCount ? `Прокси: ${data.proxyCount} (round-robin)` : "Прокси: не используются (прямое подключение)", "line-meta");
  updateProgress();
};

window.onResult = function (data) {
  state.done += 1;
  state.counters[data.bucket] = (state.counters[data.bucket] || 0) + 1;
  updateProgress();
  const cls = data.bucket === "success" ? "line-success" : data.bucket === "invalid" ? "line-invalid" : "line-error";
  const suffix = data.bucket === "success" ? "" : ` — ${data.reason}`;
  appendLog(`[${data.bucket}] ${data.email}${suffix}`, cls);
};

window.onDone = function (data) {
  state.running = false;
  setStatus("done", "Готово");
  appendLog(
    `Завершено. success=${data.success} invalid=${data.invalid} error=${data.error}`,
    "line-meta"
  );
  el("startBtn").disabled = state.inputs.length === 0;
  el("startBtn").hidden = false;
  el("stopBtn").hidden = true;
  el("doneActions").hidden = false;
};

window.onCancelled = function () {
  state.running = false;
  setStatus("idle", "Остановлено");
  appendLog("Проверка остановлена пользователем.", "line-meta");
  el("startBtn").disabled = state.inputs.length === 0;
  el("startBtn").hidden = false;
  el("stopBtn").hidden = true;
  el("doneActions").hidden = false;
};

window.onFatalError = function (message) {
  state.running = false;
  setStatus("error", "Ошибка");
  appendLog(`Ошибка: ${message}`, "line-error");
  el("startBtn").disabled = state.inputs.length === 0;
  el("startBtn").hidden = false;
  el("stopBtn").hidden = true;
};

// --- Wiring ---

function wire() {
  el("pickInputsBtn").addEventListener("click", async () => {
    const paths = await callApi("pick_input_files");
    if (paths && paths.length) {
      const set = new Set(state.inputs);
      paths.forEach((p) => set.add(p));
      state.inputs = Array.from(set);
      refreshInputsUI();
    }
  });

  el("pickProxyBtn").addEventListener("click", async () => {
    const path = await callApi("pick_proxy_file");
    if (path) {
      state.proxyFile = path;
      refreshProxyUI();
    }
  });

  el("clearProxyBtn").addEventListener("click", () => {
    state.proxyFile = null;
    refreshProxyUI();
  });

  el("startBtn").addEventListener("click", async () => {
    if (state.inputs.length === 0 || state.running) return;
    resetRunUI();
    state.running = true;
    el("startBtn").hidden = true;
    el("stopBtn").hidden = false;
    setStatus("running", "Запуск…");

    const config = {
      inputs: state.inputs,
      protocol: el("protocol").value,
      threads: parseInt(el("threads").value, 10) || 20,
      timeout: parseInt(el("timeout").value, 10) || 20,
      proxy_retries: parseInt(el("proxyRetries").value, 10) || 2,
      proxy_file: state.proxyFile,
    };

    const res = await callApi("start_check", config);
    if (!res || !res.ok) {
      window.onFatalError((res && res.error) || "Не удалось запустить проверку.");
    }
  });

  el("stopBtn").addEventListener("click", async () => {
    el("stopBtn").disabled = true;
    await callApi("cancel_check");
    el("stopBtn").disabled = false;
  });

  el("openFolderBtn").addEventListener("click", async () => {
    if (state.outputDir) {
      await callApi("open_folder", { path: state.outputDir });
    }
  });

  el("tabCheckBtn").addEventListener("click", () => switchTab("check"));
  el("tabMailBtn").addEventListener("click", () => switchTab("mail"));

  el("runSelect").addEventListener("change", () => loadSelectedRun());
  el("refreshRunsBtn").addEventListener("click", () => loadHistory());

  el("openInMailBtn").addEventListener("click", async () => {
    switchTab("mail");
    await loadHistory(state.outputDir);
  });

  el("toggleUnreadBtn").innerHTML = svgIcon("eyeOff");
  el("spamMsgBtn").innerHTML = svgIcon("spam");
  el("deleteMsgBtn").innerHTML = svgIcon("trash");

  el("loadMoreBtn").addEventListener("click", () => loadMessages(false));
  el("toggleUnreadBtn").addEventListener("click", () => toggleUnread());
  el("spamMsgBtn").addEventListener("click", () => spamCurrentMessage());
  el("deleteMsgBtn").addEventListener("click", () => deleteCurrentMessage());

  refreshInputsUI();
  refreshProxyUI();
  loadHistory();
}

// --- Tabs -------------------------------------------------------------

function switchTab(name) {
  const isMail = name === "mail";
  el("tabCheckBtn").classList.toggle("tab-active", !isMail);
  el("tabMailBtn").classList.toggle("tab-active", isMail);
  el("checkView").hidden = isMail;
  el("mailView").hidden = !isMail;
}

// --- Mail: run history & accounts --------------------------------------

const mail = {
  runs: [],
  currentRunDir: null,
  emails: [],
  currentEmail: null,
  folders: [],
  currentFolder: null,
  messages: [],
  currentUid: null,
  offset: 0,
  pageSize: 30,
  total: 0,
};

function setMailPlaceholder(show) {
  el("mailView").classList.toggle("show-placeholder", show);
}

async function loadHistory(preferRunDir) {
  const runs = await getApi("list_run_history");
  mail.runs = runs || [];
  const select = el("runSelect");
  select.innerHTML = "";
  if (mail.runs.length === 0) {
    el("runHint").hidden = false;
    el("accountList").innerHTML = "";
    return;
  }
  el("runHint").hidden = true;
  mail.runs.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.runDir;
    opt.textContent = `${r.label} (успешных: ${r.successCount})`;
    select.appendChild(opt);
  });
  const toSelect = preferRunDir && mail.runs.some((r) => r.runDir === preferRunDir)
    ? preferRunDir
    : mail.runs[0].runDir;
  select.value = toSelect;
  await loadSelectedRun();
}

async function loadSelectedRun() {
  const runDir = el("runSelect").value;
  if (!runDir) return;
  mail.currentRunDir = runDir;
  renderSkeleton(el("accountList"), 4, [85, 70, 90, 65]);
  const res = await callApi("load_run", { run_dir: runDir });
  if (!res || !res.ok) {
    el("accountList").innerHTML = "";
    return;
  }
  mail.emails = res.emails;
  const list = el("accountList");
  list.innerHTML = "";
  mail.emails.forEach((addr) => {
    const li = document.createElement("li");
    const av = avatarInfo(addr);
    const avatarSpan = document.createElement("span");
    avatarSpan.className = "avatar";
    avatarSpan.style.background = av.bg;
    avatarSpan.textContent = av.letter;
    const label = document.createElement("span");
    label.textContent = addr;
    li.append(avatarSpan, label);
    li.addEventListener("click", () => openAccount(addr, li));
    list.appendChild(li);
  });
}

// --- Mail: account / folders --------------------------------------------

async function openAccount(addr, liEl) {
  document.querySelectorAll("#accountList li").forEach((n) => n.classList.remove("active"));
  if (liEl) liEl.classList.add("active");

  closeReader();
  el("messagePanel").hidden = true;
  el("folderPanel").hidden = false;
  renderSkeleton(el("folderList"), 5, [55, 70, 45, 65, 50]);
  setMailPlaceholder(true);

  const res = await callApi("open_mailbox", { email: addr });
  if (!res || !res.ok) {
    setMailPlaceholder(false);
    el("folderPanel").hidden = true;
    alert((res && res.error) || "Не удалось открыть почтовый ящик.");
    return;
  }
  mail.currentEmail = addr;
  mail.folders = res.folders;

  const list = el("folderList");
  list.innerHTML = "";
  mail.folders.forEach((f) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="icon-tile">${svgIcon(folderIconName(f.display))}</span><span>${escapeHtml(f.display)}</span>`;
    li.addEventListener("click", () => openFolder(f.raw, li));
    list.appendChild(li);
  });

  const inbox = mail.folders.find((f) => f.display.toUpperCase() === "INBOX") || mail.folders[0];
  if (inbox) {
    const li = list.children[mail.folders.indexOf(inbox)];
    await openFolder(inbox.raw, li);
  } else {
    setMailPlaceholder(false);
  }
}

async function openFolder(folderRaw, liEl) {
  document.querySelectorAll("#folderList li").forEach((n) => n.classList.remove("active"));
  if (liEl) liEl.classList.add("active");

  closeReader();
  el("messagePanel").hidden = false;
  el("messagePanelTitle").textContent = "Письма";
  setMailPlaceholder(false);
  renderSkeleton(el("messageList"), 8, [80, 60, 90, 55, 75, 65, 85, 50]);

  const res = await callApi("select_folder", { email: mail.currentEmail, folder_raw: folderRaw });
  if (!res || !res.ok) {
    el("messageList").innerHTML = "";
    alert((res && res.error) || "Не удалось открыть папку.");
    return;
  }
  mail.currentFolder = folderRaw;
  mail.offset = 0;
  mail.messages = [];
  el("messagePanelTitle").textContent = `Письма (${res.count})`;
  await loadMessages(true);
}

async function loadMessages(reset) {
  if (reset) {
    mail.offset = 0;
    mail.messages = [];
  } else {
    el("loadMoreBtn").textContent = "Загрузка…";
    el("loadMoreBtn").disabled = true;
  }

  const res = await callApi("list_messages", {
    email: mail.currentEmail,
    offset: mail.offset,
    limit: mail.pageSize,
  });

  const list = el("messageList");
  el("loadMoreBtn").textContent = "Загрузить ещё";
  el("loadMoreBtn").disabled = false;

  if (!res || !res.ok) {
    if (reset) list.innerHTML = "";
    alert((res && res.error) || "Не удалось загрузить письма.");
    return;
  }

  if (reset) list.innerHTML = "";
  mail.total = res.total;
  mail.offset += res.messages.length;

  if (mail.total === 0) {
    list.innerHTML = '<li class="hint" style="padding:10px 8px;cursor:default;">Писем нет.</li>';
  }
  res.messages.forEach((m) => {
    mail.messages.push(m);
    list.appendChild(buildMessageRow(m));
  });
  el("loadMoreBtn").hidden = mail.offset >= mail.total;
}

function buildMessageRow(m) {
  const li = document.createElement("li");
  li.className = m.unread ? "unread" : "";
  li.dataset.uid = m.uid;

  const from = parseFrom(m.from);
  const av = avatarInfo(from.name || from.email);
  const avatarSpan = document.createElement("span");
  avatarSpan.className = "avatar";
  avatarSpan.style.background = av.bg;
  avatarSpan.textContent = av.letter;

  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = `
    <div class="msg-top">
      <span class="msg-from">${escapeHtml(from.name || from.email)}</span>
      <span class="msg-date">${escapeHtml(m.date)}</span>
    </div>
    <div class="msg-subject">${escapeHtml(m.subject)}</div>
  `;

  const actions = document.createElement("div");
  actions.className = "msg-row-actions";

  const eyeBtn = rowActionBtn(
    m.unread ? "eyeOff" : "eye",
    m.unread ? "Пометить прочитанным" : "Пометить непрочитанным",
    async (ev) => {
      ev.stopPropagation();
      const nextUnread = !m.unread;
      await callApi("set_message_seen", { email: mail.currentEmail, uid: m.uid, seen: !nextUnread });
      m.unread = nextUnread;
      li.className = m.unread ? "unread" : "";
      eyeBtn.innerHTML = svgIcon(m.unread ? "eyeOff" : "eye");
      eyeBtn.title = m.unread ? "Пометить прочитанным" : "Пометить непрочитанным";
    }
  );

  const spamBtn = rowActionBtn("spam", "В спам", async (ev) => {
    ev.stopPropagation();
    const r = await callApi("move_to_spam", { email: mail.currentEmail, uid: m.uid });
    if (!r || !r.ok) {
      alert((r && r.error) || "Не удалось переместить в спам.");
      return;
    }
    li.remove();
    if (mail.currentUid === m.uid) closeReader();
  }, "icon-btn-warn");

  const trashBtn = rowActionBtn("trash", "Удалить", async (ev) => {
    ev.stopPropagation();
    if (!confirm("Удалить это письмо?")) return;
    const r = await callApi("delete_message", { email: mail.currentEmail, uid: m.uid });
    if (!r || !r.ok) {
      alert((r && r.error) || "Не удалось удалить письмо.");
      return;
    }
    li.remove();
    if (mail.currentUid === m.uid) closeReader();
  }, "icon-btn-danger");

  actions.append(eyeBtn, spamBtn, trashBtn);
  li.append(avatarSpan, body, actions);
  li.addEventListener("click", () => openMessage(m.uid, li));
  return li;
}

// --- Mail: reading pane --------------------------------------------------

function closeReader() {
  mail.currentUid = null;
  el("readerPanel").hidden = true;
}

async function openMessage(uid, liEl) {
  document.querySelectorAll("#messageList li").forEach((n) => n.classList.remove("active"));
  if (liEl) {
    liEl.classList.add("active");
    liEl.classList.remove("unread");
  }
  const res = await callApi("get_message", { email: mail.currentEmail, uid });
  if (!res || !res.ok) {
    alert((res && res.error) || "Не удалось открыть письмо.");
    return;
  }
  mail.currentUid = uid;
  const m = res.message;
  const from = parseFrom(m.from);
  const av = avatarInfo(from.name || from.email);

  const avatarEl = el("readerAvatar");
  avatarEl.style.background = av.bg;
  avatarEl.textContent = av.letter;

  el("readerSubject").textContent = m.subject;
  const fromLabel = from.name && from.email && from.name !== from.email
    ? `${escapeHtml(from.name)} &lt;${escapeHtml(from.email)}&gt;`
    : escapeHtml(from.email || from.name);
  el("readerMeta").innerHTML = `${fromLabel}<br>Кому: ${escapeHtml(m.to)} · ${escapeHtml(m.date)}`;
  el("readerBody").textContent = m.body;

  const attList = el("readerAttachments");
  attList.innerHTML = "";
  (m.attachments || []).forEach((a) => {
    const li = document.createElement("li");
    const sizeKb = Math.max(1, Math.round(a.size / 1024));
    li.innerHTML = `
      <span class="icon-tile">${svgIcon("file")}</span>
      <span class="att-info"><span class="att-name">${escapeHtml(a.filename)}</span><span class="att-size">${sizeKb} КБ</span></span>
    `;
    const btn = document.createElement("button");
    btn.className = "icon-btn";
    btn.type = "button";
    btn.title = "Скачать";
    btn.innerHTML = svgIcon("download");
    btn.addEventListener("click", async () => {
      const r = await callApi("download_attachment", {
        email: mail.currentEmail,
        uid,
        part_index: a.index,
        filename: a.filename,
      });
      if (r && !r.ok && r.error) alert(r.error);
    });
    li.appendChild(btn);
    attList.appendChild(li);
  });

  el("readerPanel").hidden = false;
}

async function toggleUnread() {
  if (!mail.currentUid) return;
  await callApi("set_message_seen", { email: mail.currentEmail, uid: mail.currentUid, seen: false });
  const li = document.querySelector(`#messageList li[data-uid="${mail.currentUid}"]`);
  if (li) li.classList.add("unread");
  closeReader();
}

async function spamCurrentMessage() {
  if (!mail.currentUid) return;
  const res = await callApi("move_to_spam", { email: mail.currentEmail, uid: mail.currentUid });
  if (!res || !res.ok) {
    alert((res && res.error) || "Не удалось переместить в спам.");
    return;
  }
  const li = document.querySelector(`#messageList li[data-uid="${mail.currentUid}"]`);
  if (li) li.remove();
  closeReader();
}

async function deleteCurrentMessage() {
  if (!mail.currentUid) return;
  if (!confirm("Удалить это письмо?")) return;
  const res = await callApi("delete_message", { email: mail.currentEmail, uid: mail.currentUid });
  if (!res || !res.ok) {
    alert((res && res.error) || "Не удалось удалить письмо.");
    return;
  }
  const li = document.querySelector(`#messageList li[data-uid="${mail.currentUid}"]`);
  if (li) li.remove();
  closeReader();
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

connectWebSocket();
wire();
