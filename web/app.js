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

  refreshInputsUI();
  refreshProxyUI();
}

if (window.pywebview) {
  wire();
} else {
  window.addEventListener("pywebviewready", wire);
}
