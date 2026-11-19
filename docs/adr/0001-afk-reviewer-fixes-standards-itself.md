# The AFK reviewer fixes Standards findings itself

The kit's review rule sends findings back to the implementer for one more attempt, which is then reviewed again. AFK runs deliberately depart from that: the reviewer fixes Standards findings on the branch itself, keeping behaviour identical, and only reports Spec findings, as a PR comment for the human. A Standards finding concerns how the code is written, not what was asked for, so a round trip through the implementer costs a full extra agent pass without changing the outcome. A human still reviews and merges every AFK branch, so the reviewer's own commits do not reach a shared branch unreviewed.

## Considered Options

- Follow the kit rule (review, implementer fix, second review): rejected as one extra agent pass per issue for findings that do not need the implementer's intent.
- Reviewer fixes everything, Spec findings included: rejected, because a guess at what the issue meant is how a wrong feature gets built confidently.
