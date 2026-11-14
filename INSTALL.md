# Installing agent-kit (instructions for an agent)

You were asked to install agent-kit on this machine. Follow these steps in order. The install is machine-level and serves every agent tool it finds, so run it once per machine and from any directory.

## Before you start

Check these and stop with a clear message if one fails.

1. The machine is macOS or Linux (on Windows, work inside WSL).
2. `git --version` and `python3 --version` both succeed, and Python is 3.10 or newer.
3. At least one of `~/.claude`, `~/.hermes` or `~/.codex` exists. With none of them there is no tool to install into, so say that and stop.

## Steps

1. Clone the repository to its fixed place. Skip the clone when `~/.agent-kit` already is a checkout of this repository.

   ```sh
   git clone https://github.com/insanem3rlin/agent-kit.git ~/.agent-kit
   ```

2. Preview what the install would change. Nothing is written.

   ```sh
   ~/.agent-kit/install.sh --dry-run
   ```

3. Read the preview. Lines starting with `error: conflict:` name a skill or agent that already exists on this machine under a name the kit provides. The kit never overwrites those. Show the list of conflicts to the user and ask which they want.

   - Keep their own versions: run the install without `--adopt`. The conflicting names stay as they are and the install exits with code 1, which is expected in this case.
   - Use the kit's versions: run the install with `--adopt`. Each conflicting entry is moved to a backup folder under `~/.local/state/agent-kit/backup/` and the kit's version is linked in its place.

   With no conflicts, go on without asking.

4. Install.

   ```sh
   ~/.agent-kit/install.sh            # or: ~/.agent-kit/install.sh --adopt
   ```

5. Verify.

   ```sh
   ~/.agent-kit/bin/agent-kit doctor
   ```

   The install is done when `doctor` exits 0, or when its only complaints are the conflicts the user chose to keep.

## What the install changes

Tell the user this list in your report, limited to the tools that were found.

- Claude Code (`~/.claude`): skills linked into `~/.claude/skills`, the agents `researcher`, `implementer` and `reviewer` linked into `~/.claude/agents`, one import line in a marked block of `~/.claude/CLAUDE.md`, and three additions to `settings.json` where those keys are unset (a docs-lookup hook, a statusline, a model fallback for subagents). The `mattpocock-skills` plugin is installed when the `claude` command is available.
- Hermes (`~/.hermes`): skills linked into `~/.hermes/skills`, and the rules text in a marked block at the end of `~/.hermes/SOUL.md`.
- Codex (`~/.codex`): skills linked into `~/.agents/skills`, and the rules text in a marked block of `~/.codex/AGENTS.md`.
- An hourly cron entry that pulls this repository, refreshes the external skills and re-links.
- State in `~/.config/agent-kit/`, `~/.cache/agent-kit/` and `~/.local/state/agent-kit/`.

Permission modes, secrets and the session's model are left alone.

## Rules for you while installing

- Run the commands above as written. Edit no file under `~/.claude`, `~/.hermes` or `~/.codex` by hand, and do not create the links yourself.
- Use `--adopt` only after the user chose it in step 3.
- If a step fails, show the command and its output, and stop. Do not work around a failure by deleting or moving the user's files.
- Leave the statusline's usage lookup off. It needs the user's login token, and only the user turns it on, in `~/.config/agent-kit/statusline.json` (the header of `~/.agent-kit/adapters/claude-code/statusline.py` describes the two keys).
- New sessions pick the rules up. Tell the user to restart running agent sessions.

## Report

State which tools were found, what was linked for each, which conflicts existed and what the user chose, the output of `doctor`, and the backup folder when `--adopt` was used.

## Removing it

```sh
~/.agent-kit/bin/agent-kit uninstall
```

This removes exactly what the install added and leaves backups, configuration and the checkout in place.
