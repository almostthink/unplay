#!/usr/bin/env python3
"""
Mail Access Checker - GUI
==========================

A desktop window (HTML/CSS/JS front end via pywebview, Python back end)
around mail_checker.py's account-checking logic. Same checks, same
proxy-rotation-to-avoid-throttling behavior, same output files - just a
GUI instead of a console.

Run from source:
    pip install -r requirements.txt
    python gui.py

Build for Windows (--onedir, not --onefile: pywebview's WebView2 backend
is more reliable this way, and --collect-all pulls in its loader files
that plain --add-data would miss):
    pyinstaller --onedir --windowed --name mail_checker_gui \
        --collect-all webview --add-data "web;web" gui.py

Requires the Microsoft Edge WebView2 Runtime on the machine running the
built exe (present by default on most Windows 10/11 installs since it
ships with Edge; missing on some minimal/LTSC installs). Without it, the
window would otherwise hang at startup with no visible error - main()
below checks for it first and shows a clear message instead.
"""

import concurrent.futures
import imaplib
import json
import os
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

import webview

import mail_checker as core
from mailbox_manager import MailboxManager


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


class Api:
    def __init__(self):
        self.window = None
        self._running = False
        self._cancel_event = threading.Event()
        self._mailbox = MailboxManager()
        self._creds = {}   # email -> password, populated by load_run()

    def set_window(self, window):
        self.window = window

    # --- file pickers -------------------------------------------------

    def pick_input_files(self):
        result = self.window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=True,
            file_types=("Text files (*.txt)", "All files (*.*)"),
        )
        return list(result) if result else []

    def pick_proxy_file(self):
        result = self.window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("Text files (*.txt)", "All files (*.*)"),
        )
        return result[0] if result else None

    def open_folder(self, path):
        try:
            if sys.platform.startswith("win"):
                os.startfile(path)  # noqa: S606
            elif sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["xdg-open", path])
        except Exception as e:
            self._push("onFatalError", str(e))
        return True

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

    # --- worker ----------------------------------------------------------

    def _push(self, js_fn, data):
        if not self.window:
            return
        payload = json.dumps(data)
        try:
            self.window.evaluate_js(f"window.{js_fn} && window.{js_fn}({payload})")
        except Exception:
            pass

    def _run_check(self, accounts, config, proxies):
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

            self._push("onStart", {
                "total": len(accounts),
                "protocol": protocol,
                "threads": threads,
                "proxyCount": len(proxy_pool),
                "outputDir": str(run_dir),
            })

            def worker(acc):
                return core.check_account(acc, protocol, timeout, proxy_pool, proxy_retries)

            cancelled = False
            with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as pool:
                futures = {pool.submit(worker, acc): acc for acc in accounts}
                for fut in concurrent.futures.as_completed(futures):
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
                    self._push("onResult", {
                        "email": res.account.email,
                        "bucket": res.bucket,
                        "reason": res.reason,
                    })

            for fh in files.values():
                fh.close()

            if cancelled:
                self._push("onCancelled", {})
            else:
                # Recount from the written files so the summary is exact even
                # if a couple of stragglers finished after the cancel check.
                counts = {}
                for bucket, fh_path in (("success", "success.txt"), ("invalid", "invalid.txt"), ("error", "error.txt")):
                    p = run_dir / fh_path
                    counts[bucket] = sum(1 for _ in p.open("r", encoding="utf-8")) if p.exists() else 0
                self._push("onDone", counts)
        except Exception as e:
            self._push("onFatalError", str(e))
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
        password = self._creds.get(email_addr)
        if password is None:
            return {"ok": False, "error": "Нет сохранённого пароля для этого адреса. Загрузите запуск заново."}
        try:
            session = self._mailbox.open(email_addr, password)
            folders = [{"raw": f["raw"], "display": f["display"]} for f in session.folders]
            return {"ok": True, "folders": folders, "hasTrash": bool(session.trash_raw)}
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

    def download_attachment(self, email_addr, uid, part_index, filename):
        try:
            session = self._get_session(email_addr)
            data = self._mailbox.get_attachment_bytes(session, uid, part_index)
        except Exception as e:
            return {"ok": False, "error": str(e)}

        save_path = self.window.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=filename or "attachment"
        )
        if not save_path:
            return {"ok": False, "error": ""}  # user cancelled, not a real error
        target = save_path if isinstance(save_path, str) else save_path[0]
        try:
            with open(target, "wb") as f:
                f.write(data)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "path": target}


_WEBVIEW2_CLIENT_GUID = r"{F3417C3F-BEF7-4029-82D7-FD224A981E58}"


def _webview2_installed() -> bool:
    """Best-effort check for the Microsoft Edge WebView2 Runtime, which
    pywebview's Windows backend needs. Without it, webview.start() doesn't
    raise a clean error - the window just never finishes initializing,
    which Windows reports as 'Not Responding'. Checking first lets us show
    an actual message instead of a silent hang."""
    if not sys.platform.startswith("win"):
        return True
    import winreg

    candidates = [
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{_WEBVIEW2_CLIENT_GUID}"),
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{_WEBVIEW2_CLIENT_GUID}"),
        (winreg.HKEY_CURRENT_USER, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{_WEBVIEW2_CLIENT_GUID}"),
    ]
    for hive, path in candidates:
        try:
            with winreg.OpenKey(hive, path):
                return True
        except OSError:
            continue
    return False


def _warn_missing_webview2():
    message = (
        "Не найден компонент Microsoft Edge WebView2 Runtime — без него это окно "
        "не запускается (обычно выглядит как «Не отвечает»).\n\n"
        "Установите WebView2 Runtime (бесплатно, от Microsoft) и запустите программу "
        "снова:\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\n"
        "Пока можно пользоваться mail_checker.exe (консольная версия с той же "
        "проверкой почт, без окна)."
    )
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, message, "Mail Access Checker", 0x10)
    except Exception:
        print(message, file=sys.stderr)


def main():
    if getattr(sys, "frozen", False) and not _webview2_installed():
        _warn_missing_webview2()
        sys.exit(1)

    api = Api()
    window = webview.create_window(
        "Mail Access Checker",
        resource_path("web/index.html"),
        js_api=api,
        width=1040,
        height=740,
        min_size=(820, 600),
    )
    api.set_window(window)
    window.events.closing += api._mailbox.close_all
    webview.start()


if __name__ == "__main__":
    main()
