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

Build to a single Windows .exe:
    pyinstaller --onefile --windowed --name mail_checker_gui \
        --add-data "web;web" gui.py
"""

import concurrent.futures
import json
import os
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

import webview

import mail_checker as core


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


def main():
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
    webview.start()


if __name__ == "__main__":
    main()
