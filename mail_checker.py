#!/usr/bin/env python3
"""
Mail Access Checker
====================

A straightforward tool to verify IMAP/SMTP access to email accounts you own,
reading credentials from local `email:pass` (or `email;pass`) text files.

Intended use: confirming that accounts in your own inventory are still
reachable, so you don't have to log into each one by hand.

Proxy support exists for one reason: providers like Google/Microsoft rate
limit and sometimes throw transient auth errors when many login attempts
in a row come from a single IP - which can make perfectly good accounts look
"invalid" if you're checking a large personal inventory from one machine.
Routing connections through a list of proxies spreads that load out.

What this tool does NOT do, by design:
  - No CAPTCHA handling, no anti-detection, no "make this look human" logic.
  - No response-category buckets built for evading provider defenses
    (no separate locked/rate_limited/captcha files). Results are simply
    success / invalid / error - error messages that look rate-limit-related
    are labelled as such in error.txt so you know to re-check them later,
    but they're not hidden in their own evasion-flavored bucket.
  - No huge default thread counts. Concurrency is capped modestly so a run
    behaves like a person checking their own accounts faster, not like a
    stuffing tool hammering a provider.
  - A proxy is only ever retried into on an ambiguous connection/network
    error. A clean "wrong password" response is never retried - rotating
    IPs to keep hammering a login that's genuinely rejected is exactly the
    behavior this tool is not for.

Usage:
    python mail_checker.py --input accounts.txt [options]

    --input PATH          One or more input files (email:pass or email;pass
                           per line). Repeat --input for multiple files.
    --protocol {imap,smtp,both}   Which protocol to test (default: imap)
    --threads N            Concurrent workers, 1-100 (default: 20)
    --timeout N            Per-connection timeout in seconds (default: 20)
    --output DIR           Base output directory (default: ./results)
    --proxy-file PATH       Optional proxy list, one per line (see below).
                            Omit for direct connections.
    --proxy-retries N        Max attempts per account when an attempt hits a
                            connection/network error (rotates to the next
                            proxy each retry). Default 2. Ignored for a
                            clean auth success/failure - those never retry.

Proxy list format (one per line, blank lines and lines starting with # are
skipped):
    host:port                          -> treated as SOCKS5, no auth
    host:port:user:pass                -> SOCKS5 with auth
    user:pass:host:port                -> SOCKS5 with auth
    socks4://host:port
    socks5://user:pass@host:port
    http://user:pass@host:port
    https://user:pass@host:port

With a proxy file supplied, each connection attempt draws the next proxy
from the list round-robin, so load is spread across all of them rather than
hammering one. Requires the `PySocks` package (see requirements.txt).

Output:
    A results/YYYY-MM-DD_HH-MM-SS/ directory is created per run with:
        success.txt   - email:pass that logged in successfully
        invalid.txt    - email:pass:reason for authentication failures
        error.txt      - email:pass:reason for connection/timeout/proxy/
                         unknown errors (NOT proof the credential is bad -
                         these are often transient, a server-side block, or
                         provider-side rate limiting)

Notes on providers:
    Gmail, Outlook/Hotmail/Live and most modern providers require an
    "app password" (or OAuth) once 2FA is enabled - a plain account
    password will correctly fail IMAP/SMTP login even though it is the
    real password. That will show up as invalid/error here; it does not
    mean the account itself is compromised or dead.
"""

import argparse
import concurrent.futures
import imaplib
import itertools
import re
import smtplib
import socket
import ssl
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

try:
    import socks  # PySocks - only required if a --proxy-file is used
except ImportError:
    socks = None

