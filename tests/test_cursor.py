"""The Cursor adapter."""

from conftest import REPO

AGENTS = ("implementer", "researcher", "reviewer")


def front(path):
    _, head, body = path.read_text(encoding="utf-8").split("---\n", 2)
    keys = dict(l.split(": ", 1) for l in head.splitlines() if ": " in l)
    return keys, body.strip()


def test_agents_say_what_the_claude_agents_say():
    for name in AGENTS:
        _, body = front(REPO / f"adapters/claude-code/agents/{name}.md")
        keys, mine = front(REPO / f"adapters/cursor/agents/{name}.md")
        assert keys["name"] == name and keys["description"] and keys["model"]
        assert mine == body
        assert keys.get("readonly") == ("true" if name == "researcher" else "false")


def test_cursor_install(env):
    env.tool(".cursor")
    r = env.run("install", "--no-pull")
    assert r.returncode == 0, r.stdout + r.stderr
    assert (env.home / ".agents/skills/alpha").is_symlink()
    for name in AGENTS:
        assert (env.home / f".cursor/agents/{name}.md").is_symlink()
    # Cursor runs the Claude Code hooks itself and has no rules file on disk
    assert sorted(p.name for p in (env.home / ".cursor").iterdir()) == ["agents"]
    assert env.run("uninstall").returncode == 0
    assert not any(p.is_symlink() for p in (env.home / ".cursor/agents").glob("*"))
