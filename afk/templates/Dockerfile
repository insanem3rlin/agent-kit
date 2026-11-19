# AFK sandbox image. Nothing from the host is mounted: agent-kit, the agent CLIs and
# the kit's plugins are installed here, and credentials arrive as environment
# variables at run time (from ~/.config/agent-kit/afk.env), never in this file.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  gh \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# Align the image user with the host user so bind-mounted files share an owner.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
# Sandcastle hardcodes /home/agent as the agent user's home; do not change it.
ARG AGENT_HOME=/home/agent
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d $AGENT_HOME -m -l agent node

# Codex CLI (as root, before dropping to the agent user).
RUN npm install -g @openai/codex

USER ${AGENT_UID}:${AGENT_GID}
ENV PATH="${AGENT_HOME}/.local/bin:$PATH"
WORKDIR ${AGENT_HOME}

# Claude Code and Cursor Agent CLIs.
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl https://cursor.com/install -fsS | bash

# agent-kit itself, with its rules, skills and Claude plugins. AGENT_KIT_REF is the
# kit commit, branch or tag to install; a changed value busts this layer's cache, so
# the launcher (issue #7) passes the kit's current commit as the build argument. The
# agent CLIs above stay floating on purpose, so they are current.
# The installer links into each agent tool's home, so those homes must exist first.
# --no-timer: a container has no cron to keep in sync. --no-pull: the checkout is
# pinned to AGENT_KIT_REF. The plugin install can fail without a login at build time,
# so the installer's exit status is not fatal on its own; the checks after it are. An
# image without the rules or the role agents must never be built, because agents in it
# would run unattended without them.
ARG AGENT_KIT_REPO=https://github.com/insanem3rlin/agent-kit.git
ARG AGENT_KIT_REF=main
RUN mkdir -p ~/.claude ~/.codex ~/.cursor \
  && git clone "$AGENT_KIT_REPO" ~/.agent-kit \
  && git -C ~/.agent-kit checkout "$AGENT_KIT_REF" \
  && { ~/.agent-kit/install.sh --no-timer --no-pull || true; } \
  && test -s ~/.claude/CLAUDE.md \
  && test -s ~/.codex/AGENTS.md \
  && test -s ~/.claude/agents/reviewer.md \
  && test -s ~/.claude/skills/do-issue/SKILL.md \
  && test -s ~/.agents/skills/do-issue/SKILL.md

# Sandcastle bind-mounts the worktree and sets the working directory at start.
ENTRYPOINT ["sleep", "infinity"]