# --- Known provider server maps -------------------------------------------------
# host, port for IMAP (SSL) and SMTP (SSL/STARTTLS handled per-provider)
PROVIDER_MAP = {
    "gmail.com":      {"imap": ("imap.gmail.com", 993),      "smtp": ("smtp.gmail.com", 465)},
    "googlemail.com": {"imap": ("imap.gmail.com", 993),      "smtp": ("smtp.gmail.com", 465)},
    "outlook.com":    {"imap": ("outlook.office365.com", 993), "smtp": ("smtp.office365.com", 587)},
    "hotmail.com":    {"imap": ("outlook.office365.com", 993), "smtp": ("smtp.office365.com", 587)},
    "live.com":       {"imap": ("outlook.office365.com", 993), "smtp": ("smtp.office365.com", 587)},
    "msn.com":        {"imap": ("outlook.office365.com", 993), "smtp": ("smtp.office365.com", 587)},
    "yahoo.com":      {"imap": ("imap.mail.yahoo.com", 993),  "smtp": ("smtp.mail.yahoo.com", 465)},
    "yahoo.co.uk":    {"imap": ("imap.mail.yahoo.com", 993),  "smtp": ("smtp.mail.yahoo.com", 465)},
    "aol.com":        {"imap": ("imap.aol.com", 993),         "smtp": ("smtp.aol.com", 465)},
    "icloud.com":     {"imap": ("imap.mail.me.com", 993),     "smtp": ("smtp.mail.me.com", 587)},
    "mail.ru":        {"imap": ("imap.mail.ru", 993),         "smtp": ("smtp.mail.ru", 465)},
    "yandex.com":     {"imap": ("imap.yandex.com", 993),      "smtp": ("smtp.yandex.com", 465)},
    "yandex.ru":      {"imap": ("imap.yandex.ru", 993),       "smtp": ("smtp.yandex.ru", 465)},
    "gmx.com":        {"imap": ("imap.gmx.com", 993),         "smtp": ("smtp.gmx.com", 465)},
    "gmx.net":        {"imap": ("imap.gmx.net", 993),         "smtp": ("smtp.gmx.net", 465)},
    "zoho.com":       {"imap": ("imap.zoho.com", 993),        "smtp": ("smtp.zoho.com", 465)},
}

PROXY_SCHEME_RE = re.compile(
    r"^(socks4|socks5|http|https)://(?:([^:@/]+):([^@/]*)@)?([^:@/]+):(\d+)/?$", re.I
)


# --- Proxy parsing & pool ---------------------------------------------------

def _socks_type(scheme: str):
    scheme = scheme.lower()
    if scheme == "socks4":
        return socks.SOCKS4
    if scheme == "socks5":
        return socks.SOCKS5
    if scheme in ("http", "https"):
        return socks.HTTP
    raise ValueError(scheme)


