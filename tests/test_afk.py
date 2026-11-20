"""`agent-kit afk` launcher and the doctor's Node/Docker report."""
import hashlib
import importlib.machinery
import importlib.util
import shutil
import sys
import types

import pytest

from conftest import REPO

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def lock_stamp(afk):
    return hashlib.sha256((afk / "package-lock.json").read_bytes()).hexdigest()


def with_engine(env, installed=True):
    """Give the fake kit the engine sources, its lockfile and (by default) an
    install stamped as complete."""
    afk = env.kit / "afk"
    shutil.copytree(REPO / "afk" / "src", afk / "src")
    shutil.copy(REPO / "afk" / "package-lock.json", afk / "package-lock.json")
    if installed:
        (afk / "node_modules").mkdir()
        (afk / "node_modules" / ".agent-kit-stamp").write_text(lock_stamp(afk) + "\n")
    return env


def fake_npm(env):
    """An `npm` that logs its arguments and creates node_modules, or fails with FAKE_NPM_FAIL."""
    if sys.platform == "win32":
        lines = ['@echo %* >> "%FAKE_STATE%\\npm.log"',
                 "@if not exist node_modules mkdir node_modules",
                 "@if defined FAKE_NPM_FAIL exit /b 1", "@exit /b 0"]
        (env.bin / "npm.cmd").write_text("\r\n".join(lines) + "\r\n")
    else:
        lines = ["#!/bin/sh", 'echo "$@" >> "$FAKE_STATE/npm.log"', "mkdir -p node_modules",
                 '[ -n "$FAKE_NPM_FAIL" ] && exit 1', "exit 0"]
        p = env.bin / "npm"
        p.write_text("\n".join(lines) + "\n")
        p.chmod(0o755)
    return env


def npm_calls(env):
    log = env.fake / "npm.log"
    return log.read_text().split() if log.exists() else []


def load_cli():
    loader = importlib.machinery.SourceFileLoader("agent_kit_cli", str(REPO / "bin" / "agent-kit"))
    mod = types.ModuleType(loader.name)
    loader.exec_module(mod)
    return mod


@needs_node
def test_afk_launches_the_engine(env):
    r = with_engine(env).run("afk", "--help")
    assert r.returncode == 0, r.stderr
    assert "Run the AFK daemon in the current repository" in r.stdout


@needs_node
def test_afk_passes_the_engine_exit_code_through(env):
    # Run outside any configured repository, the daemon fails at startup with one line on stderr.
    r = with_engine(env).run("afk")
    assert r.returncode == 1
    assert "agent-kit afk:" in r.stderr


@needs_node
def test_afk_works_after_a_global_quiet_flag(env):
    r = with_engine(env).run("--quiet", "afk", "--help")
    assert r.returncode == 0, r.stderr
    assert "Run the AFK daemon in the current repository" in r.stdout
    assert not (env.state / "lock").exists()


@pytest.mark.parametrize("flags", [["--dry-run"], ["--quiet", "--dry-run"]])
def test_afk_refuses_dry_run_instead_of_running_for_real(env, flags):
    fake_npm(with_engine(env, installed=False))
    r = env.run(*flags, "afk")
    assert r.returncode == 2
    assert "--dry-run" in r.stderr
    assert npm_calls(env) == []


@pytest.mark.parametrize("code, interrupted, expected", [
    (3, False, 3), (0, False, 0), (0, True, 130), (3, True, 3),
    (-2, True, 130), (-15, False, 143),
])
def test_afk_exit_code_maps_signal_deaths_to_shell_codes(code, interrupted, expected):
    assert load_cli().afk_exit_code(code, interrupted) == expected


@needs_node
def test_afk_installs_when_node_modules_is_missing(env):
    r = fake_npm(with_engine(env, installed=False)).run("afk", "--help")
    assert r.returncode == 0, r.stderr
    assert npm_calls(env) == ["ci"]
    assert (env.kit / "afk" / "node_modules" / ".agent-kit-stamp").read_text().strip() ==         lock_stamp(env.kit / "afk")


@needs_node
def test_afk_does_not_reinstall_a_current_install(env):
    fake_npm(with_engine(env)).run("afk", "--help")
    assert npm_calls(env) == []


@needs_node
def test_afk_reinstalls_when_the_lockfile_changed(env):
    with_engine(env)
    with open(env.kit / "afk" / "package-lock.json", "a") as f:
        f.write("\n")
    assert fake_npm(env).run("afk", "--help").returncode == 0
    assert npm_calls(env) == ["ci"]


@needs_node
def test_afk_reinstalls_a_partial_install(env):
    with_engine(env)
    (env.kit / "afk" / "node_modules" / ".agent-kit-stamp").unlink()   # npm ci never finished
    assert fake_npm(env).run("afk", "--help").returncode == 0
    assert npm_calls(env) == ["ci"]


@needs_node
def test_a_failed_install_leaves_no_stamp_and_stops(env):
    fake_npm(with_engine(env, installed=False))
    r = env.run("afk", "--help", env={"FAKE_NPM_FAIL": "1"})
    assert r.returncode == 1 and "npm ci failed" in r.stderr
    assert not (env.kit / "afk" / "node_modules" / ".agent-kit-stamp").exists()
    assert env.run("afk", "--help").returncode == 0      # next run repairs it
    assert npm_calls(env) == ["ci", "ci"]


def test_ctrl_c_waits_for_the_child_and_reports_its_code():
    class Child:
        calls = 0

        def wait(self):
            self.calls += 1
            if self.calls < 3:
                raise KeyboardInterrupt
            return 3

    child = Child()
    assert load_cli().wait_through_interrupt(child) == (3, True)
    assert child.calls == 3


def test_afk_without_node_says_what_to_install(env):
    r = with_engine(env).run("afk", env={"PATH": str(env.bin)})
    assert r.returncode == 1
    assert "Node" in r.stderr and "22.18" in r.stderr


def test_afk_does_not_take_the_sync_lock(env):
    with_engine(env).run("afk", "--help")
    assert not (env.state / "lock").exists()


def test_doctor_reports_node_and_docker(env):
    out = env.run("doctor").stdout
    assert "afk:" in out
    assert "node" in out and "docker" in out


def test_doctor_names_a_missing_node_without_failing_on_it(env):
    r = env.run("doctor", env={"PATH": str(env.bin)})
    assert "node: not found" in r.stdout
    assert "docker: not found" in r.stdout
    assert "PROBLEM node" not in r.stdout
