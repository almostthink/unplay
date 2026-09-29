#!/usr/bin/env python3
"""
Mailbox Manager
================

IMAP-backed "manage your own mailbox" layer used by the GUI once an
account has been confirmed reachable by mail_checker.py: list folders,
list/read messages, mark read/unread, delete (moving to a trash folder
when one exists), and download individual attachments.

This intentionally does NOT include:
  - Session/cookie extraction. There is no reason for an account's owner
    to need that - they already have the password. It exists in
    credential-market tooling to keep silent access to an account without
    the owner noticing.
  - Auto-forward / silent-forwarding configuration. Same reasoning: it is
    a way to keep receiving someone's mail after you no longer have (or
    never had) their password, not an "account management" feature for an
    owner who is logged in directly.
  - Outlook profile extraction.

What's here is the ordinary feature set of any IMAP mail client: read
your folders, read your mail, clean it up.
"""

import base64
import email
import email.header
import email.utils
import imaplib
import re
import threading
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Optional

import mail_checker as core

TRASH_NAME_HINTS = (
    "trash", "deleted items", "deleted messages", "bin",
    "корзина", "удал",  # covers "удалённые", "удаленные"
)


# --- IMAP modified UTF-7 (RFC 3501 5.1.3), used for non-ASCII folder names ---

def imap_utf7_decode(s: str) -> str:
    out = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c == "&":
            j = s.find("-", i + 1)
            if j == -1:
                j = n
            chunk = s[i + 1:j]
            if chunk == "":
                out.append("&")
            else:
                b64 = chunk.replace(",", "/")
                b64 += "=" * (-len(b64) % 4)
                try:
                    out.append(base64.b64decode(b64).decode("utf-16-be"))
                except Exception:
                    out.append(chunk)
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def imap_quote(name: str) -> str:
    escaped = name.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


_LIST_RE = re.compile(r'^\((?P<flags>[^)]*)\)\s+"(?P<delim>[^"]*)"\s+(?P<name>.+)$')


def parse_list_line(raw: bytes):
    try:
        line = raw.decode("utf-8", "replace")
    except Exception:
        return None
    m = _LIST_RE.match(line)
    if not m:
        return None
    name = m.group("name").strip()
    if name.startswith('"') and name.endswith('"'):
        name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return {"raw": name, "flags": m.group("flags")}


