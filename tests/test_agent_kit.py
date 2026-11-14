import json
import os
from pathlib import Path

from conftest import git

BEGIN, END = "<!-- agent-kit:begin -->", "<!-- agent-kit:end -->"


def rules_text(env):
    return (env.kit / "rules" / "AGENTS.md").read_text()


def all_tools(env):
    for t in (".claude", ".hermes", ".codex"):
        env.tool(t)


def test_fresh_install_creates_everything(env):
    all_tools(env)
    r = env.run("install", "--no-pull")
    assert r.returncode == 0, r.stderr
    h = env.home
    for d in (".claude/skills", ".hermes/skills", ".agents/skills"):
        for n in ("alpha", "beta"):
            link = h / d / n
            assert link.is_symlink()
            assert Path(os.path.realpath(link)) == (env.kit / "skills" / n).resolve()
    agents = list((env.kit / "adapters/claude-code/agents").glob("*.md"))
    assert agents
    for a in agents:
        assert (h / ".claude/agents" / a.name).is_symlink()
    claude_md = (h / ".claude/CLAUDE.md").read_text()
    assert f"{BEGIN}\n@{env.kit}/rules/AGENTS.md\n{END}" in claude_md
    assert rules_text(env).strip() in (h / ".hermes/SOUL.md").read_text()
    assert rules_text(env).strip() in (h / ".codex/AGENTS.md").read_text()
    s = json.loads((h / ".claude/settings.json").read_text())
    assert s["env"]["CLAUDE_CODE_SUBAGENT_MODEL"] == "sonnet"
    cmd = s["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
    assert cmd == f"python3 {env.kit}/hooks/context7_reminder.py"
    assert s["statusLine"]["command"].endswith("statusline.py")
    cron = (env.fake / "crontab").read_text()
    assert cron.count("# agent-kit") == 1
    assert "17 * * * *" in cron and "sync --quiet" in cron
    assert (env.state / "manifest.json").exists()


def test_second_run_changes_nothing_and_is_silent(env):
    all_tools(env)
    env.write_sources(plugins=[{"plugin": "p", "marketplace": "m"}])
    assert env.run("install", "--no-pull").returncode == 0
    before = env.snapshot()
    r = env.run("sync", "--quiet", "--no-pull")
    assert r.returncode == 0
    assert r.stdout == "" and r.stderr == ""
    assert env.snapshot() == before
    r = env.run("sync", "--no-pull")
    assert r.stdout.count("\n") <= 1 or "link" not in r.stdout


def test_three_targets_one_directory_one_link(env):
    real = env.root / "shared-skills"
    real.mkdir()
    for t in (".claude", ".hermes"):
        env.tool(t)
        (env.home / t / "skills").symlink_to(real)
    (env.home / ".agents").mkdir()
    (env.home / ".agents" / "skills").symlink_to(real)
    r = env.run("sync", "--no-pull")
    assert r.returncode == 0, r.stderr
    assert sorted(p.name for p in real.iterdir()) == ["alpha", "beta"]
    links = [l for l in json.loads((env.state / "manifest.json").read_text())["links"] if l.endswith("/alpha")]
    assert len(links) == 1


def test_conflict_left_untouched_and_reported(env):
    env.tool(".claude")
    mine = env.home / ".claude/skills/alpha"
    mine.mkdir(parents=True)
    (mine / "SKILL.md").write_text("mine")
    r = env.run("sync", "--no-pull")
    assert r.returncode == 1
    assert "alpha" in r.stderr and "conflict" in r.stderr
    assert (mine / "SKILL.md").read_text() == "mine" and not mine.is_symlink()
    assert (env.home / ".claude/skills/beta").is_symlink()   # other steps went on


def test_foreign_symlink_is_a_conflict(env):
    env.tool(".claude")
    other = env.root / "elsewhere"
    other.mkdir()
    sk = env.home / ".claude/skills"
    sk.mkdir()
    (sk / "alpha").symlink_to(other)
    r = env.run("sync", "--no-pull")
    assert r.returncode == 1
    assert os.readlink(sk / "alpha") == str(other)


def test_adopt_backs_up_and_links(env):
    env.tool(".claude")
    mine = env.home / ".claude/skills/alpha"
    mine.mkdir(parents=True)
    (mine / "SKILL.md").write_text("mine")
    r = env.run("sync", "--no-pull", "--adopt")
    assert r.returncode == 0, r.stderr
    assert mine.is_symlink()
    backups = list((env.state / "backup").rglob("alpha/SKILL.md"))
    assert len(backups) == 1 and backups[0].read_text() == "mine"
    assert str(env.state / "backup") in r.stdout


def test_external_source_picks_up_newest(env):
    env.tool(".claude")
    url, work = env.make_source("someone", "skillrepo", {"pack/ext/SKILL.md": "v1"})
    env.write_sources([{"repo": url, "ref": "main", "skills": [{"name": "ext", "path": "pack/ext"}]}])
    r = env.run("sync", "--no-pull")
    assert r.returncode == 0, r.stderr
    link = env.home / ".claude/skills/ext"
    assert link.is_symlink() and (link / "SKILL.md").read_text() == "v1"
    assert (env.cache / "sources" / "someone__skillrepo").is_dir()
    env.commit(work, {"pack/ext/SKILL.md": "v2"})
    git(work, "push", "-q", "origin", "main")
    r = env.run("sync", "--no-pull")
    assert r.returncode == 0, r.stderr
    assert (link / "SKILL.md").read_text() == "v2"
    r = env.run("sync", "--quiet", "--no-pull")
    assert r.stdout == ""


def test_source_root_skill_and_missing_skill_md(env):
    env.tool(".claude")
    url, _ = env.make_source("o", "rootskill", {"SKILL.md": "x"})
    env.write_sources([
        {"repo": url, "ref": None, "skills": [{"name": "rooty", "path": "."}, {"name": "nope", "path": "missing"}]}])
    r = env.run("sync", "--no-pull")
    assert r.returncode == 1
    assert "nope" in r.stderr
    assert (env.home / ".claude/skills/rooty/SKILL.md").read_text() == "x"
    assert (env.home / ".claude/skills/alpha").is_symlink()


def test_block_replaced_in_place_and_outside_preserved(env):
    env.tool(".hermes")
    soul = env.home / ".hermes/SOUL.md"
    soul.write_text("# my soul\n\nbefore\n")
    assert env.run("sync", "--no-pull").returncode == 0
    text = soul.read_text()
    assert text.startswith("# my soul\n\nbefore\n\n" + BEGIN)
    soul.write_text(text + "\nafter\n")
    (env.kit / "rules/AGENTS.md").write_text("# new rules\n")
    assert env.run("sync", "--no-pull").returncode == 0
    new = soul.read_text()
    assert new.count(BEGIN) == 1
    assert "# new rules" in new and "# Working rules" not in new
    assert new.startswith("# my soul\n\nbefore\n\n" + BEGIN)
    assert new.endswith("\nafter\n")


def test_symlinked_soul_is_followed(env):
    env.tool(".hermes")
    real = env.root / "vault-soul.md"
    real.write_text("soul\n")
    (env.home / ".hermes/SOUL.md").symlink_to(real)
    assert env.run("sync", "--no-pull").returncode == 0
    assert (env.home / ".hermes/SOUL.md").is_symlink()
    assert BEGIN in real.read_text() and real.read_text().startswith("soul\n")


def test_settings_merge_preserves_existing(env):
    env.tool(".claude")
    existing = {
        "model": "opus",
        "permissions": {"allow": ["Bash(ls)"]},
        "env": {"FOO": "1"},
        "hooks": {"PostToolUse": [{"matcher": "Edit", "hooks": [
            {"type": "command", "command": "python3 /elsewhere/context7_reminder.py"}]}]},
        "statusLine": {"type": "command", "command": "mine"},
    }
    sp = env.home / ".claude/settings.json"
    sp.write_text(json.dumps(existing, indent=2) + "\n")
    assert env.run("sync", "--no-pull").returncode == 0
    s = json.loads(sp.read_text())
    assert s["model"] == "opus" and s["permissions"] == existing["permissions"]
    assert s["env"] == {"FOO": "1", "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"}
    assert len(s["hooks"]["PostToolUse"]) == 1          # no double registration
    assert s["statusLine"]["command"] == "mine"
    assert list(s)[:5] == list(existing)                # order kept
    assert (env.home / ".claude/settings.json.agent-kit.bak").read_text() == json.dumps(existing, indent=2) + "\n"
    assert sp.read_text().startswith('{\n  "model"')


def test_settings_skips_missing_script(env):
    env.tool(".claude")
    (env.kit / "hooks/context7_reminder.py").unlink()
    assert env.run("sync", "--no-pull").returncode == 0
    s = json.loads((env.home / ".claude/settings.json").read_text())
    assert "hooks" not in s and "statusLine" in s


def test_invalid_settings_json_left_alone(env):
    env.tool(".claude")
    sp = env.home / ".claude/settings.json"
    sp.write_text("{ not json")
    r = env.run("sync", "--no-pull")
    assert r.returncode == 1
    assert sp.read_text() == "{ not json"
    assert not (env.home / ".claude/settings.json.agent-kit.bak").exists()
    assert (env.home / ".claude/skills/alpha").is_symlink()


def test_removed_skill_link_is_removed(env):
    env.tool(".claude")
    assert env.run("sync", "--no-pull").returncode == 0
    import shutil
    shutil.rmtree(env.kit / "skills/beta")
    r = env.run("sync", "--no-pull")
    assert r.returncode == 0
    sk = env.home / ".claude/skills"
    assert not os.path.lexists(sk / "beta") and (sk / "alpha").is_symlink()
    assert "beta" not in json.loads((env.state / "manifest.json").read_text())["links"].__str__()


def test_wrong_kit_link_is_repointed(env):
    env.tool(".claude")
    sk = env.home / ".claude/skills"
    sk.mkdir()
    (sk / "alpha").symlink_to(env.kit / "skills" / "beta")
    assert env.run("sync", "--no-pull").returncode == 0
    assert Path(os.path.realpath(sk / "alpha")) == (env.kit / "skills/alpha").resolve()


def test_uninstall_restores_state(env):
    all_tools(env)
    env.tool(".claude")
    sp = env.home / ".claude/settings.json"
    orig = {"model": "opus", "env": {"FOO": "1"}}
    sp.write_text(json.dumps(orig, indent=2) + "\n")
    (env.home / ".codex/AGENTS.md").write_text("mine\n")
    (env.fake / "crontab").write_text("0 0 * * * other\n")
    env.write_sources(plugins=[{"plugin": "p", "marketplace": "m"}])
    assert env.run("install", "--no-pull").returncode == 0
    r = env.run("uninstall")
    assert r.returncode == 0, r.stderr
    assert json.loads(sp.read_text()) == orig
    assert (env.home / ".codex/AGENTS.md").read_text() == "mine\n"
    assert not (env.home / ".claude/CLAUDE.md").exists()
    assert not (env.home / ".hermes/SOUL.md").exists()
    for d in (".claude/skills", ".hermes/skills", ".agents/skills", ".claude/agents"):
        assert not any(p.is_symlink() for p in (env.home / d).glob("*"))
    assert (env.fake / "crontab").read_text() == "0 0 * * * other\n"
    assert env.kit.exists()


def test_unknown_schema_refused(env):
    env.tool(".claude")
    (env.kit / "sources.json").write_text('{"schema": 99, "sources": []}')
    r = env.run("sync", "--no-pull")
    assert r.returncode == 1 and "schema" in r.stderr
    assert (env.home / ".claude/skills/alpha").is_symlink()


def test_dry_run_writes_nothing(env):
    all_tools(env)
    url, _ = env.make_source("o", "r", {"SKILL.md": "x"})
    env.write_sources([{"repo": url, "ref": "main", "skills": [{"name": "r", "path": "."}]}],
                      plugins=[{"plugin": "p", "marketplace": "m"}])
    before = env.snapshot()
    r = env.run("install", "--no-pull", "--dry-run")
    assert r.returncode == 0, r.stderr
    assert env.snapshot() == before
    assert "would" in r.stdout


def test_doctor(env):
    all_tools(env)
    r = env.run("doctor")
    assert r.returncode == 1                      # nothing installed yet
    env.run("install", "--no-pull")
    r = env.run("doctor")
    assert r.returncode == 0, r.stdout + r.stderr
    (env.kit / "rules/AGENTS.md").write_text("changed\n")
    r = env.run("doctor")
    assert r.returncode == 1 and "stale" in r.stdout


def test_plugin_installed_when_absent(env):
    env.tool(".claude")
    env.write_sources(plugins=[{"plugin": "p", "marketplace": "m"}])
    assert env.run("sync", "--no-pull").returncode == 0
    log = (env.fake / "claude.log").read_text()
    assert "plugin install p@m" in log
    env.run("sync", "--no-pull")
    assert (env.fake / "claude.log").read_text().count("plugin install") == 1


def test_no_timer_flag_and_existing_line(env):
    env.tool(".claude")
    env.run("install", "--no-pull", "--no-timer")
    assert not (env.fake / "crontab").exists()
    (env.fake / "crontab").write_text("1 1 * * * x # agent-kit\n")
    env.run("install", "--no-pull")
    assert (env.fake / "crontab").read_text() == "1 1 * * * x # agent-kit\n"


# ---------------------------------------------------------------- review round

import fcntl
import importlib.util
import shutil
import shlex

from conftest import REPO


def load_module():
    from importlib.machinery import SourceFileLoader
    loader = SourceFileLoader("agent_kit_mod", str(REPO / "bin" / "agent-kit"))
    spec = importlib.util.spec_from_loader("agent_kit_mod", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def ext_source(env, ref="main"):
    url, work = env.make_source("o", "r", {"SKILL.md": "x"})
    env.write_sources([{"repo": url, "ref": ref, "skills": [{"name": "r", "path": "."}]}])
    return url, work


def test_f1_broken_mirror_does_not_touch_enclosing_repo(env):
    env.tool(".claude")
    url, _ = ext_source(env)
    outer = env.root / "outer"
    outer.mkdir()
    git(outer, "init", "-q", "-b", "main")
    (outer / "f.txt").write_text("committed\n")
    git(outer, "add", "-A")
    git(outer, "commit", "-q", "-m", "c")
    git(outer, "remote", "add", "origin", url)
    (outer / "f.txt").write_text("uncommitted work\n")
    cache = outer / "cache"
    # a mirror the kit cloned earlier whose .git has since been broken
    (cache / "sources" / "o__r" / ".git").mkdir(parents=True)
    (cache / "sources" / "o__r" / ".git" / "agent-kit-mirror").write_text("")
    r = env.run("sync", "--no-pull", env={"AGENT_KIT_CACHE": str(cache)})
    assert r.returncode == 0, r.stderr
    assert (cache / "sources" / "o__r" / ".git" / "agent-kit-mirror").is_file()
    assert (outer / "f.txt").read_text() == "uncommitted work\n"
    assert (env.home / ".claude/skills/r/SKILL.md").read_text() == "x"


def test_f2_unpaired_begin_marker_refused(env):
    env.tool(".hermes")
    soul = env.home / ".hermes/SOUL.md"
    original = f"top\n{BEGIN}\nmy own text without an end\n"
    soul.write_text(original)
    r = env.run("sync", "--no-pull")
    assert r.returncode == 1 and "SOUL.md" in r.stderr
    assert soul.read_text() == original
    assert "SOUL.md" in env.run("doctor").stdout


def test_f2_bad_marker_arrangements_and_uninstall(env):
    env.tool(".hermes")
    soul = env.home / ".hermes/SOUL.md"
    assert env.run("sync", "--no-pull").returncode == 0
    for bad in (f"{END}\nx\n{BEGIN}\n", f"{BEGIN}\na\n{END}\n{BEGIN}\nb\n{END}\n", f"x\n{END}\n"):
        soul.write_text(bad)
        r = env.run("sync", "--no-pull")
        assert r.returncode == 1 and soul.read_text() == bad
        r = env.run("uninstall")
        assert r.returncode == 1 and soul.read_text() == bad
        # restore a clean file for the next round
        soul.write_text("")
        assert env.run("sync", "--no-pull").returncode == 0


def test_f2_rules_text_containing_marker_refused(env):
    env.tool(".hermes")
    (env.kit / "rules/AGENTS.md").write_text(f"rules {END} oops\n")
    r = env.run("sync", "--no-pull")
    assert r.returncode == 1
    assert not (env.home / ".hermes/SOUL.md").exists()


def test_f3_crontab_read_failure_writes_nothing(env):
    env.tool(".claude")
    (env.fake / "crontab").write_text("0 0 * * * keep me\n")
    r = env.run("install", "--no-pull", env={"FAKE_CRON_FAIL": "1"})
    assert r.returncode == 1
    assert (env.fake / "crontab").read_text() == "0 0 * * * keep me\n"


def test_f3_existing_lines_preserved_on_write(env):
    env.tool(".claude")
    (env.fake / "crontab").write_text("0 0 * * * keep me\n# comment\n")
    assert env.run("install", "--no-pull").returncode == 0
    lines = (env.fake / "crontab").read_text().splitlines()
    assert lines[:2] == ["0 0 * * * keep me", "# comment"] and "# agent-kit" in lines[2]


def test_f4_uninstall_leaves_foreign_link(env):
    env.tool(".claude")
    assert env.run("install", "--no-pull").returncode == 0
    foreign = env.root / "foreign"
    foreign.mkdir()
    link = env.home / ".claude/skills/alpha"
    link.unlink()
    link.symlink_to(foreign)
    r = env.run("uninstall")
    assert r.returncode == 0
    assert os.readlink(link) == str(foreign)
    assert "alpha" in r.stdout
    assert not (env.home / ".claude/skills/beta").exists()


def test_f4_missing_or_bad_manifest_removes_nothing(env):
    env.tool(".claude")
    assert env.run("install", "--no-pull").returncode == 0
    m = env.state / "manifest.json"
    m.write_text("{ nope")
    r = env.run("uninstall")
    assert r.returncode == 1
    assert (env.home / ".claude/skills/alpha").is_symlink()
    m.unlink()
    r = env.run("uninstall")
    assert "manifest" in r.stdout
    assert (env.home / ".claude/skills/alpha").is_symlink()
    assert "# agent-kit" in (env.fake / "crontab").read_text()


def test_f5_lock_held_skips_run(env):
    env.tool(".claude")
    env.state.mkdir(parents=True)
    with open(env.state / "lock", "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        r = env.run("sync", "--no-pull")
        assert r.returncode == 0 and "in progress" in r.stdout
        q = env.run("sync", "--no-pull", "--quiet")
        assert q.returncode == 0 and q.stdout == "" and q.stderr == ""
    assert not (env.home / ".claude/skills/alpha").exists()


def test_f5_subprocess_timeout_is_an_error_line_and_run_continues(env):
    env.tool(".claude")
    env.write_sources(plugins=[{"plugin": "p", "marketplace": "m"}])
    r = env.run("sync", "--no-pull", env={"FAKE_CLAUDE_SLEEP": "20", "AGENT_KIT_TIMEOUT": "1"})
    assert r.returncode == 1 and "timed out" in r.stderr
    assert (env.home / ".claude/skills/alpha").is_symlink()


def test_f5_make_link_tolerates_existing(env, tmp_path):
    mod = load_module()
    target, other = tmp_path / "t", tmp_path / "o"
    target.mkdir()
    other.mkdir()
    link = tmp_path / "l" / "x"
    mod.make_link(link, target)
    mod.make_link(link, target)
    os.symlink(str(other), str(link) + "2")
    mod.make_link(Path(str(link) + "2"), target)
    assert os.readlink(str(link) + "2") == str(target)


def test_f8_absolute_and_escaping_skill_paths_rejected(env):
    env.tool(".claude")
    url, work = env.make_source("o", "r", {"pack/ok/SKILL.md": "x"})
    outside = env.root / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text("evil")
    os.symlink(str(outside), work / "pack" / "evil")
    env.commit(work, {"pack/touch": "t"})
    git(work, "push", "-q", "origin", "main")
    env.write_sources([{"repo": url, "ref": "main", "skills": [
        {"name": "abs", "path": str(outside)}, {"name": "dots", "path": "../x"},
        {"name": "evil", "path": "pack/evil"}, {"name": "ok", "path": "pack/ok"}]}])
    r = env.run("sync", "--no-pull")
    assert r.returncode == 1
    sk = env.home / ".claude/skills"
    assert not os.path.lexists(sk / "abs") and not os.path.lexists(sk / "dots")
    assert not os.path.lexists(sk / "evil")
    assert (sk / "ok").is_symlink()


def test_f9_kit_path_with_space(env_space):
    env = env_space
    env.tool(".claude")
    assert env.run("install", "--no-pull").returncode == 0
    s = json.loads((env.home / ".claude/settings.json").read_text())
    hook = s["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
    assert shlex.split(hook) == ["python3", f"{env.kit}/hooks/context7_reminder.py"]
    assert shlex.split(s["statusLine"]["command"])[1] == f"{env.kit}/adapters/claude-code/statusline.py"
    cron = (env.fake / "crontab").read_text()
    assert shlex.split(cron.split("#")[0])[5] == f"{env.kit}/bin/agent-kit"
    before = (env.home / ".claude/settings.json").read_text()
    assert env.run("sync", "--no-pull").returncode == 0
    assert (env.home / ".claude/settings.json").read_text() == before


def test_f11_source_validation(env):
    env.tool(".claude")
    for repo, ref in (("http://example.invalid/o/r.git", "main"),
                      ("-oupload-pack=x", "main"),
                      ("https://example.invalid/o/r.git", "--upload-pack=x")):
        env.write_sources([{"repo": repo, "ref": ref, "skills": [{"name": "s", "path": "."}]}])
        r = env.run("sync", "--no-pull", env={"AGENT_KIT_ALLOW_LOCAL_SOURCES": ""})
        assert r.returncode == 1, repo
    url, _ = ext_source(env)
    r = env.run("sync", "--no-pull", env={"AGENT_KIT_ALLOW_LOCAL_SOURCES": ""})
    assert r.returncode == 1 and not (env.home / ".claude/skills/r").exists()


def test_f12_failed_sources_do_not_prune_external_links(env):
    env.tool(".claude")
    url, _ = ext_source(env)
    assert env.run("sync", "--no-pull").returncode == 0
    link = env.home / ".claude/skills/r"
    assert link.is_symlink()
    (env.kit / "sources.json").write_text('{"schema": 99}')
    assert env.run("sync", "--no-pull").returncode == 1
    assert link.is_symlink() and (link / "SKILL.md").exists()
    env.write_sources([{"repo": url, "ref": "main", "skills": [{"name": "r", "path": "."}]}])
    shutil.rmtree(url)                               # remote gone: fetch fails
    r = env.run("sync", "--no-pull")
    assert r.returncode == 1
    assert link.is_symlink() and (link / "SKILL.md").exists()


def test_f14_uninstall_quiet_prints_nothing(env):
    env.tool(".claude")
    assert env.run("install", "--no-pull").returncode == 0
    r = env.run("uninstall", "--quiet")
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""


def test_foreign_directory_at_mirror_path_is_not_removed(env):
    # <cache>/sources may be a link into foreign ground: a plain directory that
    # merely has the mirror's name is someone else's and must survive.
    env.tool(".claude")
    ext_source(env)
    elsewhere = env.root / "elsewhere"
    (elsewhere / "o__r").mkdir(parents=True)
    (elsewhere / "o__r" / "precious.txt").write_text("keep me\n")
    cache = env.root / "cache2"
    cache.mkdir()
    (cache / "sources").symlink_to(elsewhere)
    r = env.run("sync", "--no-pull", env={"AGENT_KIT_CACHE": str(cache)})
    assert r.returncode == 1
    assert "not a mirror the kit cloned" in r.stderr
    assert (elsewhere / "o__r" / "precious.txt").read_text() == "keep me\n"


def test_foreign_git_repository_at_mirror_path_is_not_removed(env):
    # Someone's real repository that merely has the mirror's name, reached
    # through a symlinked sources directory: it has a .git but not the kit's marker.
    env.tool(".claude")
    ext_source(env)
    elsewhere = env.root / "elsewhere"
    repo = elsewhere / "o__r"
    repo.mkdir(parents=True)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "remote", "add", "origin", "https://example.com/other/repo.git")
    (repo / "precious.txt").write_text("uncommitted\n")
    cache = env.root / "cache3"
    cache.mkdir()
    (cache / "sources").symlink_to(elsewhere)
    r = env.run("sync", "--no-pull", env={"AGENT_KIT_CACHE": str(cache)})
    assert r.returncode == 1
    assert "not a mirror the kit cloned" in r.stderr
    assert (repo / "precious.txt").read_text() == "uncommitted\n"
    assert (repo / ".git").is_dir()


def test_failed_clone_leaves_no_partial_mirror(env):
    env.tool(".claude")
    env.write_sources([{"repo": str(env.root / "does-not-exist.git"), "ref": "main",
                        "skills": [{"name": "r", "path": "."}]}])
    r = env.run("sync", "--no-pull")
    assert r.returncode == 1
    sources = env.cache / "sources"
    assert not sources.exists() or list(sources.iterdir()) == []
