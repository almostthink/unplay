#!/usr/bin/env python3
"""
Mail Access Checker - GUI
==========================

A local FastAPI/uvicorn server serving the HTML/CSS/JS front end in
web/, opened in the machine's own default browser - not an embedded
browser window. Same checking/proxy/mailbox logic as mail_checker.py
and mailbox_manager.py, just driven through a small local API instead
of a console.

Why this shape and not an embedded browser (pywebview/CEF/QtWebEngine):
an embedded engine either depends on a system component that isn't
always present (Microsoft Edge WebView2 - the earlier version of this
file hung at startup without it) or has to bundle its own Chromium
(adds 150-250 MB to the build for no real benefit). Opening the
system's already-installed browser needs neither: the exe stays small
(no browser engine inside it at all) and works on any machine with any
browser already on it. Listens on 127.0.0.1 only - never reachable from
outside this machine.

Run from source:
    pip install -r requirements.txt
    python gui.py

Build for Windows:
    pyinstaller --onefile --console --name mail_checker_gui \
        --add-data "web;web" gui.py

Console is kept (not --windowed) on purpose, same reasoning as the CLI
build: if startup fails, the address/error is visible instead of a
silently-vanishing window.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request
from starlette.responses import JSONResponse

import mail_checker as core
from mailbox_manager import MailboxManager

PORT_SCAN_ATTEMPTS = 20
PREFERRED_PORT = 8765


def resource_path(rel_path: str) -> str:
    """Resolve a bundled resource path, whether running from source or as a
    PyInstaller-frozen --onefile executable (which unpacks data files into
    a temp dir named in sys._MEIPASS)."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel_path)


