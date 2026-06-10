#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVICE_DIR/.." && pwd)"
ENV_FILE="$SERVICE_DIR/.env"
VENV_DIR="$SERVICE_DIR/.venv"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
python -m pip install -r "$SERVICE_DIR/requirements.txt"

cd "$REPO_ROOT"
exec python -m chat_service.worker

