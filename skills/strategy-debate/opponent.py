#!/usr/bin/env python3
"""Opponent selection state for the strategy-debate skill. Standard library only.

  opponent.py detect                          agent CLIs on PATH and the vendor each reaches
  opponent.py get [--own-vendor V]            the stored opponent (JSON)
  opponent.py set --cli C [--model M] [--vendor V] [--own-vendor V]
  opponent.py reset                           forget the stored opponent

State file: ${AGENT_KIT_CONFIG:-$HOME/.config/agent-kit}/debate-opponent.json
Every command prints one JSON object. Exit 2 on usage errors or a same-vendor opponent.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

KNOWN = ["claude", "codex", "gemini", "hermes", "opencode"]
FIXED_VENDOR = {"claude": "Anthropic", "codex": "OpenAI", "gemini": "Google"}
VENDOR_HINTS = [
    ("Anthropic", ("claude", "anthropic")),
    ("OpenAI", ("gpt", "openai", "codex", "chatgpt")),
    ("Google", ("gemini", "google")),
    ("DeepSeek", ("deepseek",)),
    ("xAI", ("grok", "xai")),
    ("Moonshot", ("kimi", "moonshot")),
    ("Zhipu", ("glm", "zai", "z.ai")),
    ("Alibaba", ("qwen", "alibaba")),
    ("Mistral", ("mistral",)),
    ("Meta", ("llama",)),
    ("MiniMax", ("minimax",)),
]


def config_dir():
    return os.environ.get("AGENT_KIT_CONFIG") or os.path.join(os.path.expanduser("~"), ".config", "agent-kit")


def state_path():
    return os.path.join(config_dir(), "debate-opponent.json")


def vendor_of(*texts):
    """First vendor whose hint occurs in the first non-empty text that matches any."""
    for text in texts:
        low = (text or "").lower()
        for vendor, hints in VENDOR_HINTS:
            if any(h in low for h in hints):
                return vendor
    return None


def run_text(cmd):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL)
        return r.stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def probe(cli):
    """Return (model, vendor) the CLI would reach with its current configuration."""
    if cli in FIXED_VENDOR:
        return None, FIXED_VENDOR[cli]
    if cli == "hermes":
        fields = {}
        for line in run_text(["hermes", "config", "get", "model"]).splitlines():
            key, _, val = line.partition(":")
            fields[key.strip()] = val.strip()
        model = fields.get("default") or None
        return model, vendor_of(model, fields.get("provider"))
    if cli == "opencode":
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
        try:
            with open(os.path.join(base, "opencode", "opencode.json"), encoding="utf-8") as fh:
                model = json.load(fh).get("model")
        except (OSError, ValueError, AttributeError):
            model = None
        return model, vendor_of(model)
    return None, None


def emit(obj, code=0):
    print(json.dumps(obj))
    return code


def cmd_detect(args):
    out = []
    for cli in KNOWN:
        path = shutil.which(cli)
        if path:
            model, vendor = probe(cli)
            out.append({"cli": cli, "model": model, "vendor": vendor})
    return emit({"available": out})


def read_state():
    try:
        with open(state_path(), encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict) or "cli" not in data:
            raise ValueError
        return data, None
    except FileNotFoundError:
        return None, None
    except (OSError, ValueError):
        return None, "unreadable state file"


def same(a, b):
    return bool(a) and bool(b) and a.strip().lower() == b.strip().lower()


def cmd_get(args):
    data, err = read_state()
    if err:
        return emit({"configured": False, "error": err})
    if data is None:
        return emit({"configured": False})
    data = dict(data, configured=True)
    if args.own_vendor:
        data["same_vendor"] = same(data.get("vendor"), args.own_vendor)
    return emit(data)


def cmd_set(args):
    if args.cli not in KNOWN:
        return emit({"error": "unknown cli; expected one of " + ", ".join(KNOWN)}, 2)
    probed_model, probed_vendor = probe(args.cli)
    vendor = args.vendor or probed_vendor
    if not vendor:
        return emit({"error": "vendor not resolvable; pass --vendor"}, 2)
    if same(vendor, args.own_vendor):
        return emit({"error": "opponent vendor equals own vendor", "vendor": vendor}, 2)
    state = {"cli": args.cli, "model": args.model, "vendor": vendor}
    os.makedirs(config_dir(), exist_ok=True)
    with open(state_path(), "w", encoding="utf-8") as fh:
        json.dump(state, fh)
        fh.write("\n")
    return emit(dict(state, configured=True))


def cmd_reset(args):
    try:
        os.remove(state_path())
        return emit({"removed": True})
    except FileNotFoundError:
        return emit({"removed": False})


def main(argv):
    p = argparse.ArgumentParser(prog="opponent.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("detect").set_defaults(fn=cmd_detect)
    g = sub.add_parser("get")
    g.add_argument("--own-vendor")
    g.set_defaults(fn=cmd_get)
    s = sub.add_parser("set")
    s.add_argument("--cli", required=True)
    s.add_argument("--model")
    s.add_argument("--vendor")
    s.add_argument("--own-vendor")
    s.set_defaults(fn=cmd_set)
    sub.add_parser("reset").set_defaults(fn=cmd_reset)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
