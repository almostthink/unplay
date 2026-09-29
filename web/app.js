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

// --- Callbacks invoked from the Python backend via window.evaluate_js ---

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
    const paths = await window.pywebview.api.pick_input_files();
    if (paths && paths.length) {
      const set = new Set(state.inputs);
      paths.forEach((p) => set.add(p));
      state.inputs = Array.from(set);
      refreshInputsUI();
    }
  });

  el("pickProxyBtn").addEventListener("click", async () => {
    const path = await window.pywebview.api.pick_proxy_file();
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

    const res = await window.pywebview.api.start_check(config);
    if (!res || !res.ok) {
      window.onFatalError((res && res.error) || "Не удалось запустить проверку.");
    }
  });

  el("stopBtn").addEventListener("click", async () => {
    el("stopBtn").disabled = true;
    await window.pywebview.api.cancel_check();
    el("stopBtn").disabled = false;
  });

  el("openFolderBtn").addEventListener("click", async () => {
    if (state.outputDir) {
      await window.pywebview.api.open_folder(state.outputDir);
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

  el("loadMoreBtn").addEventListener("click", () => loadMessages(false));
  el("toggleUnreadBtn").addEventListener("click", () => toggleUnread());
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
  const runs = await window.pywebview.api.list_run_history();
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
  const res = await window.pywebview.api.load_run(runDir);
  if (!res || !res.ok) {
    el("accountList").innerHTML = "";
    return;
  }
  mail.emails = res.emails;
  const list = el("accountList");
  list.innerHTML = "";
  mail.emails.forEach((addr) => {
    const li = document.createElement("li");
    li.textContent = addr;
    li.addEventListener("click", () => openAccount(addr, li));
    list.appendChild(li);
  });
}

// --- Mail: account / folders --------------------------------------------

async function openAccount(addr, liEl) {
  document.querySelectorAll("#accountList li").forEach((n) => n.classList.remove("active"));
  if (liEl) liEl.classList.add("active");

  closeReader();
  el("folderPanel").hidden = true;
  el("messagePanel").hidden = true;
  setMailPlaceholder(true);

  const res = await window.pywebview.api.open_mailbox(addr);
  if (!res || !res.ok) {
    setMailPlaceholder(false);
    alert((res && res.error) || "Не удалось открыть почтовый ящик.");
    return;
  }
  mail.currentEmail = addr;
  mail.folders = res.folders;
  const list = el("folderList");
  list.innerHTML = "";
  mail.folders.forEach((f) => {
    const li = document.createElement("li");
    li.textContent = f.display;
    li.addEventListener("click", () => openFolder(f.raw, li));
    list.appendChild(li);
  });
  el("folderPanel").hidden = false;

  const inbox = mail.folders.find((f) => f.display.toUpperCase() === "INBOX") || mail.folders[0];
  if (inbox) {
    const li = Array.from(list.children)[mail.folders.indexOf(inbox)];
    await openFolder(inbox.raw, li);
  } else {
    setMailPlaceholder(false);
  }
}

async function openFolder(folderRaw, liEl) {
  document.querySelectorAll("#folderList li").forEach((n) => n.classList.remove("active"));
  if (liEl) liEl.classList.add("active");

  closeReader();
  const res = await window.pywebview.api.select_folder(mail.currentEmail, folderRaw);
  if (!res || !res.ok) {
    alert((res && res.error) || "Не удалось открыть папку.");
    return;
  }
  mail.currentFolder = folderRaw;
  mail.offset = 0;
  mail.messages = [];
  el("messagePanelTitle").textContent = `Письма (${res.count})`;
  el("messagePanel").hidden = false;
  setMailPlaceholder(false);
  await loadMessages(true);
}

async function loadMessages(reset) {
  if (reset) {
    mail.offset = 0;
    mail.messages = [];
    el("messageList").innerHTML = "";
  }
  const res = await window.pywebview.api.list_messages(mail.currentEmail, mail.offset, mail.pageSize);
  if (!res || !res.ok) {
    alert((res && res.error) || "Не удалось загрузить письма.");
    return;
  }
  mail.total = res.total;
  mail.offset += res.messages.length;
  const list = el("messageList");
  res.messages.forEach((m) => {
    mail.messages.push(m);
    const li = document.createElement("li");
    li.className = m.unread ? "unread" : "";
    li.dataset.uid = m.uid;
    li.innerHTML = `
      <div class="msg-subject">${escapeHtml(m.subject)}</div>
      <div class="msg-from">${escapeHtml(m.from)}</div>
      <div class="msg-date">${escapeHtml(m.date)}</div>
    `;
    li.addEventListener("click", () => openMessage(m.uid, li));
    list.appendChild(li);
  });
  el("loadMoreBtn").hidden = mail.offset >= mail.total;
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
  const res = await window.pywebview.api.get_message(mail.currentEmail, uid);
  if (!res || !res.ok) {
    alert((res && res.error) || "Не удалось открыть письмо.");
    return;
  }
  mail.currentUid = uid;
  const m = res.message;
  el("readerSubject").textContent = m.subject;
  el("readerMeta").textContent = `От: ${m.from}  •  Кому: ${m.to}  •  ${m.date}`;
  el("readerBody").textContent = m.body;

  const attList = el("readerAttachments");
  attList.innerHTML = "";
  (m.attachments || []).forEach((a) => {
    const li = document.createElement("li");
    const sizeKb = Math.max(1, Math.round(a.size / 1024));
    li.innerHTML = `<span class="att-name">📎 ${escapeHtml(a.filename)}</span><span class="att-size">${sizeKb} КБ</span>`;
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = "Скачать";
    btn.addEventListener("click", async () => {
      const r = await window.pywebview.api.download_attachment(mail.currentEmail, uid, a.index, a.filename);
      if (r && !r.ok && r.error) alert(r.error);
    });
    li.appendChild(btn);
    attList.appendChild(li);
  });

  el("readerPanel").hidden = false;
}

async function toggleUnread() {
  if (!mail.currentUid) return;
  await window.pywebview.api.set_message_seen(mail.currentEmail, mail.currentUid, false);
  const li = document.querySelector(`#messageList li[data-uid="${mail.currentUid}"]`);
  if (li) li.classList.add("unread");
  closeReader();
}

async function deleteCurrentMessage() {
  if (!mail.currentUid) return;
  if (!confirm("Удалить это письмо?")) return;
  const res = await window.pywebview.api.delete_message(mail.currentEmail, mail.currentUid);
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

if (window.pywebview) {
  wire();
} else {
  window.addEventListener("pywebviewready", wire);
}