def parse_proxy_line(line: str):
    """Parse one proxy-list line into {type, host, port, user, pass} or None."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None

    m = PROXY_SCHEME_RE.match(line)
    if m:
        scheme, user, pw, host, port = m.groups()
        return {"type": _socks_type(scheme), "host": host, "port": int(port), "user": user, "pass": pw}

    parts = line.split(":")
    if len(parts) == 2 and parts[1].isdigit():
        host, port = parts
        return {"type": socks.SOCKS5, "host": host, "port": int(port), "user": None, "pass": None}
    if len(parts) == 4:
        a, b, c, d = parts
        if b.isdigit():  # host:port:user:pass
            return {"type": socks.SOCKS5, "host": a, "port": int(b), "user": c, "pass": d}
        if d.isdigit():  # user:pass:host:port
            return {"type": socks.SOCKS5, "host": c, "port": int(d), "user": a, "pass": b}
    return None


def load_proxies(path: str):
    if socks is None:
        print("[!] --proxy-file was given but PySocks is not installed. "
              "Run: pip install PySocks", file=sys.stderr)
        sys.exit(1)
    proxies = []
    p = Path(path)
    if not p.is_file():
        print(f"[!] Proxy file not found: {path}", file=sys.stderr)
        sys.exit(1)
    with p.open("r", encoding="utf-8", errors="ignore") as f:
        for i, raw in enumerate(f, start=1):
            parsed = parse_proxy_line(raw)
            if parsed is None:
                stripped = raw.strip()
                if stripped and not stripped.startswith("#"):
                    print(f"[!] Skipping unrecognized proxy on line {i}: {stripped}", file=sys.stderr)
                continue
            proxies.append(parsed)
    return proxies


class ProxyPool:
    """Thread-safe round-robin over a proxy list. Empty pool = direct connections."""

    def __init__(self, proxies):
        self.proxies = proxies
        self._cycle_lock = threading.Lock()
        self._cycle = itertools.cycle(proxies) if proxies else None

    def __bool__(self):
        return bool(self.proxies)

    def __len__(self):
        return len(self.proxies)

    def next(self):
        if not self._cycle:
            return None
        with self._cycle_lock:
            return next(self._cycle)


def proxy_label(proxy):
    if not proxy:
        return "direct"
    return f"{proxy['host']}:{proxy['port']}"


# --- Proxy-aware IMAP/SMTP connections --------------------------------------

def _connect_via_proxy(host, port, proxy, timeout):
    sock = socks.socksocket()
    sock.set_proxy(proxy["type"], proxy["host"], proxy["port"],
                    username=proxy.get("user") or None, password=proxy.get("pass") or None)
    if timeout:
        sock.settimeout(timeout)
    sock.connect((host, port))
    return sock


class ProxiedIMAP4SSL(imaplib.IMAP4_SSL):
    def __init__(self, host, port, timeout, proxy):
        self.proxy = proxy
        super().__init__(host=host, port=port, timeout=timeout)

    def _create_socket(self, timeout):
        if not self.proxy:
            return super()._create_socket(timeout)
        raw = _connect_via_proxy(self.host, self.port, self.proxy, timeout)
        return self.context.wrap_socket(raw, server_hostname=self.host)


class ProxiedSMTP(smtplib.SMTP):
    def __init__(self, host, port, timeout, proxy):
        self.proxy = proxy
        super().__init__(host=host, port=port, timeout=timeout)

    def _get_socket(self, host, port, timeout):
        if not self.proxy:
            return super()._get_socket(host, port, timeout)
        return _connect_via_proxy(host, port, self.proxy, timeout)


class ProxiedSMTPSSL(smtplib.SMTP_SSL):
    def __init__(self, host, port, timeout, proxy):
        self.proxy = proxy
        super().__init__(host=host, port=port, timeout=timeout)

    def _get_socket(self, host, port, timeout):
        if not self.proxy:
            return super()._get_socket(host, port, timeout)
        raw = _connect_via_proxy(host, port, self.proxy, timeout)
        return self.context.wrap_socket(raw, server_hostname=self._host)


@dataclass
class Account:
    email: str
    password: str
    line_no: int


@dataclass
class Result:
    account: Account
    bucket: str   # success | invalid | error
    reason: str = ""


@dataclass
class Counters:
    success: int = 0
    invalid: int = 0
    error: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def bump(self, bucket: str):
        with self.lock:
            setattr(self, bucket, getattr(self, bucket) + 1)


def parse_accounts(paths):
    accounts = []
    for path in paths:
        p = Path(path)
        if not p.is_file():
            print(f"[!] Skipping missing file: {path}", file=sys.stderr)
            continue
        with p.open("r", encoding="utf-8", errors="ignore") as f:
            for i, raw in enumerate(f, start=1):
                line = raw.strip()
                if not line:
                    continue
                sep = ":" if ":" in line else (";" if ";" in line else None)
                if sep is None or "@" not in line:
                    continue
                email, _, password = line.partition(sep)
                email = email.strip()
                password = password.strip()
                if not email or not password or "@" not in email:
                    continue
                accounts.append(Account(email=email, password=password, line_no=i))
    return accounts


def servers_for(email: str):
    domain = email.rsplit("@", 1)[-1].lower()
    if domain in PROVIDER_MAP:
        return PROVIDER_MAP[domain]
    # Fall back to conventional subdomain guesses for unknown/custom domains.
    return {
        "imap": (f"imap.{domain}", 993),
        "smtp": (f"smtp.{domain}", 587),
    }


RATE_LIMIT_HINTS = ("too many", "rate limit", "try again later", "temporarily", "throttl")


def _tag_if_rate_limited(message: str) -> str:
    low = message.lower()
    if any(hint in low for hint in RATE_LIMIT_HINTS):
        return f"{message} [looks rate-limit related - re-check later]"
    return message


def check_imap(account: Account, timeout: int, proxy=None):
    host, port = servers_for(account.email)["imap"]
    where = f"({host}:{port} via {proxy_label(proxy)})"
    try:
        conn = ProxiedIMAP4SSL(host, port, timeout, proxy)
    except (socket.timeout, socket.gaierror, ConnectionRefusedError, ssl.SSLError, OSError) as e:
        kind = "proxy" if proxy else "connect"
        return Result(account, "error", f"imap {kind} failed {where}: {e}")
    try:
        conn.login(account.email, account.password)
        conn.logout()
        return Result(account, "success", f"imap login ok {where}")
    except imaplib.IMAP4.error as e:
        return Result(account, "invalid", f"imap auth failed: {_tag_if_rate_limited(str(e))}")
    except (socket.timeout, OSError) as e:
        return Result(account, "error", f"imap error {where}: {e}")
    finally:
        try:
            conn.shutdown()
        except Exception:
            pass


def check_smtp(account: Account, timeout: int, proxy=None):
    host, port = servers_for(account.email)["smtp"]
    where = f"({host}:{port} via {proxy_label(proxy)})"
    try:
        if port == 465:
            conn = ProxiedSMTPSSL(host, port, timeout, proxy)
        else:
            conn = ProxiedSMTP(host, port, timeout, proxy)
            conn.starttls()
    except (socket.timeout, socket.gaierror, ConnectionRefusedError, ssl.SSLError, OSError) as e:
        kind = "proxy" if proxy else "connect"
        return Result(account, "error", f"smtp {kind} failed {where}: {e}")
    try:
        conn.login(account.email, account.password)
        return Result(account, "success", f"smtp login ok {where}")
    except smtplib.SMTPAuthenticationError as e:
        return Result(account, "invalid", f"smtp auth failed: {_tag_if_rate_limited(str(e))}")
    except (smtplib.SMTPException, socket.timeout, OSError) as e:
        return Result(account, "error", f"smtp error {where}: {e}")
    finally:
        try:
            conn.quit()
        except Exception:
            pass


def check_account(account: Account, protocol: str, timeout: int, proxy_pool: ProxyPool, max_retries: int):
    """Check an account, rotating to the next proxy only on ambiguous
    connection/network errors. A definitive success or a clean auth
    rejection is returned immediately and is never retried."""
    attempts = max(1, max_retries)
    last = None
    for attempt in range(attempts):
        proxy = proxy_pool.next() if proxy_pool else None

        if protocol == "imap":
            res = check_imap(account, timeout, proxy)
        elif protocol == "smtp":
            res = check_smtp(account, timeout, proxy)
        else:  # both
            res = check_imap(account, timeout, proxy)
            if res.bucket == "success":
                res = check_smtp(account, timeout, proxy)
                if res.bucket == "success":
                    res = Result(account, "success", f"imap+smtp login ok via {proxy_label(proxy)}")

        last = res
        if res.bucket in ("success", "invalid"):
            return res
        if not proxy_pool or len(proxy_pool) <= 1:
            break
    return last


def build_arg_parser():
    ap = argparse.ArgumentParser(description="Check IMAP/SMTP access for your own email accounts.")
    ap.add_argument("--input", action="append", required=True, help="Input file (email:pass per line). Repeatable.")
    ap.add_argument("--protocol", choices=["imap", "smtp", "both"], default="imap")
    ap.add_argument("--threads", type=int, default=20, help="Concurrent workers (1-100, default 20)")
    ap.add_argument("--timeout", type=int, default=20, help="Per-connection timeout in seconds (default 20)")
    ap.add_argument("--output", default="results", help="Base output directory (default: ./results)")
    ap.add_argument("--proxy-file", default=None,
                     help="Optional proxy list (one per line). Omit for direct connections.")
    ap.add_argument("--proxy-retries", type=int, default=2,
                     help="Max attempts per account on connection/network errors, rotating proxies (default 2)")
    return ap


def prompt_for_args():
    """Interactive fallback for when the .exe is double-clicked with no
    command-line arguments, instead of an instant argparse error that
    closes the console window before it can be read."""
    print("=" * 60)
    print(" Mail Access Checker - interactive mode")
    print(" (no command-line arguments were given)")
    print("=" * 60)

    inputs = []
    while True:
        raw = input("Path to accounts file (email:pass per line): ").strip().strip('"')
        if not raw:
            print("  A file path is required.")
            continue
        if not Path(raw).is_file():
            print(f"  File not found: {raw}")
            continue
        inputs.append(raw)
        more = input("Add another input file? [y/N]: ").strip().lower()
        if more != "y":
            break

    protocol = input("Protocol [imap/smtp/both] (default imap): ").strip().lower() or "imap"
    if protocol not in ("imap", "smtp", "both"):
        protocol = "imap"

    threads_raw = input("Threads (default 20): ").strip()
    threads = int(threads_raw) if threads_raw.isdigit() else 20

    timeout_raw = input("Timeout seconds (default 20): ").strip()
    timeout = int(timeout_raw) if timeout_raw.isdigit() else 20

    proxy_file = input("Proxy list file (optional, press Enter to skip): ").strip().strip('"') or None
    if proxy_file and not Path(proxy_file).is_file():
        print(f"  Proxy file not found, continuing without proxies: {proxy_file}")
        proxy_file = None

    argv = []
    for path in inputs:
        argv += ["--input", path]
    argv += ["--protocol", protocol, "--threads", str(threads), "--timeout", str(timeout)]
    if proxy_file:
        argv += ["--proxy-file", proxy_file]

    return build_arg_parser().parse_args(argv)


def run(args):
    threads = max(1, min(100, args.threads))
    timeout = max(5, min(120, args.timeout))
    proxy_retries = max(1, min(10, args.proxy_retries))

    proxies = load_proxies(args.proxy_file) if args.proxy_file else []
    if args.proxy_file and not proxies:
        print("[!] Proxy file given but no usable proxies were parsed from it.", file=sys.stderr)
        sys.exit(1)
    proxy_pool = ProxyPool(proxies)

    accounts = parse_accounts(args.input)
    if not accounts:
        print("[!] No valid email:pass rows found in the given input file(s).", file=sys.stderr)
        sys.exit(1)

    run_dir = Path(args.output) / datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    files = {
        "success": (run_dir / "success.txt").open("a", encoding="utf-8"),
        "invalid": (run_dir / "invalid.txt").open("a", encoding="utf-8"),
        "error": (run_dir / "error.txt").open("a", encoding="utf-8"),
    }
    write_lock = threading.Lock()
    counters = Counters()

    total = len(accounts)
    proxy_note = f"Proxies={len(proxy_pool)} (round-robin)" if proxy_pool else "Proxies=off (direct)"
    print(f"[*] Loaded {total} accounts. Protocol={args.protocol} Threads={threads} Timeout={timeout}s")
    print(f"[*] {proxy_note}")
    print(f"[*] Output: {run_dir}")

    start = time.time()
    done = 0
    done_lock = threading.Lock()

    def worker(acc):
        return check_account(acc, args.protocol, timeout, proxy_pool, proxy_retries)

    with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as pool:
        futures = {pool.submit(worker, acc): acc for acc in accounts}
        for fut in concurrent.futures.as_completed(futures):
            res = fut.result()
            counters.bump(res.bucket)
            with write_lock:
                fh = files[res.bucket]
                if res.bucket == "success":
                    fh.write(f"{res.account.email}:{res.account.password}\n")
                else:
                    fh.write(f"{res.account.email}:{res.account.password}:{res.reason}\n")
                fh.flush()
            with done_lock:
                done += 1
                if done % 25 == 0 or done == total:
                    elapsed = time.time() - start
                    print(f"[*] {done}/{total} checked "
                          f"(ok={counters.success} invalid={counters.invalid} error={counters.error}) "
                          f"- {elapsed:.1f}s")

    for fh in files.values():
        fh.close()

    print("\n[+] Done.")
    print(f"    success: {counters.success}")
    print(f"    invalid: {counters.invalid}")
    print(f"    error:   {counters.error}")
    print(f"    results: {run_dir}")


def main():
    # Double-clicking the .exe on Windows launches it with no arguments.
    # argparse would then print a "the following arguments are required"
    # error and exit immediately, closing the console window before
    # anyone can read it. Fall back to an interactive prompt instead.
    interactive = len(sys.argv) == 1

    try:
        if interactive:
            args = prompt_for_args()
        else:
            args = build_arg_parser().parse_args()
        run(args)
    except KeyboardInterrupt:
        print("\n[!] Interrupted by user.")
    except SystemExit:
        raise
    except Exception:
        import traceback
        print("\n[!] Unexpected error:", file=sys.stderr)
        traceback.print_exc()
    finally:
        if interactive:
            input("\nPress Enter to exit...")


if __name__ == "__main__":
    main()