def base_dir() -> str:
    """Directory the exe (or script) lives in - used as the default place
    to write the results/ folder, so output lands next to the program
    rather than in some hidden working directory."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def find_free_port(host: str, preferred: int) -> int:
    """Look for a free port starting at `preferred`. Running a second copy
    of the exe shouldn't fail with 'address already in use' - it just
    takes the next port over."""
    for offset in range(PORT_SCAN_ATTEMPTS):
        candidate = preferred + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, candidate))
            except OSError:
                continue
            return candidate
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return sock.getsockname()[1]


# --- native file/save dialogs (tkinter - stdlib, no extra weight) ----------
# All dialog calls are funneled through a single-worker thread so every
# tkinter Tk() instance is created on the same OS thread across calls;
# tkinter isn't meant to be touched from arbitrary/concurrent threads.
_dialog_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="dialogs")


def _tk_root():
    import tkinter as tk
    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass
    return root


def _pick_open_files_sync():
    from tkinter import filedialog
    root = _tk_root()
    try:
        paths = filedialog.askopenfilenames(
            title="Выберите файлы с аккаунтами",
            filetypes=[("Text files", "*.txt"), ("All files", "*.*")],
        )
    finally:
        root.destroy()
    return list(paths) if paths else []


def _pick_open_file_sync():
    from tkinter import filedialog
    root = _tk_root()
    try:
        path = filedialog.askopenfilename(
            title="Выберите файл со списком прокси",
            filetypes=[("Text files", "*.txt"), ("All files", "*.*")],
        )
    finally:
        root.destroy()
    return path or None


def _pick_save_file_sync(default_name):
    from tkinter import filedialog
    root = _tk_root()
    try:
        path = filedialog.asksaveasfilename(initialfile=default_name or "attachment")
    finally:
        root.destroy()
    return path or None


async def pick_open_files():
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_dialog_executor, _pick_open_files_sync)


async def pick_open_file():
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_dialog_executor, _pick_open_file_sync)


async def pick_save_file(default_name):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_dialog_executor, _pick_save_file_sync, default_name)


class Bridge:
    """Holds check/mailbox state and pushes live events to the browser tab
    over a WebSocket - the same role gui.py's old pywebview Api class
    played, minus the pywebview-specific plumbing."""

    def __init__(self):
        self._running = False
        self._cancel_event = threading.Event()
        self._mailbox = MailboxManager()
        self._creds = {}   # email -> password, populated by load_run()
        self._ws_lock = threading.Lock()
        self._ws: WebSocket | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def set_loop(self, loop):
        self._loop = loop

    def set_ws(self, ws):
        with self._ws_lock:
            self._ws = ws

    def clear_ws(self, ws):
        with self._ws_lock:
            if self._ws is ws:
                self._ws = None

    def push(self, kind, data):
        """Thread-safe: called from worker threads, schedules the actual
        send on the asyncio event loop uvicorn runs on."""
        with self._ws_lock:
            ws = self._ws
        if ws is None or self._loop is None:
            return

        async def _send():
            with contextlib.suppress(Exception):
                await ws.send_text(json.dumps({"type": kind, "data": data}))

        with contextlib.suppress(Exception):
            asyncio.run_coroutine_threadsafe(_send(), self._loop)

    # --- run control ----------------------------------------------------

    def start_check(self, config):
        if self._running:
            return {"ok": False, "error": "Проверка уже выполняется."}

        inputs = config.get("inputs") or []
        if not inputs:
            return {"ok": False, "error": "Не выбраны входные файлы."}

        accounts = core.parse_accounts(inputs)
        if not accounts:
            return {"ok": False, "error": "В выбранных файлах не найдено ни одной строки email:pass."}

        proxy_file = config.get("proxy_file")
        proxies = []
        if proxy_file:
            try:
                proxies = core.load_proxies(proxy_file)
            except SystemExit:
                return {"ok": False, "error": "Не удалось загрузить список прокси (см. формат в подсказке)."}
            if not proxies:
                return {"ok": False, "error": "Файл с прокси указан, но ни одна строка не распозналась."}

        self._running = True
        self._cancel_event.clear()
        threading.Thread(
            target=self._run_check,
            args=(accounts, config, proxies),
            daemon=True,
        ).start()
        return {"ok": True}

    def cancel_check(self):
        self._cancel_event.set()
        return True

    def _run_check(self, accounts, config, proxies):
        import concurrent.futures as cf

        try:
            protocol = config.get("protocol") or "imap"
            threads = max(1, min(100, int(config.get("threads") or 20)))
            timeout = max(5, min(120, int(config.get("timeout") or 20)))
            proxy_retries = max(1, min(10, int(config.get("proxy_retries") or 2)))
            proxy_pool = core.ProxyPool(proxies)

            run_dir = Path(base_dir()) / "results" / datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            run_dir.mkdir(parents=True, exist_ok=True)
            files = {
                "success": (run_dir / "success.txt").open("a", encoding="utf-8"),
                "invalid": (run_dir / "invalid.txt").open("a", encoding="utf-8"),
                "error": (run_dir / "error.txt").open("a", encoding="utf-8"),
            }
            write_lock = threading.Lock()

            self.push("onStart", {
                "total": len(accounts),
                "protocol": protocol,
                "threads": threads,
                "proxyCount": len(proxy_pool),
                "outputDir": str(run_dir),
            })

            def worker(acc):
                return core.check_account(acc, protocol, timeout, proxy_pool, proxy_retries)

            cancelled = False
            with cf.ThreadPoolExecutor(max_workers=threads) as pool:
                futures = {pool.submit(worker, acc): acc for acc in accounts}
                for fut in cf.as_completed(futures):
                    if self._cancel_event.is_set():
                        cancelled = True
                        for f in futures:
                            f.cancel()
                        break
                    res = fut.result()
                    with write_lock:
                        fh = files[res.bucket]
                        if res.bucket == "success":
                            fh.write(f"{res.account.email}:{res.account.password}\n")
                        else:
                            fh.write(f"{res.account.email}:{res.account.password}:{res.reason}\n")
                        fh.flush()
                    self.push("onResult", {
                        "email": res.account.email,
                        "bucket": res.bucket,
                        "reason": res.reason,
                    })

            for fh in files.values():
                fh.close()

            if cancelled:
                self.push("onCancelled", {})
            else:
                counts = {}
                for bucket, fh_path in (("success", "success.txt"), ("invalid", "invalid.txt"), ("error", "error.txt")):
                    p = run_dir / fh_path
                    counts[bucket] = sum(1 for _ in p.open("r", encoding="utf-8")) if p.exists() else 0
                self.push("onDone", counts)
        except Exception as e:
            self.push("onFatalError", str(e))
        finally:
            self._running = False

    # --- run history / account list --------------------------------------

    def list_run_history(self):
        results_dir = Path(base_dir()) / "results"
        if not results_dir.is_dir():
            return []
        runs = []
        for d in sorted(results_dir.iterdir(), reverse=True):
            if not d.is_dir():
                continue
            success_file = d / "success.txt"
            if not success_file.is_file():
                continue
            try:
                count = sum(1 for _ in success_file.open("r", encoding="utf-8", errors="ignore"))
            except OSError:
                count = 0
            if count == 0:
                continue
            runs.append({"runDir": str(d), "label": d.name, "successCount": count})
        return runs[:30]

    def load_run(self, run_dir):
        p = Path(run_dir) / "success.txt"
        if not p.is_file():
            return {"ok": False, "error": "Файл success.txt не найден для этого запуска."}
        emails = []
        with p.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or ":" not in line:
                    continue
                addr, _, pw = line.partition(":")
                if addr:
                    self._creds[addr] = pw
                    emails.append(addr)
        return {"ok": True, "emails": emails}

    # --- mailbox viewer ---------------------------------------------------

    def _get_session(self, email_addr):
        session = self._mailbox.get(email_addr)
        if session is None:
            raise RuntimeError("Почтовый ящик не открыт. Откройте его заново.")
        return session

    def open_mailbox(self, email_addr):
        import imaplib
        password = self._creds.get(email_addr)
        if password is None:
            return {"ok": False, "error": "Нет сохранённого пароля для этого адреса. Загрузите запуск заново."}
        try:
            session = self._mailbox.open(email_addr, password)
            folders = [{"raw": f["raw"], "display": f["display"]} for f in session.folders]
            return {
                "ok": True,
                "folders": folders,
                "hasTrash": bool(session.trash_raw),
                "hasSpam": bool(session.spam_raw),
            }
        except imaplib.IMAP4.error as e:
            return {"ok": False, "error": f"Не удалось войти: {e}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def close_mailbox(self, email_addr):
        self._mailbox.close(email_addr)
        return True

    def select_folder(self, email_addr, folder_raw):
        try:
            session = self._get_session(email_addr)
            count = self._mailbox.select_folder(session, folder_raw)
            return {"ok": True, "count": count}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def list_messages(self, email_addr, offset, limit):
        try:
            session = self._get_session(email_addr)
            messages, total = self._mailbox.list_messages(session, int(offset), int(limit))
            return {"ok": True, "messages": messages, "total": total}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_message(self, email_addr, uid):
        try:
            session = self._get_session(email_addr)
            msg = self._mailbox.get_message(session, uid)
            self._mailbox.set_seen(session, uid, True)
            return {"ok": True, "message": msg}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def set_message_seen(self, email_addr, uid, seen):
        try:
            session = self._get_session(email_addr)
            self._mailbox.set_seen(session, uid, bool(seen))
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_message(self, email_addr, uid):
        try:
            session = self._get_session(email_addr)
            outcome = self._mailbox.delete_message(session, uid)
            return {"ok": True, "outcome": outcome}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def move_to_spam(self, email_addr, uid):
        try:
            session = self._get_session(email_addr)
            outcome = self._mailbox.move_to_spam(session, uid)
            return {"ok": True, "outcome": outcome}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_attachment_bytes(self, email_addr, uid, part_index):
        session = self._get_session(email_addr)
        return self._mailbox.get_attachment_bytes(session, uid, part_index)


def open_folder_in_explorer(path):
    if sys.platform.startswith("win"):
        os.startfile(path)  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


# --- FastAPI app -------------------------------------------------------

def create_app(bridge: Bridge) -> FastAPI:
    app = FastAPI(title="Mail Access Checker")

    async def _body(request: Request) -> dict:
        try:
            data = await request.json()
        except Exception:
            data = {}
        return data if isinstance(data, dict) else {}

    @app.post("/api/pick_input_files")
    async def api_pick_input_files():
        return await pick_open_files()

    @app.post("/api/pick_proxy_file")
    async def api_pick_proxy_file():
        return await pick_open_file()

    @app.post("/api/start_check")
    async def api_start_check(request: Request):
        return bridge.start_check(await _body(request))

    @app.post("/api/cancel_check")
    async def api_cancel_check():
        return bridge.cancel_check()

    @app.post("/api/open_folder")
    async def api_open_folder(request: Request):
        body = await _body(request)
        path = body.get("path")
        if not path:
            return JSONResponse({"ok": False, "error": "Нет пути."}, status_code=400)
        try:
            open_folder_in_explorer(path)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True}

    @app.get("/api/list_run_history")
    async def api_list_run_history():
        return bridge.list_run_history()

    @app.post("/api/load_run")
    async def api_load_run(request: Request):
        body = await _body(request)
        return bridge.load_run(body.get("run_dir"))

    @app.post("/api/open_mailbox")
    async def api_open_mailbox(request: Request):
        body = await _body(request)
        return bridge.open_mailbox(body.get("email"))

    @app.post("/api/close_mailbox")
    async def api_close_mailbox(request: Request):
        body = await _body(request)
        return bridge.close_mailbox(body.get("email"))

    @app.post("/api/select_folder")
    async def api_select_folder(request: Request):
        body = await _body(request)
        return bridge.select_folder(body.get("email"), body.get("folder_raw"))

    @app.post("/api/list_messages")
    async def api_list_messages(request: Request):
        body = await _body(request)
        return bridge.list_messages(body.get("email"), body.get("offset", 0), body.get("limit", 30))

    @app.post("/api/get_message")
    async def api_get_message(request: Request):
        body = await _body(request)
        return bridge.get_message(body.get("email"), body.get("uid"))

    @app.post("/api/set_message_seen")
    async def api_set_message_seen(request: Request):
        body = await _body(request)
        return bridge.set_message_seen(body.get("email"), body.get("uid"), body.get("seen", False))

    @app.post("/api/delete_message")
    async def api_delete_message(request: Request):
        body = await _body(request)
        return bridge.delete_message(body.get("email"), body.get("uid"))

    @app.post("/api/move_to_spam")
    async def api_move_to_spam(request: Request):
        body = await _body(request)
        return bridge.move_to_spam(body.get("email"), body.get("uid"))

    @app.post("/api/download_attachment")
    async def api_download_attachment(request: Request):
        body = await _body(request)
        email_addr = body.get("email")
        uid = body.get("uid")
        part_index = body.get("part_index")
        filename = body.get("filename")
        try:
            data = bridge.get_attachment_bytes(email_addr, uid, part_index)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        save_path = await pick_save_file(filename)
        if not save_path:
            return {"ok": False, "error": ""}  # user cancelled, not a real error
        try:
            with open(save_path, "wb") as f:
                f.write(data)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "path": save_path}

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket):
        await websocket.accept()
        bridge.set_ws(websocket)
        try:
            while True:
                await websocket.receive_text()  # client doesn't send anything; just keeps the connection open
        except WebSocketDisconnect:
            pass
        finally:
            bridge.clear_ws(websocket)

    @app.on_event("shutdown")
    def _on_shutdown():
        bridge._mailbox.close_all()

    # Static front end (web/index.html, style.css, app.js) - mounted last
    # so it acts as a catch-all under "/", after the API/WS routes above.
    app.mount("/", StaticFiles(directory=resource_path("web"), html=True), name="static")

    return app


def _open_browser_when_ready(url: str, server: uvicorn.Server):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if getattr(server, "started", False):
            with contextlib.suppress(Exception):
                webbrowser.open(url)
            return
        time.sleep(0.15)
    print(f"Сервер не поднялся за 20с — откройте {url} вручную", file=sys.stderr)


def main():
    bridge = Bridge()
    app = create_app(bridge)

    @app.on_event("startup")
    async def _on_startup():
        bridge.set_loop(asyncio.get_running_loop())

    host = "127.0.0.1"
    port = find_free_port(host, PREFERRED_PORT)
    url = f"http://{host}:{port}"

    print("\n  Mail Access Checker")
    print(f"  Интерфейс: {url}")
    print("  Остановка: Ctrl+C\n")

    config = uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)

    threading.Thread(target=_open_browser_when_ready, args=(url, server), daemon=True).start()

    with contextlib.suppress(KeyboardInterrupt):
        server.run()
    print("\n  Остановлено.")


if __name__ == "__main__":
    main()
