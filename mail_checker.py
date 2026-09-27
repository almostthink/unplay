#!/usr/bin/env python3
"""
Mail Access Checker
====================

A straightforward tool to verify IMAP/SMTP access to email accounts you own,
reading credentials from local `email:pass` (or `email;pass`) text files.

Intended use: confirming that accounts in your own inventory are still
reachable, so you don't have to log into each one by hand.

What this tool does NOT do, by design:
  - No proxy rotation / proxy support of any kind (direct connections only).
  - No CAPTCHA handling, no anti-detection, no rate-limit evasion.
  - No response-category buckets built for evading provider defenses
    (locked / rate_limited / captcha style sorting). Results are simply
    success / invalid / error, which is what "did my login work" needs.
  - No huge default thread counts. Concurrency is capped modestly so a run
    behaves like a person checking their own accounts faster, not like a
    stuffing tool hammering a provider.

Usage:
    python mail_checker.py --input accounts.txt [options]

    --input PATH        One or more input files (email:pass or email;pass
                         per line). Repeat --input for multiple files.
    --protocol {imap,smtp,both}   Which protocol to test (default: imap)
    --threads N          Concurrent workers, 1-100 (default: 20)
    --timeout N          Per-connection timeout in seconds (default: 20)
    --output DIR         Base output directory (default: ./results)

Output:
    A results/YYYY-MM-DD_HH-MM-SS/ directory is created per run with:
        success.txt   - email:pass that logged in successfully
        invalid.txt    - email:pass:reason for authentication failures
        error.txt      - email:pass:reason for connection/timeout/unknown
                         errors (NOT proof the credential is bad - these
                         are often transient or a server-side block)

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
import smtplib
import socket
import ssl
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

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


def check_imap(account: Account, timeout: int):
    host, port = servers_for(account.email)["imap"]
    try:
        conn = imaplib.IMAP4_SSL(host, port, timeout=timeout)
    except (socket.timeout, socket.gaierror, ConnectionRefusedError, ssl.SSLError, OSError) as e:
        return Result(account, "error", f"imap connect failed ({host}:{port}): {e}")
    try:
        conn.login(account.email, account.password)
        conn.logout()
        return Result(account, "success", "imap login ok")
    except imaplib.IMAP4.error as e:
        return Result(account, "invalid", f"imap auth failed: {e}")
    except (socket.timeout, OSError) as e:
        return Result(account, "error", f"imap error: {e}")
    finally:
        try:
            conn.shutdown()
        except Exception:
            pass


def check_smtp(account: Account, timeout: int):
    host, port = servers_for(account.email)["smtp"]
    try:
        if port == 465:
            conn = smtplib.SMTP_SSL(host, port, timeout=timeout)
        else:
            conn = smtplib.SMTP(host, port, timeout=timeout)
            conn.starttls()
    except (socket.timeout, socket.gaierror, ConnectionRefusedError, ssl.SSLError, OSError) as e:
        return Result(account, "error", f"smtp connect failed ({host}:{port}): {e}")
    try:
        conn.login(account.email, account.password)
        return Result(account, "success", "smtp login ok")
    except smtplib.SMTPAuthenticationError as e:
        return Result(account, "invalid", f"smtp auth failed: {e}")
    except (smtplib.SMTPException, socket.timeout, OSError) as e:
        return Result(account, "error", f"smtp error: {e}")
    finally:
        try:
            conn.quit()
        except Exception:
            pass


def check_account(account: Account, protocol: str, timeout: int):
    if protocol == "imap":
        return check_imap(account, timeout)
    if protocol == "smtp":
        return check_smtp(account, timeout)
    # both: success requires both to succeed; report the more specific failure.
    imap_res = check_imap(account, timeout)
    if imap_res.bucket != "success":
        return imap_res
    smtp_res = check_smtp(account, timeout)
    if smtp_res.bucket != "success":
        return smtp_res
    return Result(account, "success", "imap+smtp login ok")


def main():
    ap = argparse.ArgumentParser(description="Check IMAP/SMTP access for your own email accounts.")
    ap.add_argument("--input", action="append", required=True, help="Input file (email:pass per line). Repeatable.")
    ap.add_argument("--protocol", choices=["imap", "smtp", "both"], default="imap")
    ap.add_argument("--threads", type=int, default=20, help="Concurrent workers (1-100, default 20)")
    ap.add_argument("--timeout", type=int, default=20, help="Per-connection timeout in seconds (default 20)")
    ap.add_argument("--output", default="results", help="Base output directory (default: ./results)")
    args = ap.parse_args()

    threads = max(1, min(100, args.threads))
    timeout = max(5, min(120, args.timeout))

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
    print(f"[*] Loaded {total} accounts. Protocol={args.protocol} Threads={threads} Timeout={timeout}s")
    print(f"[*] Output: {run_dir}")

    start = time.time()
    done = 0
    done_lock = threading.Lock()

    def worker(acc):
        return check_account(acc, args.protocol, timeout)

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


if __name__ == "__main__":
    main()