class _TextExtractor(HTMLParser):
    """Very small HTML->text fallback for reading a message body when no
    text/plain part is offered. Not a renderer - just makes HTML mail
    legible without executing anything."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._parts = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in ("br", "p", "div", "tr", "li"):
            self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip > 0:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self._parts.append(data)

    def text(self):
        raw = "".join(self._parts)
        lines = [ln.strip() for ln in raw.splitlines()]
        out, blank = [], False
        for ln in lines:
            if ln:
                out.append(ln)
                blank = False
            elif not blank:
                out.append("")
                blank = True
        return "\n".join(out).strip()


def html_to_text(html: str) -> str:
    p = _TextExtractor()
    try:
        p.feed(html)
    except Exception:
        return html
    return p.text()


def decode_mime_words(value: Optional[str]) -> str:
    if not value:
        return ""
    try:
        parts = email.header.decode_header(value)
        out = []
        for text, enc in parts:
            if isinstance(text, bytes):
                out.append(text.decode(enc or "utf-8", "replace"))
            else:
                out.append(text)
        return "".join(out)
    except Exception:
        return value


@dataclass
class MailboxSession:
    email: str
    password: str
    conn: imaplib.IMAP4_SSL
    lock: threading.Lock = field(default_factory=threading.Lock)
    folders: list = field(default_factory=list)   # [{raw, display, flags}]
    trash_raw: Optional[str] = None
    selected_raw: Optional[str] = None


class MailboxManager:
    """Holds one open IMAP connection per email address the user has
    opened in the viewer, so folder/message browsing doesn't reconnect on
    every click. Connections for direct (non-proxied) access only - the
    viewer is meant for occasional use on accounts already confirmed
    reachable, not for bulk operations."""

    def __init__(self):
        self._sessions = {}
        self._sessions_lock = threading.Lock()

    def open(self, email_addr: str, password: str, timeout: int = 20) -> MailboxSession:
        with self._sessions_lock:
            existing = self._sessions.get(email_addr)
        if existing is not None:
            return existing

        host, port = core.servers_for(email_addr)["imap"]
        conn = core.ProxiedIMAP4SSL(host, port, timeout, None)
        conn.login(email_addr, password)

        typ, data = conn.list()
        folders = []
        trash_raw = None
        if typ == "OK":
            for line in data:
                parsed = parse_list_line(line)
                if not parsed:
                    continue
                display = imap_utf7_decode(parsed["raw"])
                entry = {"raw": parsed["raw"], "display": display, "flags": parsed["flags"]}
                folders.append(entry)
                low_flags = parsed["flags"].lower()
                low_name = display.lower()
                if "\\trash" in low_flags or any(h in low_name for h in TRASH_NAME_HINTS):
                    trash_raw = parsed["raw"]

        session = MailboxSession(email=email_addr, password=password, conn=conn,
                                  folders=folders, trash_raw=trash_raw)
        with self._sessions_lock:
            self._sessions[email_addr] = session
        return session

    def get(self, email_addr: str) -> Optional[MailboxSession]:
        with self._sessions_lock:
            return self._sessions.get(email_addr)

    def close(self, email_addr: str):
        with self._sessions_lock:
            session = self._sessions.pop(email_addr, None)
        if session:
            try:
                session.conn.logout()
            except Exception:
                pass

    def close_all(self):
        with self._sessions_lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for s in sessions:
            try:
                s.conn.logout()
            except Exception:
                pass

    # --- folder / message operations ------------------------------------

    def select_folder(self, session: MailboxSession, folder_raw: str) -> int:
        with session.lock:
            typ, data = session.conn.select(imap_quote(folder_raw), readonly=False)
            if typ != "OK":
                raise RuntimeError(f"Не удалось открыть папку: {data}")
            session.selected_raw = folder_raw
            count = int(data[0]) if data and data[0] else 0
            return count

    def list_messages(self, session: MailboxSession, offset: int, limit: int):
        with session.lock:
            typ, data = session.conn.uid("search", None, "ALL")
            if typ != "OK" or not data or not data[0]:
                return [], 0
            uids = data[0].split()
            uids.reverse()  # newest first (UIDs increase over time)
            total = len(uids)
            page = uids[offset:offset + limit]

            out = []
            for uid in page:
                typ, msg_data = session.conn.uid(
                    "fetch", uid, "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])"
                )
                if typ != "OK" or not msg_data or not isinstance(msg_data[0], tuple):
                    continue
                prefix, header_bytes = msg_data[0]
                flags_match = re.search(rb"FLAGS \(([^)]*)\)", prefix)
                flags = flags_match.group(1).decode("ascii", "replace") if flags_match else ""
                msg = email.message_from_bytes(header_bytes)
                date_str = msg.get("Date", "")
                try:
                    dt = email.utils.parsedate_to_datetime(date_str)
                    date_display = dt.strftime("%Y-%m-%d %H:%M") if dt else date_str
                except Exception:
                    date_display = date_str
                out.append({
                    "uid": uid.decode("ascii"),
                    "from": decode_mime_words(msg.get("From", "")),
                    "subject": decode_mime_words(msg.get("Subject", "")) or "(без темы)",
                    "date": date_display,
                    "unread": "\\Seen" not in flags,
                })
            return out, total

    def get_message(self, session: MailboxSession, uid: str):
        with session.lock:
            typ, data = session.conn.uid("fetch", uid, "(BODY.PEEK[] FLAGS)")
            if typ != "OK" or not data or not isinstance(data[0], tuple):
                raise RuntimeError("Не удалось загрузить письмо.")
            raw = data[0][1]

        msg = email.message_from_bytes(raw)
        body_text = None
        html_fallback = None
        attachments = []

        def walk(m, path):
            nonlocal body_text, html_fallback
            if m.is_multipart():
                for i, part in enumerate(m.get_payload()):
                    walk(part, path + [i])
                return
            content_type = m.get_content_type()
            disposition = (m.get("Content-Disposition") or "").lower()
            filename = m.get_filename()
            is_attachment = "attachment" in disposition or (filename and "inline" not in disposition)

            if is_attachment and filename:
                payload = m.get_payload(decode=True) or b""
                attachments.append({
                    "index": ".".join(str(p) for p in path),
                    "filename": decode_mime_words(filename),
                    "size": len(payload),
                    "content_type": content_type,
                })
                return

            if content_type == "text/plain" and body_text is None:
                charset = m.get_content_charset() or "utf-8"
                try:
                    body_text = m.get_payload(decode=True).decode(charset, "replace")
                except Exception:
                    body_text = m.get_payload(decode=True).decode("utf-8", "replace")
            elif content_type == "text/html" and html_fallback is None:
                charset = m.get_content_charset() or "utf-8"
                try:
                    html_fallback = m.get_payload(decode=True).decode(charset, "replace")
                except Exception:
                    html_fallback = m.get_payload(decode=True).decode("utf-8", "replace")

        walk(msg, [])

        body = body_text if body_text is not None else (html_to_text(html_fallback) if html_fallback else "(нет текстового содержимого)")

        return {
            "uid": uid,
            "from": decode_mime_words(msg.get("From", "")),
            "to": decode_mime_words(msg.get("To", "")),
            "subject": decode_mime_words(msg.get("Subject", "")) or "(без темы)",
            "date": decode_mime_words(msg.get("Date", "")),
            "body": body,
            "attachments": attachments,
        }

    def get_attachment_bytes(self, session: MailboxSession, uid: str, part_index: str):
        with session.lock:
            typ, data = session.conn.uid("fetch", uid, "(BODY.PEEK[])")
            if typ != "OK" or not data or not isinstance(data[0], tuple):
                raise RuntimeError("Не удалось загрузить вложение.")
            raw = data[0][1]
        msg = email.message_from_bytes(raw)
        target = msg
        if part_index:
            for i in part_index.split("."):
                target = target.get_payload()[int(i)]
        return target.get_payload(decode=True) or b""

    def set_seen(self, session: MailboxSession, uid: str, seen: bool):
        with session.lock:
            cmd = "+FLAGS" if seen else "-FLAGS"
            session.conn.uid("store", uid, cmd, "(\\Seen)")

    def delete_message(self, session: MailboxSession, uid: str) -> str:
        """Delete a message, moving it to the trash folder when one is
        known and we're not already in it; otherwise expunges it directly.
        Returns 'trashed' or 'deleted'."""
        with session.lock:
            if session.trash_raw and session.selected_raw != session.trash_raw:
                session.conn.uid("copy", uid, imap_quote(session.trash_raw))
                session.conn.uid("store", uid, "+FLAGS", "(\\Deleted)")
                session.conn.expunge()
                return "trashed"
            session.conn.uid("store", uid, "+FLAGS", "(\\Deleted)")
            session.conn.expunge()
            return "deleted"
