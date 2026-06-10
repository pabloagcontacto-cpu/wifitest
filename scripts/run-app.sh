#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
FRONTEND_BINARY="${FRONTEND_BINARY:-$FRONTEND_DIR/src-tauri/target/release/wifitest-frontend}"
BUILD_FRONTEND_IF_MISSING="${BUILD_FRONTEND_IF_MISSING:-1}"
FRONTEND_BUILD_SCRIPT="${FRONTEND_BUILD_SCRIPT:-build:safe}"
SELECTED_FRONTEND_MODE="${FRONTEND_MODE:-binary}"

load_user_cargo_env() {
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.cargo/env"
  elif [ -d "$HOME/.cargo/bin" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
}

ensure_frontend_native_deps() {
  local missing=()
  local module

  if ! command -v pkg-config >/dev/null 2>&1; then
    echo "No se ha encontrado pkg-config, necesario para compilar Tauri." >&2
    echo "En Debian/Kali/Parrot prueba: sudo apt-get install -y pkg-config" >&2
    return 1
  fi

  for module in glib-2.0 gobject-2.0 gtk+-3.0 webkit2gtk-4.1 librsvg-2.0; do
    if ! pkg-config --exists "$module"; then
      missing+=("$module")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    return
  fi

  echo "Faltan dependencias nativas de Tauri/GTK:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  echo "En Debian/Kali/Parrot normalmente se corrige con:" >&2
  echo "  sudo apt-get update" >&2
  echo "  sudo apt-get install -y libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev" >&2
  echo >&2
  echo "Tambien puedes relanzar ./scripts/install-linux.sh para que intente preparar estas dependencias." >&2
  return 1
}

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
  if [ "$SELECTED_FRONTEND_MODE" = "web" ]; then
    return
  fi

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

  load_user_cargo_env
  if ! command -v cargo >/dev/null 2>&1; then
    echo "No se ha encontrado cargo en el PATH." >&2
    echo "Ejecuta ./scripts/install-linux.sh o instala Rust con rustup y abre una nueva terminal." >&2
    exit 1
  fi
  if ! ensure_frontend_native_deps; then
    if confirm "Quieres arrancar la aplicacion en modo web sin compilar Tauri?" "y"; then
      SELECTED_FRONTEND_MODE="web"
      return
    fi
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
  FRONTEND_MODE="$SELECTED_FRONTEND_MODE" \
  FRONTEND_BINARY="$FRONTEND_BINARY" \
  ./scripts/dev-stack.sh
