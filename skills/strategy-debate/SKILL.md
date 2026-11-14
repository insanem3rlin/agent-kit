---
name: strategy-debate
description: Multi-turn debate on a strategic or business decision between the running agent and a model from a different vendor, reached through another agent CLI installed on the machine. Use only when the user explicitly asks to debate or pressure-test a decision with another model ("debate this with another model", "/strategy-debate"). Not for code review and not for ordinary strategy conversations that do not ask for a second model.
argument-hint: "<strategic question> [rounds=N] [model=NAME] [opponent=reset] | smoke"
---

# Strategy debate

You are one side. The other side is a model from a different vendor, run through its agent CLI with one session resumed each round, so it remembers the thread. The user reads both sides and decides. Close with a synthesis you write yourself.

`OPP` below is `opponent.py` in this skill's directory (Python 3, standard library only).

## Arguments

- `smoke` alone means run the smoke test and stop.
- `rounds=N` sets the number of debate rounds, default 3 and capped at 5. Push back once if asked for more.
- `model=NAME` sets the opponent model for this debate only. It always wins and is never stored.
- `opponent=reset` means run `OPP reset`, then choose again.
- The rest is the question. Without one, ask for it and stop.

## 1. Choose the opponent

1. State your own vendor and model from what you know of yourself. This is `OWN`.
2. `python3 OPP get --own-vendor "<OWN vendor>"`.
   - With `configured: true` and `same_vendor: false`, use it without asking.
   - With `same_vendor: true`, say the stored opponent is your own vendor, tell the user to run with `opponent=reset`, and stop.
   - With `configured: false`, run `python3 OPP detect`. Drop entries whose vendor equals yours. Show the rest as `cli (vendor, model)`, where a `null` vendor means unresolved, so ask the user for it. If none remain, say that no other-vendor CLI is installed and stop. Otherwise ask which to use, then `python3 OPP set --cli <cli> [--model <m>] [--vendor <v>] --own-vendor "<OWN vendor>"`.
3. Tell the user in one line, "Opponent remembered; delete `${AGENT_KIT_CONFIG:-$HOME/.config/agent-kit}/debate-opponent.json` or pass `opponent=reset` to choose again."
4. The opponent model `$MODEL` is `model=` if given, else the stored model, else (only when the opponent CLI is `claude`) `opus`, the strong tier; for any other CLI with neither, omit the flag and use the CLI's own default. Never choose a tier above `opus` yourself.
5. If the CLI reports it is not logged in or misconfigured, show its own error text and stop.

## 2. Prepare

- Create `D=$(mktemp -d)` and run every opponent call from inside `D`, so the opponent works in an empty scratch directory. Prompts go in `D/pK.txt`, replies in `D/replyK.txt`.
- Write a **context brief** of at most 300 words from facts that are at hand: what the product or business is, stage, numbers, constraints, the decision. The opponent cannot see your files, so the brief carries everything. Do not start a research project.
- Write **your opening position** before hearing the opponent, as 3-5 numbered arguments and a clear recommendation, held honestly. Show it under `**<your model> (opening)**`.

## 3. Debate

Turn 1 prompt (`p1.txt`):

```
You are a sharp, skeptical strategist in a structured debate with another AI ({OWN model}) about a decision. The human reads both sides and decides.

CONTEXT BRIEF:
{brief}

QUESTION:
{question}

{OWN model}'s OPENING POSITION:
{position}

This turn: state your own position (agree or disagree honestly, not for sport); attack the weakest points in the opening position with specific counterarguments. Under 500 words, numbered, no pleasantries.
```

Send it with the CLI's first-turn command, capture the session id, and relay the reply to the user under `**<opponent model> (round 1)**` (verbatim or a faithful summary, never softened). Then for each later round K:

