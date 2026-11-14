# Installing agent-kit (instructions for an agent)

You were asked to install agent-kit on this machine. Follow these steps in order. The install is machine-level and serves every agent tool it finds, so run it once per machine and from any directory.

## Before you start

Check these and stop with a clear message if one fails.

1. The machine is macOS, Linux or Windows. On Windows, run the PowerShell commands given under each step (`install.ps1`, `bin\agent-kit.ps1`) natively, not in WSL: the agent tools live in the Windows home, and WSL has its own. Symbolic links need Developer Mode on (Settings > System > For developers) or an elevated shell; the installer checks this.
2. `git --version` succeeds and Python 3.10 or newer is installed (`python3 --version` on macOS and Linux; on Windows the installer finds it and skips the Microsoft Store stub, or takes `AGENT_KIT_PYTHON`). Stock macOS ships Python 3.9, so install a newer one there first (`brew install python`).
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

   ```powershell
   powershell -ExecutionPolicy Bypass -File ~\.agent-kit\install.ps1 --dry-run   # Windows
   ```

3. Read the preview. Lines starting with `error: conflict:` name a skill or agent that already exists on this machine under a name the kit provides. The kit never overwrites those. Show the list of conflicts to the user and ask which they want.

   - Keep their own versions: run the install without `--adopt`. The conflicting names stay as they are and the install exits with code 1, which is expected in this case.
   - Use the kit's versions: run the install with `--adopt`. Each conflicting entry is moved to a backup folder under `~/.local/state/agent-kit/backup/` and the kit's version is linked in its place.

   With no conflicts, go on without asking.

4. Install.

   ```sh
   ~/.agent-kit/install.sh            # or: ~/.agent-kit/install.sh --adopt
   ```

   ```powershell
   powershell -ExecutionPolicy Bypass -File ~\.agent-kit\install.ps1   # Windows; add --adopt as above
   ```

5. Verify.

   ```sh
   ~/.agent-kit/bin/agent-kit doctor
   ```

   ```powershell
   powershell -ExecutionPolicy Bypass -File ~\.agent-kit\bin\agent-kit.ps1 doctor   # Windows
   ```

   The install is done when `doctor` exits 0, or when its only complaints are the conflicts the user chose to keep.

6. Audit the rules and skills that were on the machine before. The kit is now the machine-wide source for its rules and skills, so other copies either repeat it or contradict it. Where your tool can delegate, give the reading to a read-only subagent (the `researcher` role) and keep its findings, each with file and line, rather than the file contents. Re-read each file yourself before you edit it.

   Read, for each tool that was found:

   - Machine level: `~/.claude/CLAUDE.md`, `~/.claude/skills/`, `~/.claude/agents/` and the enabled plugins in `~/.claude/settings.json`; `~/.codex/AGENTS.md`, `~/.codex/skills/` and `~/.agents/skills/`; `~/.hermes/SOUL.md` and `~/.hermes/skills/`; and the rules files of any other agent tool the user names. Skip the kit's own marked blocks (`<!-- agent-kit:begin -->` to `<!-- agent-kit:end -->`) and the links the kit made.
   - Repository level: ask the user where their repositories are. In each one, read `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.claude/skills/` and `.agents/skills/`, and run `git shortlog -sn --all` (it works in sh and PowerShell) to see everyone who ever committed there.

   Sort what you find against `~/.agent-kit/rules/AGENTS.md` and `~/.agent-kit/skills/`:

   - Duplicate: says what a kit rule or kit skill already says.
   - Conflict: contradicts a kit rule, for example committing, pushing or messaging people without approval, or adding an attribution line.
   - Own: specific to the user or the project. It stays.
   - Leak: a secret, host address or account ID in a tracked file. Note its kind, never its value.

   Before removing anything, copy the file or skill folder to `~/.local/state/agent-kit/backup/manual-<UTC timestamp>/`, under its path relative to the home directory (outside home, under its absolute path with the drive letter or root as the first folder, such as `D/src/app/AGENTS.md`), so a second run or a second tool never overwrites an earlier copy. Then handle each finding like this:

   - A machine-level duplicate: remove the duplicated lines or skill. Step 3 already settled skills that clash with a kit skill in the folders the installer links into, but a copy of a kit skill in `~/.codex/skills` is a duplicate to remove here. Copies of a Claude plugin's skills under `~/.codex/skills` or `~/.agents/skills` are how Codex gets them, so they are not duplicates. A plugin that duplicates a kit skill: report it and let the user disable the plugin; never edit a plugin's files.
   - A machine-level conflict: show it to the user and change nothing until they decide.
   - A repository duplicate: remove it only where the user is the only person in `git shortlog` (their own agents count as the user). In a shared repository, colleagues without the kit would lose the rule, so report it instead, and ask the user when you cannot tell who an author is. A line that only repeats what the repository already enforces itself (a plugin it enables, a hook it runs) can go in either case. Edit the working tree only and commit nothing.
   - A repository conflict: report it. A repository's rules win over the kit's for that repository, and projects differ on purpose.
   - A leak: report the file, the line and the kind of secret. Do not edit it.

## What the install changes

Tell the user this list in your report, limited to the tools that were found.

- Claude Code (`~/.claude`): skills linked into `~/.claude/skills`, the agents `researcher`, `implementer` and `reviewer` linked into `~/.claude/agents`, one import line in a marked block of `~/.claude/CLAUDE.md`, and three additions to `settings.json` where those keys are unset (a docs-lookup hook, a statusline, a model fallback for subagents). The `mattpocock-skills` plugin is installed when the `claude` command is available.
- Hermes (`~/.hermes`): skills linked into `~/.hermes/skills`, and the rules text in a marked block at the end of `~/.hermes/SOUL.md`.
- Codex (`~/.codex`): skills linked into `~/.agents/skills`, the agents `researcher`, `implementer` and `reviewer` linked into `~/.codex/agents`, the rules text in a marked block of `~/.codex/AGENTS.md`, and the docs-lookup hook in `~/.codex/hooks.json`. Tell the user that Codex runs the hook only after they trust it with `/hooks`.
- An hourly cron entry that pulls this repository, refreshes the external skills and re-links. On Windows this is the scheduled task `agent-kit-sync`, which logs to `~\.local\state\agent-kit\sync.log`.
- State in `~/.config/agent-kit/`, `~/.cache/agent-kit/` and `~/.local/state/agent-kit/`.

Permission modes, secrets and the session's model are left alone.

## Rules for you while installing

- Run the commands above as written. Edit no file under `~/.claude`, `~/.hermes` or `~/.codex` by hand except for the step 6 removals, never inside the kit's marked blocks, and do not create the links yourself.
- Use `--adopt` only after the user chose it in step 3.
- If a step fails, show the command and its output, and stop. Do not work around a failure by deleting or moving the user's files.
- Leave the statusline's usage lookup off. It needs the user's login token, and only the user turns it on, in `~/.config/agent-kit/statusline.json` (the header of `~/.agent-kit/adapters/claude-code/statusline.py` describes the two keys).
- New sessions pick the rules up. Tell the user to restart running agent sessions.

## Report

State which tools were found, what was linked for each, which conflicts existed and what the user chose, the output of `doctor`, and the backup folder when `--adopt` was used. From the audit, list what you removed and where its backup is, then the conflicts, the leaks and the duplicates left in shared repositories, each with file and line.

## Removing it

```sh
~/.agent-kit/bin/agent-kit uninstall
```

On Windows: `powershell -ExecutionPolicy Bypass -File ~\.agent-kit\bin\agent-kit.ps1 uninstall`.

This removes exactly what the install added and leaves backups, configuration and the checkout in place.
