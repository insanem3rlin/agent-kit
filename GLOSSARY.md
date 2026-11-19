# agent-kit

Shared working rules, skills and roles for coding agents, installed once per machine. This glossary holds the terms the kit itself defines.

## Unattended work

**Issue**:
One unit of work in the backlog, whether a GitHub issue or a Backlog.md task.
_Avoid_: Task, ticket, story

**AFK daemon**:
The long-running process, started in one repository, that finds issues carrying the AFK label and starts an AFK run for each.
_Avoid_: Sandcastle, orchestrator, loop

**Claim**:
The mark that an issue already has an AFK run, which is its `afk/<id>` branch existing on the remote.
_Avoid_: Lock, assignment

**AFK run**:
One issue taken from the backlog through an implementer phase and a reviewer phase inside a sandbox, ending in a pull request a human merges.
_Avoid_: Sandcastle run, RALPH run, background agent

**AFK label**:
The `afk` label on an issue, which marks it as handed over for an AFK run.
_Avoid_: Sandcastle label

**Ready for human**:
The state of an issue whose AFK run has finished, shown by the `ready-for-human` label that replaces the AFK label.
_Avoid_: Done, closed

**AFK blocked**:
The state of an issue whose AFK run ended without pushing a branch, shown by the `afk-blocked` label and a comment giving the reason; swapping it back to the AFK label retries it.
_Avoid_: Failed, stuck

**Backlog**:
The issues a repository tracks, held either as GitHub issues or as Backlog.md tasks committed in the repository.
_Avoid_: Queue, ticket list
