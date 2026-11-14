import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent

GIT_ENV = {
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
}

FAKE_CLAUDE = """#!/bin/sh
echo "$@" >> "$FAKE_STATE/claude.log"
if [ -n "$FAKE_CLAUDE_SLEEP" ]; then exec sleep "$FAKE_CLAUDE_SLEEP"; fi
if [ "$1 $2" = "plugin list" ]; then cat "$FAKE_STATE/plugins" 2>/dev/null; exit 0; fi
if [ "$1 $2" = "plugin install" ]; then echo "$3" >> "$FAKE_STATE/plugins"; exit 0; fi
exit 0
"""

FAKE_CRONTAB = """#!/bin/sh
f="$FAKE_STATE/crontab"
if [ -n "$FAKE_CRON_FAIL" ] && [ "$1" = "-l" ]; then echo "crontab: permission denied" >&2; exit 1; fi
if [ "$1" = "-l" ]; then
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  echo "no crontab for user" >&2; exit 1
fi
if [ "$1" = "-" ]; then cat > "$f"; exit 0; fi
exit 2
"""


def git(cwd, *args):
    env = dict(os.environ, **GIT_ENV)
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True,
                          capture_output=True, text=True).stdout.strip()


class Env:
    """A fake machine: HOME, kit checkout, fake claude/crontab on PATH."""

    def __init__(self, root, kitname="kit"):
        self.root = root
        self.home = root / "home"
        self.kit = root / kitname
        self.config = root / "config"
        self.cache = root / "cache"
        self.state = root / "state"
        self.fake = root / "fake"          # FAKE_STATE for the fake executables
        self.bin = root / "fakebin"
        for d in (self.home, self.fake, self.bin):
            d.mkdir()
        for name, body in (("claude", FAKE_CLAUDE), ("crontab", FAKE_CRONTAB)):
            p = self.bin / name
            p.write_text(body)
            p.chmod(0o755)
        self._make_kit()

    def _make_kit(self):
        kit = self.kit
        (kit / "bin").mkdir(parents=True)
        shutil.copy(REPO / "bin" / "agent-kit", kit / "bin" / "agent-kit") if (REPO / "bin" / "agent-kit").exists() else None
        shutil.copytree(REPO / "rules", kit / "rules")
        shutil.copytree(REPO / "adapters", kit / "adapters")
        (kit / "hooks").mkdir()
        (kit / "hooks" / "context7_reminder.py").write_text("# hook\n")
        (kit / "adapters" / "claude-code" / "statusline.py").write_text("# status\n")
        (kit / "skills").mkdir()
        self.add_skill("alpha")
        self.add_skill("beta")
        (kit / "sources.json").write_text('{"schema": 1, "sources": [], "claude_plugins": []}')

    def add_skill(self, name):
        d = self.kit / "skills" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(f"---\nname: {name}\n---\n")

    def tool(self, name):
        (self.home / name).mkdir(exist_ok=True)

    def cli_path(self):
        return REPO / "bin" / "agent-kit"

    def run(self, *args, env=None):
        e = dict(os.environ, **GIT_ENV)
        e.update(
            # USERPROFILE: Path.home() reads it, not HOME, on Windows.
            HOME=str(self.home), USERPROFILE=str(self.home), AGENT_KIT_HOME=str(self.kit),
            AGENT_KIT_CONFIG=str(self.config), AGENT_KIT_CACHE=str(self.cache),
            AGENT_KIT_STATE=str(self.state), AGENT_KIT_ALLOW_LOCAL_SOURCES="1", FAKE_STATE=str(self.fake),
            PATH=f"{self.bin}{os.pathsep}{os.environ['PATH']}",
        )
        e.update(env or {})
        return subprocess.run([sys.executable, str(self.cli_path()), *args],
                              env=e, capture_output=True, text=True)

    def snapshot(self):
        """Every path under home/state/cache/fake with its type and content."""
        out = {}
        for base in (self.home, self.state, self.cache, self.config, self.fake):
            for p in sorted(base.rglob("*")):
                if p.name == "claude.log":      # read-only `plugin list` calls are logged
                    continue
                if p.is_symlink():
                    out[str(p)] = ("link", os.readlink(p))
                elif p.is_file():
                    out[str(p)] = ("file", p.read_bytes())
                else:
                    out[str(p)] = ("dir", None)
        return out

    def make_source(self, owner, repo, files):
        """A local bare repo usable as an external source; returns (url, work)."""
        work = self.root / "work" / repo
        work.mkdir(parents=True)
        git(work, "init", "-q", "-b", "main")
        self.commit(work, files)
        bare = self.root / "remotes" / owner / f"{repo}.git"
        bare.parent.mkdir(parents=True)
        git(self.root, "clone", "-q", "--bare", str(work), str(bare))
        git(work, "remote", "add", "origin", str(bare))
        return str(bare), work

    def commit(self, work, files):
        for rel, text in files.items():
            p = work / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", "c")

    def write_sources(self, sources=(), plugins=()):
        import json
        (self.kit / "sources.json").write_text(json.dumps(
            {"schema": 1, "sources": list(sources), "claude_plugins": list(plugins)}))


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


@pytest.fixture
def env_space(tmp_path):
    return Env(tmp_path, kitname="my kit")
