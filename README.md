# Mail Access Checker

A small tool for checking IMAP/SMTP access to email accounts **you own**,
reading credentials from a local `email:pass` (or `email;pass`) text file.
Built for the case where you have a large personal inventory of mailboxes
and don't want to log into each one by hand to confirm it still works.

## What it does

- Reads one or more input files, one `email:pass` per line.
- For each account, opens a direct IMAP and/or SMTP connection to the
  provider and attempts to log in.
- Sorts results into a timestamped output folder:
  - `success.txt` — login worked
  - `invalid.txt` — login was rejected (wrong/expired password, or the
    provider requires an app password / 2FA step your plain password can't
    satisfy)
  - `error.txt` — connection/timeout/unknown errors. **Not proof the
    credential is bad** — these can be transient network issues or a
    server-side hiccup.
- Ships with server presets for Gmail, Outlook/Hotmail/Live, Yahoo, AOL,
  iCloud, Mail.ru, Yandex, GMX, and Zoho. Unknown/custom domains fall back
  to the conventional `imap.<domain>` / `smtp.<domain>` guess.

## Proxy support

If you're checking a large inventory from one machine, providers like
Google/Microsoft can rate-limit or throw transient auth errors purely
because of *how many* login attempts came from your one IP in a short
window — which makes perfectly good accounts look broken. `--proxy-file`
spreads connections across a proxy list (round-robin) to avoid that.

```
python mail_checker.py --input accounts.txt --proxy-file proxies.txt
```

Proxy list format, one per line (`#` comments and blank lines are skipped):

```
host:port                          # SOCKS5, no auth
host:port:user:pass                # SOCKS5 with auth
user:pass:host:port                # SOCKS5 with auth
socks4://host:port
socks5://user:pass@host:port
http://user:pass@host:port
https://user:pass@host:port
```

Requires `PySocks` (`pip install -r requirements.txt`). Leave `--proxy-file`
unset for direct connections.

`--proxy-retries` (default 2) controls how many times an account is retried
through a *different* proxy — but only on an ambiguous connection/network
error. A clean "wrong password" response is never retried: rotating IPs to
keep hammering a login that's genuinely rejected is not what this is for.

## What it deliberately does NOT do

- No CAPTCHA solving, no anti-detection, no "make this look human" logic.
- No bucket categories built around defeating provider defenses (no
  separate `locked` / `rate_limited` / `captcha` files) — just success /
  invalid / error. Error messages that look rate-limit related are tagged
  as such inside `error.txt` so you know to re-check them later, rather
  than hidden in their own evasion-flavored bucket.
- Default concurrency is modest (20 threads) and capped at 100, not
  thousands.

## Usage

```bash
pip install -r requirements.txt   # only needed to build the .exe; the
                                   # script itself has no dependencies
python mail_checker.py --input accounts.txt
```

Options:

| Flag         | Default | Notes                                          |
|--------------|---------|-------------------------------------------------|
| `--input`    | —       | Path to an `email:pass` file. Repeatable.       |
| `--protocol` | `imap`  | `imap`, `smtp`, or `both`                       |
| `--threads`  | `20`    | 1–100 concurrent workers                        |
| `--timeout`  | `20`    | Per-connection timeout, seconds (5–120)         |
| `--output`   | `results` | Base folder; a `YYYY-MM-DD_HH-MM-SS` run dir is created inside it |
| `--proxy-file` | *(none)* | Optional proxy list — see **Proxy support** below |
| `--proxy-retries` | `2` | Retries per account on network errors only, rotating proxies |

Example checking both protocols with more concurrency:

```bash
python mail_checker.py --input accounts1.txt --input accounts2.txt \
    --protocol both --threads 40 --timeout 25
```

## A note on Gmail / Outlook and 2FA

If an account has 2-Step Verification / Modern Auth enabled, the real
account password will not work for plain IMAP/SMTP login — the provider
requires an **app password** or OAuth token instead. Such accounts will
show up in `invalid.txt` or `error.txt` even though the account itself is
fine and the password is correct for the web login. That's expected
provider behavior, not a bug in this tool.

## Building the standalone Windows .exe

A GitHub Actions workflow (`.github/workflows/build-exe.yml`) builds
`mail_checker.exe` on `windows-latest` automatically on every push that
touches `mail_checker.py`, and can also be triggered manually from the
**Actions** tab (`workflow_dispatch`). Download the artifact named
`mail_checker-windows-exe` from a completed run.

To build it yourself locally on Windows:

```powershell
pip install pyinstaller
pyinstaller --onefile --console --name mail_checker mail_checker.py
# -> dist\mail_checker.exe
```

Then run it from a terminal:

```powershell
mail_checker.exe --input accounts.txt --protocol imap --threads 20
```

## Only use this on accounts you own or are authorized to check.
