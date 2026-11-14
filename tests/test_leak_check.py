"""Tests for scripts/leak-check. Each test builds a throwaway git repo and runs the script."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "leak-check"

# Secret-shaped strings are assembled at runtime so this file never holds a literal one.
PRIVATE_KEY = "-----BEGIN " + "RSA PRIVATE KEY-----"
SK_KEY = "sk" + "-" + "a1B2c3D4e5F6g7H8i9J0k1L2"
GH_TOKEN = "ghp" + "_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
GH_PAT = "github" + "_pat_" + "a1B2c3D4e5F6g7H8i9J0k1L2"
AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP"
ASSIGN = "API_" + "TOKEN" + " = 'abcd1234efgh5678ijkl'"
HOME_PATH = "/home/" + "alice" + "/project/file"
MAC_PATH = "/Users/" + "alice" + "/Library"
EMAIL = "alice" + "@" + "corp.io"


class Repo:
    def __init__(self, tmp_path):
        self.root = tmp_path / "repo"
        self.root.mkdir()
        self.cfg = tmp_path / "cfg"
        self.home = tmp_path / "home"
        self.home.mkdir()
        self.git("init", "-q")

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def write(self, rel, content, mode="w"):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if "b" in mode:
            p.write_bytes(content)
        else:
            p.write_text(content)
        return p

    def blocklist(self, text):
        self.cfg.mkdir(exist_ok=True)
        (self.cfg / "blocklist.txt").write_text(text)

    def run(self, *args, env=None):
        e = {k: v for k, v in os.environ.items() if k not in ("AGENT_KIT_BLOCKLIST", "AGENT_KIT_CONFIG")}
        e["AGENT_KIT_CONFIG"] = str(self.cfg)
        e["HOME"] = str(self.home)
        e.update(env or {})
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args], cwd=self.root, env=e, capture_output=True, text=True
        )


@pytest.fixture
def repo(tmp_path):
    return Repo(tmp_path)


@pytest.mark.parametrize(
    "content,rule",
    [
        (PRIVATE_KEY, "private-key"),
        ("key = " + SK_KEY, "openai-key"),
        ("x " + GH_TOKEN, "github-token"),
        ("x " + GH_PAT, "github-token"),
        ("id " + AWS_KEY, "aws-key"),
        (ASSIGN, "secret-assignment"),
        ("cd " + HOME_PATH, "home-path"),
        ("cd " + MAC_PATH, "home-path"),
        ("mail " + EMAIL, "email"),
    ],
)
def test_builtin_pattern_fires(repo, content, rule):
    repo.write("doc.md", "line one\n" + content + "\n")
    r = repo.run()
    assert r.returncode == 1, r.stdout + r.stderr
    line = r.stdout.strip().splitlines()[0]
    assert line.startswith("doc.md:2: " + rule)


def test_allow_marker_suppresses(repo):
    repo.write("doc.md", "cd " + HOME_PATH + "  # leak-check: allow\n")
    assert repo.run().returncode == 0


@pytest.mark.parametrize(
    "line",
    [
        "mail user@example.com",
        "mail noreply@anthropic.com",
        "ssh user@host",
        "Co-Authored-By: Bot <noreply@example.org>",
        "cd /home/<user>/project",
        "git clone git@github.com:org/repo.git",
        "pin react@v18.2.0",
        "author t@example.invalid",
    ],
)
def test_placeholders_are_clean(repo, line):
    repo.write("doc.md", line + "\n")
    r = repo.run()
    assert r.returncode == 0, r.stdout


def test_clean_repo_exits_zero(repo):
    repo.write("README.md", "# hello\nnothing private here\n")
    r = repo.run()
    assert r.returncode == 0
    assert r.stdout == ""


def test_secret_shows_at_most_four_chars(repo):
    repo.write("doc.md", "x " + GH_TOKEN + "\n")
    r = repo.run()
    assert r.stdout.strip() == "doc.md:1: github-token: ghp_\u2026"
    assert GH_TOKEN[:8] not in r.stdout + r.stderr


@pytest.mark.parametrize("content,rule", [("cd " + HOME_PATH, "home-path"), ("mail " + EMAIL, "email")])
def test_home_path_and_email_print_rule_name_only(repo, content, rule):
    repo.write("doc.md", content + "\n")
    r = repo.run()
    assert r.stdout.strip() == "doc.md:1: " + rule
    assert "alice" not in r.stdout + r.stderr


@pytest.mark.parametrize(
    "line,secret",
    [
        ("cd /home/" + "zorbname" + "/project", "zorbname"),
        ("mail " + "zorbname" + "@" + "corp.io", "zorbname"),
        ("API_" + "TOKEN" + " = 'zorbname1234567890abcd'", "zorbname"),
        ("tok " + "ghp" + "_" + "zorbname" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4", "zorbname"),
    ],
)
def test_blocklist_term_inside_builtin_match_never_printed(repo, line, secret):
    repo.blocklist(secret + "\n")
    repo.write("doc.md", line + "\n")
    r = repo.run()
    out = r.stdout + r.stderr
    assert r.returncode == 1
    assert secret not in out.lower()
    assert "ghp_" not in out and "API_" not in out
    assert "blocklist term #1" in out


def test_full_secret_absent_when_line_also_hits_blocklist(repo):
    repo.blocklist("zebra\n")
    repo.write("doc.md", "zebra " + GH_TOKEN + "\n")
    r = repo.run()
    assert GH_TOKEN not in r.stdout + r.stderr
    assert "ghp" not in r.stdout


def test_long_single_line_scanned_quickly(repo):
    import time

    repo.write("big.txt", "a" * 200000 + "\n")
    t = time.time()
    r = repo.run()
    assert r.returncode == 0
    assert time.time() - t < 2


def test_long_line_still_scanned_in_first_chunk(repo):
    repo.write("big.txt", "cd " + HOME_PATH + " " + "a" * 50000 + "\n")
    assert repo.run().stdout.startswith("big.txt:1: home-path")


def test_secret_far_along_a_long_line_is_found(repo):
    # One-line JSON or minified code: the secret sits past any fixed prefix.
    repo.write("min.js", "x" * 60000 + " gh" + "p_" + "A1b2" * 9 + " " + "y" * 60000 + "\n")
    r = repo.run()
    assert r.returncode == 1
    assert r.stdout.startswith("min.js:1: github-token")


def test_blocklist_substring_case_insensitive(repo):
    repo.blocklist("# comment\n\nAcmeCorp\n")
    repo.write("doc.md", "we work with ACMECORP daily\n")
    r = repo.run()
    assert r.returncode == 1
    assert r.stdout.strip() == "doc.md:1: blocklist term #1"


def test_blocklist_regex_form(repo):
    repo.blocklist("nothing\nre:proj(ect)?-[0-9]+\n")
    repo.write("doc.md", "see Project-42 for details\n")
    r = repo.run()
    assert r.returncode == 1
    assert r.stdout.strip() == "doc.md:1: blocklist term #2"


def test_blocklist_output_never_contains_term(repo):
    repo.blocklist("secretcodename\nre:hush[a-z]+\n")
    repo.write("doc.md", "a secretcodename and hushword\n")
    r = repo.run()
    out = (r.stdout + r.stderr).lower()
    assert r.returncode == 1
    assert "secretcodename" not in out and "hushword" not in out and "hush" not in out


def test_blocklist_from_env(repo):
    repo.write("doc.md", "mentions Zebracorp here\n")
    r = repo.run(env={"AGENT_KIT_BLOCKLIST": "other\nzebracorp\n"})
    assert r.returncode == 1
    assert r.stdout.strip() == "doc.md:1: blocklist term #2"
    assert "not found" not in r.stderr


def test_staged_sees_staged_ignores_unstaged(repo):
    repo.write("staged.md", "cd " + HOME_PATH + "\n")
    repo.write("unstaged.md", "clean\n")
    repo.git("add", "staged.md", "unstaged.md")
    repo.write("unstaged.md", "cd " + HOME_PATH + "\n")  # dirty after staging
    r = repo.run("--staged")
    assert r.returncode == 1
    assert r.stdout.startswith("staged.md:1: home-path")
    assert "unstaged.md" not in r.stdout


def test_staged_ignores_untracked(repo):
    repo.write("new.md", "cd " + HOME_PATH + "\n")
    assert repo.run("--staged").returncode == 0
    assert repo.run().returncode == 1


def test_staged_reads_blob_not_worktree(repo):
    repo.write("a.md", "fine\n")
    repo.git("add", "a.md")
    repo.write("a.md", "cd " + HOME_PATH + "\n")
    assert repo.run("--staged").returncode == 0


def test_ignored_files_not_scanned(repo):
    repo.write(".gitignore", "ignored/\n")
    repo.write("ignored/secret.md", "cd " + HOME_PATH + "\n")
    assert repo.run().returncode == 0


def test_missing_blocklist_warns_and_continues(repo):
    repo.write("doc.md", "fine\n")
    r = repo.run()
    assert r.returncode == 0
    assert "blocklist" in r.stderr and "not found" in r.stderr
    assert len(r.stderr.strip().splitlines()) == 1


def test_require_blocklist_exits_two(repo):
    repo.write("doc.md", "fine\n")
    r = repo.run("--require-blocklist")
    assert r.returncode == 2
    assert "blocklist" in r.stderr


def test_require_blocklist_satisfied_by_env(repo):
    repo.write("doc.md", "fine\n")
    assert repo.run("--require-blocklist", env={"AGENT_KIT_BLOCKLIST": "x"}).returncode == 0


def test_binary_file_skipped(repo):
    repo.write("img.bin", b"\x00\x01\x02 " + HOME_PATH.encode() + b"\n", mode="wb")
    assert repo.run().returncode == 0


def test_not_a_git_repo_exits_two(tmp_path):
    d = tmp_path / "plain"
    d.mkdir()
    r = subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=d, capture_output=True, text=True,
        env={**os.environ, "AGENT_KIT_CONFIG": str(tmp_path / "cfg")},
    )
    assert r.returncode == 2


def test_bad_regex_exits_two_without_leaking_term(repo):
    repo.blocklist("re:(unclosed\n")
    repo.write("doc.md", "x\n")
    r = repo.run()
    assert r.returncode == 2
    assert "unclosed" not in r.stderr


def test_unknown_flag_exits_two(repo):
    assert repo.run("--bogus").returncode == 2
