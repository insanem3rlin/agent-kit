#!/bin/sh
# Bootstrap agent-kit on a new machine: clone (if needed), then run `agent-kit install`.
set -eu

for cmd in git python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "agent-kit: $cmd is required" >&2; exit 1; }
done
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || {
  echo "agent-kit: Python 3.10+ is required, python3 is $(python3 -V 2>&1) (macOS: brew install python)" >&2
  exit 1
}

here=$(cd "$(dirname "$0")" && pwd)
if [ -z "${AGENT_KIT_HOME:-}" ] && [ -f "$here/bin/agent-kit" ]; then
  AGENT_KIT_HOME=$here
else
  AGENT_KIT_HOME=${AGENT_KIT_HOME:-$HOME/.agent-kit}
  if [ ! -e "$AGENT_KIT_HOME" ]; then
    git clone "${AGENT_KIT_REPO:-https://github.com/insanem3rlin/agent-kit.git}" "$AGENT_KIT_HOME"
  fi
fi
export AGENT_KIT_HOME
exec "$AGENT_KIT_HOME/bin/agent-kit" install "$@"
