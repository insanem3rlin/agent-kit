#!/usr/bin/env python3
"""Claude Code status line: context-window usage, and plan usage when enabled.

Renders, on one line:
  <model>  <context bar> <ctx tokens>/<limit> (<ctx %>)  [·  5h <usage %>]

- Context usage is read from the session transcript (latest turn's prompt size).
- Plan usage (5h / 7d) is off until you enable it. It needs your Claude login
  token, so this script reads no credentials and makes no network request
  unless you name them yourself in <config>/statusline.json, where <config>
  is $AGENT_KIT_CONFIG or ~/.config/agent-kit:

      {"usage_credentials": "~/.claude/.credentials.json", "context_limit": 280000}

  "usage_credentials" is a path to Claude Code's credentials file (or to a
  file holding only the token); "usage_token" gives the token directly.
  The token is sent only to the Anthropic usage endpoint
  (GET /api/oauth/usage -> five_hour.utilization). The value is cached to a
  small file and refreshed by a *detached background* process so the status
  line itself never blocks on the network.
- "context_limit" sets the size of the context bar (default 280000).

Invoked two ways:
  python statusline.py            # render (reads stdin status JSON)
  python statusline.py --refresh  # fetch usage, write cache, exit (background)
"""
import sys
import os
import json
import time
import subprocess
import urllib.request

BAR_WIDTH = 10
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CONFIG_DIR = os.path.expanduser(os.environ.get("AGENT_KIT_CONFIG") or "~/.config/agent-kit")
STATE_DIR = os.path.expanduser(os.environ.get("AGENT_KIT_STATE") or "~/.local/state/agent-kit")
CACHE_FILE = os.path.join(STATE_DIR, "statusline-usage.json")
ATTEMPT_FILE = os.path.join(STATE_DIR, "statusline-usage.attempt")


def load_config():
    try:
        with open(os.path.join(CONFIG_DIR, "statusline.json"), encoding="utf-8") as fh:
            cfg = json.load(fh)
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


CONFIG = load_config()
try:
    CONTEXT_LIMIT = int(CONFIG.get("context_limit") or 280_000)
except (TypeError, ValueError):
    CONTEXT_LIMIT = 280_000
USAGE_ENABLED = bool(CONFIG.get("usage_token") or CONFIG.get("usage_credentials"))
CACHE_TTL = 45                   # seconds before a background refresh is triggered
ATTEMPT_THROTTLE = 10            # min seconds between spawning refreshers

GREEN, YELLOW, RED = "\033[32m", "\033[33m", "\033[31m"
RESET, DIM = "\033[0m", "\033[2m"

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# ---------- shared helpers ----------

def color_for(pct):
    return GREEN if pct < 50 else YELLOW if pct < 80 else RED


def human(n):
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


# ---------- 5h usage: refresh path (runs in background) ----------

def access_token():
    """The token the user configured: given directly, or read from the file they named."""
    if CONFIG.get("usage_token"):
        return str(CONFIG["usage_token"]).strip()
    with open(os.path.expanduser(str(CONFIG["usage_credentials"])), encoding="utf-8") as fh:
        text = fh.read().strip()
    try:
        return json.loads(text)["claudeAiOauth"]["accessToken"]
    except ValueError:
        return text


def refresh_usage():
    """Fetch usage and atomically write the cache. Silent on any failure."""
    if not USAGE_ENABLED:
        return
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        req = urllib.request.Request(
            USAGE_URL,
            headers={
                "Authorization": f"Bearer {access_token()}",
                "anthropic-beta": "oauth-2025-04-20",
                "anthropic-version": "2023-06-01",
                "User-Agent": "claude-cli/statusline",
            },
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        five = (data.get("five_hour") or {}).get("utilization")
        seven = (data.get("seven_day") or {}).get("utilization")
        payload = {
            "ts": time.time(),
            "five_hour": five,
            "seven_day": seven,
            "resets_at": (data.get("five_hour") or {}).get("resets_at"),
        }
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        os.replace(tmp, CACHE_FILE)
    except Exception:
        pass


# ---------- 5h usage: render path ----------

def read_cache():
    try:
        with open(CACHE_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def maybe_trigger_refresh():
    """Spawn a detached refresher if the cache is stale and we're not throttled."""
    try:
        last_attempt = os.path.getmtime(ATTEMPT_FILE)
    except OSError:
        last_attempt = 0
    if time.time() - last_attempt < ATTEMPT_THROTTLE:
        return
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(ATTEMPT_FILE, "w") as fh:
            fh.write(str(time.time()))
    except OSError:
        pass

    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        # DETACHED_PROCESS | CREATE_NO_WINDOW
        kwargs["creationflags"] = 0x00000008 | 0x08000000
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--refresh"], **kwargs
        )
    except Exception:
        pass


def usage_segment():
    cache = read_cache()
    fresh = cache and (time.time() - cache.get("ts", 0) < CACHE_TTL)
    if not fresh:
        maybe_trigger_refresh()
    if not cache or cache.get("five_hour") is None:
        return f"{DIM}5h …{RESET}"
    stale = "" if fresh else DIM + "*" + RESET  # mark a value awaiting refresh
    parts = []
    for label, key in (("5h", "five_hour"), ("7d", "seven_day")):
        pct = cache.get(key)
        if pct is None:
            continue
        col = color_for(pct)
        parts.append(f"{DIM}{label}{RESET} {col}{pct:.0f}%{RESET}")
    return " ".join(parts) + stale


# ---------- context usage ----------

def latest_context_tokens(transcript_path):
    used = 0
    if not (transcript_path and os.path.exists(transcript_path)):
        return used
    try:
        with open(transcript_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                usage = (obj.get("message") or {}).get("usage")
                if usage:
                    used = (
                        usage.get("input_tokens", 0)
                        + usage.get("cache_creation_input_tokens", 0)
                        + usage.get("cache_read_input_tokens", 0)
                    )
    except OSError:
        pass
    return used


def context_segment(data):
    model = (data.get("model") or {}).get("display_name") or "?"
    used = latest_context_tokens(data.get("transcript_path"))
    pct = (used / CONTEXT_LIMIT * 100) if CONTEXT_LIMIT else 0.0
    shown = min(pct / 100, 1.0)
    col = color_for(pct)
    filled = int(round(shown * BAR_WIDTH))
    bar = "█" * filled + "░" * (BAR_WIDTH - filled)
    return (
        f"{DIM}{model}{RESET}  "
        f"{col}{bar}{RESET} "
        f"{human(used)}/{human(CONTEXT_LIMIT)} "
        f"{col}({pct:.0f}%){RESET}"
    )


def main():
    if "--refresh" in sys.argv[1:]:
        refresh_usage()
        return
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    line = context_segment(data)
    if USAGE_ENABLED:
        line += f"  {DIM}·{RESET}  {usage_segment()}"
    print(line)


main()
