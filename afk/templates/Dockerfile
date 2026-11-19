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

# agent-kit itself, with its rules, skills and Claude plugins. The installer links
# into each agent tool's home, so those homes must exist first.
ARG AGENT_KIT_REPO=https://github.com/insanem3rlin/agent-kit.git
RUN mkdir -p ~/.claude ~/.codex ~/.cursor \
  && git clone "$AGENT_KIT_REPO" ~/.agent-kit \
  && ~/.agent-kit/install.sh

# Sandcastle bind-mounts the worktree and sets the working directory at start.
ENTRYPOINT ["sleep", "infinity"]