1. Write your rebuttal: concede what is right and say so, counter the rest, sharpen the recommendation. Show it under `**<your model> (round K)**`.
2. Send `pK.txt`, made of the rebuttal followed by `Respond: defend what survives, concede what does not, max 400 words.` On the final round, use instead `Final round. Give your closing statement: one recommendation, your strongest surviving argument, and what evidence would change your mind. Max 300 words.`
3. Fold any user interjection into the next prompt as `USER INPUT: ...`.

Use the resume command for every turn after the first, with the same model flag again. Run calls with `timeout 300` when `timeout` exists, stdin from `/dev/null`, and read stderr too. On a timeout, offer to retry that turn; the session survives. An empty or missing reply is a failure, so show the raw output and never present it as a reply.

## 4. Synthesis

Write it yourself, attributing each claim to the right side. It has four parts:

- **Agreed** covers where both converged.
- **Disputed** gets one line per point, saying who argues what and which argument you find stronger and why.
- **Joint recommendation** gives concrete next steps, marked unanimous or split.
- **Evidence to collect** names the data that would settle the disputes.

Name `D` as the place the transcript lives.

## Invocation per CLI

`P1`/`PK` are the prompt files, `$MODEL` is the opponent model chosen in step 1 (omit the flag when none), `$SID` the session id. All run read-only in scratch dir `D`. If a flag is rejected, run `<cli> --help` (and `<cli> <subcommand> --help`), adapt, and carry on.

| CLI | First turn | Resume | Session id | Status |
|---|---|---|---|---|
| `claude` | `claude -p --model $MODEL --tools "Read,Grep,Glob" --session-id $SID "$(cat P1)"` with `SID=$(python3 -c 'import uuid;print(uuid.uuid4())')` | `claude -p --resume $SID --model $MODEL --tools "Read,Grep,Glob" "$(cat PK)"` | you generate it | checked against `--help` only, not run (2026-11-14) |
| `hermes` | `hermes chat -Q --ignore-rules -t web [-m $MODEL] [--provider $PROV] --query-file P1 >reply1.txt 2>err1.txt` | `hermes chat -Q --ignore-rules -t web --resume $SID [-m $MODEL] --query-file PK` | stderr line `session_id: <id>`; reply is stdout | checked against `--help` and a real two-turn run (2026-11-14) |
| `codex` | `codex exec --json --skip-git-repo-check -s read-only [-m $MODEL] -o reply1.txt "$(cat P1)"` | `codex exec resume $SID --skip-git-repo-check [-m $MODEL] -c 'sandbox_mode="read-only"' -o replyK.txt "$(cat PK)"` | `thread_id` in the `thread.started` JSON event on stdout | from documentation only (openai/codex source via context7), 2026-11-14 |
| `gemini` | `gemini -p "$(cat P1)" --approval-mode plan --output-format json [-m $MODEL]` | `gemini --resume $SID -p "$(cat PK)" --approval-mode plan --output-format json [-m $MODEL]` | `session_id` field of the JSON output; reply in `response` | from documentation only (google-gemini/gemini-cli via context7), 2026-11-14; `-m` not confirmed there |
| `opencode` | `opencode run --agent plan --format json [-m provider/model] "$(cat P1)"` | `opencode run -s $SID --agent plan --format json [-m provider/model] "$(cat PK)"` | session id in the JSON events (look for a `sessionID` field) | from documentation only (opencode CLI docs via context7), 2026-11-14; `--agent plan` as the read-only mode is unconfirmed |

Note that `-t web` leaves `hermes` without file, terminal or code tools. `codex` resume takes the sandbox through `-c`; if `-s` is rejected there, that is why. Pass the model flag on resume too, otherwise a CLI may fall back to its default model.

## Smoke test (`smoke`)

The smoke test costs two tiny calls. Do the choice step, create `D`, send `Remember the codeword SMOKE-DEBATE-77. Reply with exactly: stored` as turn 1, capture the session id, then resume with `What is the codeword? Reply with just the codeword.`. Report PASS when turn 1 gave a session id and the second reply contains `SMOKE-DEBATE-77`; otherwise FAIL, naming the step and showing the raw output. Run it after upgrading an opponent CLI or when a debate misbehaves.
