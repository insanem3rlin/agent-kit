"""Windows-only behaviour the POSIX suite cannot reach: directory links,
UTF-8 file handling, the interpreter in hook commands, re-pointing, locking."""
import json
import os
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows only")


def test_install_and_uninstall_on_windows(env):
    env.tool(".claude")
    env.tool(".codex")
    (env.home / ".codex/AGENTS.md").write_text("Grüße — mine\n", encoding="utf-8")
    r = env.run("install", "--no-timer", "--no-pull")
    assert r.returncode == 0, r.stdout + r.stderr

    link = env.home / ".claude/skills/alpha"
    assert link.is_symlink() and (link / "SKILL.md").is_file()     # a usable directory link
    assert (env.home / ".agents/skills/alpha/SKILL.md").is_file()
    claude_md = (env.home / ".claude/CLAUDE.md").read_text(encoding="utf-8")
    assert "@" + (env.kit / "rules/AGENTS.md").as_posix() in claude_md
    codex = (env.home / ".codex/AGENTS.md").read_bytes().decode("utf-8")
    assert codex.startswith("Grüße — mine\n") and "\r\n" not in codex
    settings = json.loads((env.home / ".claude/settings.json").read_text(encoding="utf-8"))
    hook = settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
    assert hook.startswith(Path(sys.executable).as_posix() + " ")

    r = env.run("uninstall")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not os.path.lexists(link)
    assert (env.home / ".codex/AGENTS.md").read_text(encoding="utf-8") == "Grüße — mine\n"


def test_stale_directory_link_is_repointed(env):
    env.tool(".claude")
    sk = env.home / ".claude/skills"
    sk.mkdir()
    os.symlink(env.kit / "skills/beta", sk / "alpha", target_is_directory=True)
    r = env.run("sync", "--no-pull")
    assert r.returncode == 0, r.stdout + r.stderr
    assert os.path.realpath(sk / "alpha") == os.path.realpath(env.kit / "skills/alpha")


def test_concurrent_run_is_skipped(env):
    import msvcrt
    env.tool(".claude")
    env.state.mkdir()
    with open(env.state / "lock", "a") as f:
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        r = env.run("sync", "--no-pull")
    assert r.returncode == 0 and "in progress" in r.stdout
    assert not (env.home / ".claude/skills/alpha").exists()
