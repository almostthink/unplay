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

## What it deliberately does NOT do

- No proxy support of any kind — connections go out directly. This is a
  personal-inventory checker, not a distributed scraping tool.
- No CAPTCHA solving, no anti-detection, no rate-limit evasion.
- No bucket categories built around defeating provider defenses (no
  `locked` / `rate_limited` / `captcha` sorting) — just success / invalid /
  error, which is what "is my account still reachable" actually needs.
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
