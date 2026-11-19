"""`agent-kit afk` launcher and the doctor's Node/Docker report."""
import shutil
import sys

import pytest

from conftest import REPO

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def with_engine(env):
    """Give the fake kit the engine sources and an 'installed' node_modules."""
    shutil.copytree(REPO / "afk" / "src", env.kit / "afk" / "src")
    (env.kit / "afk" / "node_modules").mkdir()
    return env


@needs_node
def test_afk_launches_the_engine(env):
    r = with_engine(env).run("afk", "--help")
    assert r.returncode == 0, r.stderr
    assert "Run the AFK daemon in the current repository" in r.stdout


@needs_node
def test_afk_passes_the_engine_exit_code_through(env):
    r = with_engine(env).run("afk")
    assert r.returncode == 1
    assert "not implemented" in r.stdout


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
