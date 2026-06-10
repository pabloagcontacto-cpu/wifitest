#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
FRONTEND_BINARY="${FRONTEND_BINARY:-$FRONTEND_DIR/src-tauri/target/release/wifitest-frontend}"
BUILD_FRONTEND_IF_MISSING="${BUILD_FRONTEND_IF_MISSING:-1}"
FRONTEND_BUILD_SCRIPT="${FRONTEND_BUILD_SCRIPT:-build:safe}"

confirm() {
  local question="$1"
  local default="${2:-y}"
  local prompt="[Y/n]"
  local answer

  if [ "$default" = "n" ]; then
    prompt="[y/N]"
  fi

  while true; do
    read -r -p "$question $prompt " answer
    answer="${answer:-$default}"
    case "$answer" in
      y|Y|yes|YES|s|S|si|SI) return 0 ;;
      n|N|no|NO) return 1 ;;
      *) printf 'Responde yes/no.\n' ;;
    esac
  done
}

ensure_frontend_binary() {
  if [ -x "$FRONTEND_BINARY" ]; then
    return
  fi

  if [ "$BUILD_FRONTEND_IF_MISSING" != "1" ]; then
    echo "No se ha encontrado el binario del frontend en $FRONTEND_BINARY." >&2
    echo "Ejecuta: cd frontend && npm run $FRONTEND_BUILD_SCRIPT" >&2
    exit 1
  fi

  echo "No se ha encontrado el binario release de WIFITEST."
  if ! confirm "Quieres compilarlo ahora?"; then
    echo "No se puede lanzar la aplicacion sin binario." >&2
    exit 1
  fi

  (
    cd "$FRONTEND_DIR"
    npm run "$FRONTEND_BUILD_SCRIPT"
  )

  if [ ! -x "$FRONTEND_BINARY" ]; then
    echo "La compilacion termino, pero no se ha encontrado $FRONTEND_BINARY." >&2
    exit 1
  fi
}

ensure_frontend_binary

cd "$ROOT_DIR"
exec env \
  FRONTEND_MODE=binary \
  FRONTEND_BINARY="$FRONTEND_BINARY" \
  ./scripts/dev-stack.sh
