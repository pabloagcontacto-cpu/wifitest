#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend/MCP"
CHAT_SERVICE_DIR="$ROOT_DIR/chat_service"
FRONTEND_DIR="$ROOT_DIR/frontend"
CONFIG_DIR="$ROOT_DIR/config"
BACKEND_ENV_FILE="$BACKEND_DIR/.env"
CHAT_ENV_FILE="$CHAT_SERVICE_DIR/.env"
LOCAL_CONFIG_FILE="$CONFIG_DIR/local.json"

ASSUME_YES=0
DRY_RUN=0
REMOVE_SYSTEM_DEPS=0
REMOVE_AGGRESSIVE_DEPS=0
REMOVE_PROJECT_DIR=0

PACKAGE_MANAGER=""
CONTAINER_RUNTIME=""
CONTAINER_USE_SUDO=0

log() {
  printf '\n==> %s\n' "$*"
}

info() {
  printf '  %s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

usage() {
  cat <<EOF
Uso: ./scripts/uninstall-linux.sh [opciones]

Opciones:
  --yes                    Responde si a las preguntas interactivas.
  --dry-run                Muestra lo que haria sin borrar nada.
  --remove-system-deps     Ofrece eliminar dependencias de sistema de WIFITEST.
  --aggressive-system-deps Incluye dependencias compartidas y criticas; usar con cuidado.
  --remove-project-dir     Ofrece borrar tambien el directorio completo del repo.
  -h, --help               Muestra esta ayuda.
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes) ASSUME_YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --remove-system-deps) REMOVE_SYSTEM_DEPS=1 ;;
      --aggressive-system-deps)
        REMOVE_SYSTEM_DEPS=1
        REMOVE_AGGRESSIVE_DEPS=1
        ;;
      --remove-project-dir) REMOVE_PROJECT_DIR=1 ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        warn "Opcion no reconocida: $1"
        usage
        exit 1
        ;;
    esac
    shift
  done
}

confirm() {
  local question="$1"
  local default="${2:-n}"
  local prompt="[y/N]"
  local answer

  if [ "$ASSUME_YES" = "1" ]; then
    return 0
  fi

  if [ "$default" = "y" ]; then
    prompt="[Y/n]"
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

run_or_print() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY-RUN:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi

  "$@"
}

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    run_or_print "$@"
  else
    run_or_print sudo "$@"
  fi
}

read_env_var() {
  local file="$1"
  local key="$2"

  if [ ! -f "$file" ]; then
    return 1
  fi

  grep "^${key}=" "$file" | tail -n 1 | cut -d= -f2-
}

delete_path() {
  local path="$1"

  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return
  fi

  info "Eliminando $path"
  run_or_print rm -rf -- "$path"
}

delete_empty_dir() {
  local path="$1"

  if [ -d "$path" ]; then
    run_or_print rmdir --ignore-fail-on-non-empty "$path" 2>/dev/null || true
  fi
}

detect_package_manager() {
  if command -v pacman >/dev/null 2>&1; then
    PACKAGE_MANAGER="pacman"
  elif command -v apt-get >/dev/null 2>&1; then
    PACKAGE_MANAGER="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PACKAGE_MANAGER="dnf"
  elif command -v zypper >/dev/null 2>&1; then
    PACKAGE_MANAGER="zypper"
  else
    PACKAGE_MANAGER=""
  fi
}

package_installed() {
  local package="$1"

  case "$PACKAGE_MANAGER" in
    pacman) pacman -Q "$package" >/dev/null 2>&1 ;;
    apt) dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed" ;;
    dnf|zypper) rpm -q "$package" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

stop_running_wifitest_processes() {
  log "Procesos WIFITEST"
  local patterns=(
    "$BACKEND_DIR/.venv/bin/python worker.py"
    "$BACKEND_DIR/.venv/bin/python server.py"
    "$CHAT_SERVICE_DIR/.venv/bin/python -m chat_service.main"
    "$CHAT_SERVICE_DIR/.venv/bin/python -m chat_service.worker"
    "$ROOT_DIR/scripts/serve-frontend-web.py"
    "$FRONTEND_DIR/src-tauri/target/release/wifitest-frontend"
  )
  local pids=()
  local pattern pid

  for pattern in "${patterns[@]}"; do
    while IFS= read -r pid; do
      [ -n "$pid" ] && pids+=("$pid")
    done < <(pgrep -f "$pattern" 2>/dev/null || true)
  done

  if [ "${#pids[@]}" -eq 0 ]; then
    info "No se han encontrado procesos de WIFITEST en ejecucion."
    return
  fi

  printf '  Procesos detectados: %s\n' "${pids[*]}"
  if confirm "Quieres pararlos ahora?" "y"; then
    if [ "$DRY_RUN" = "1" ]; then
      run_or_print kill "${pids[@]}"
    else
      run_or_print kill "${pids[@]}" 2>/dev/null || true
    fi
  fi
}

detect_container_runtime() {
  CONTAINER_RUNTIME=""
  CONTAINER_USE_SUDO=0

  for runtime in podman docker; do
    if ! command -v "$runtime" >/dev/null 2>&1; then
      continue
    fi

    if "$runtime" ps -a --format '{{.Names}}' >/dev/null 2>&1; then
      CONTAINER_RUNTIME="$runtime"
      return 0
    fi

    if [ "$DRY_RUN" = "1" ]; then
      continue
    fi

    if [ "$(id -u)" -ne 0 ] && sudo "$runtime" ps -a --format '{{.Names}}' >/dev/null 2>&1; then
      CONTAINER_RUNTIME="$runtime"
      CONTAINER_USE_SUDO=1
      return 0
    fi
  done

  return 1
}

container_cmd() {
  if [ "$CONTAINER_USE_SUDO" = "1" ]; then
    run_sudo "$CONTAINER_RUNTIME" "$@"
    return
  fi

  run_or_print "$CONTAINER_RUNTIME" "$@"
}

container_output() {
  if [ "$CONTAINER_USE_SUDO" = "1" ]; then
    sudo "$CONTAINER_RUNTIME" "$@"
    return
  fi

  "$CONTAINER_RUNTIME" "$@"
}

remove_redis_container() {
  log "Contenedor Redis de WIFITEST"

  if ! detect_container_runtime; then
    info "No se ha encontrado Docker/Podman disponible."
    return
  fi

  if ! container_output ps -a --format '{{.Names}}' 2>/dev/null | grep -Fxq "wifitest-redis"; then
    info "No existe el contenedor wifitest-redis."
    return
  fi

  if confirm "Quieres eliminar el contenedor wifitest-redis y sus datos?" "y"; then
    if [ "$DRY_RUN" = "1" ]; then
      container_cmd stop wifitest-redis
      container_cmd rm -f wifitest-redis
    else
      container_cmd stop wifitest-redis >/dev/null 2>&1 || true
      container_cmd rm -f wifitest-redis >/dev/null 2>&1 || true
    fi
  fi
}

select_redis_cmd() {
  REDIS_CMD=()

  if command -v redis-cli >/dev/null 2>&1; then
    REDIS_CMD=(redis-cli)
    return 0
  fi

  if command -v valkey-cli >/dev/null 2>&1; then
    REDIS_CMD=(valkey-cli)
    return 0
  fi

  if detect_container_runtime && container_output ps --format '{{.Names}}' 2>/dev/null | grep -Fxq "wifitest-redis"; then
    if [ "$CONTAINER_USE_SUDO" = "1" ]; then
      REDIS_CMD=(sudo "$CONTAINER_RUNTIME" exec wifitest-redis redis-cli)
    else
      REDIS_CMD=("$CONTAINER_RUNTIME" exec wifitest-redis redis-cli)
    fi
    return 0
  fi

  return 1
}

delete_redis_patterns_for_db() {
  local db="$1"
  shift
  local pattern key count=0

  for pattern in "$@"; do
    while IFS= read -r key; do
      [ -z "$key" ] && continue
      count=$((count + 1))
      if [ "$DRY_RUN" = "1" ]; then
        run_or_print "${REDIS_CMD[@]}" -n "$db" del "$key"
      else
        run_or_print "${REDIS_CMD[@]}" -n "$db" del "$key" >/dev/null || true
      fi
    done < <("${REDIS_CMD[@]}" -n "$db" --scan --pattern "$pattern" 2>/dev/null || true)
  done

  info "DB $db: claves eliminadas por patron: $count"
}

remove_redis_data() {
  log "Datos Redis de WIFITEST"

  if ! select_redis_cmd; then
    warn "No se ha encontrado redis-cli/valkey-cli ni un contenedor wifitest-redis levantado."
    return
  fi

  if ! confirm "Quieres borrar solo las claves Redis de WIFITEST?" "y"; then
    return
  fi

  delete_redis_patterns_for_db 0 \
    "mcp:job:*" \
    "mcp:jobs:stream"

  delete_redis_patterns_for_db 1 \
    "wifitest:chat:conversation:*" \
    "wifitest:chat:turn:*" \
    "wifitest:chat:conversation-lock:*" \
    "wifitest:chat:conversations" \
    "wifitest:chat:turns:queue"
}

get_tunnel_id() {
  local tunnel_name="$1"
  local tunnel_id=""

  if ! command -v cloudflared >/dev/null 2>&1; then
    return 1
  fi

  tunnel_id="$(cloudflared tunnel info "$tunnel_name" 2>/dev/null | awk '/ID:/ { print $2; exit }')"
  if [ -n "$tunnel_id" ]; then
    printf '%s' "$tunnel_id"
    return 0
  fi

  cloudflared tunnel list 2>/dev/null | awk -v name="$tunnel_name" '$2 == name { print $1; exit }'
}

remove_cloudflare_config() {
  log "Cloudflare Tunnel"

  local tunnel_name tunnel_hostname config_file tunnel_id credentials_file
  tunnel_name="$(read_env_var "$BACKEND_ENV_FILE" "TUNNEL_NAME" || true)"
  tunnel_hostname="$(read_env_var "$BACKEND_ENV_FILE" "TUNNEL_HOSTNAME" || true)"
  config_file="$(read_env_var "$BACKEND_ENV_FILE" "CLOUDFLARED_CONFIG" || true)"
  config_file="${config_file:-$HOME/.cloudflared/config.yml}"

  if [ -z "$tunnel_name" ] && [ -z "$tunnel_hostname" ] && [ ! -f "$config_file" ]; then
    info "No se ha encontrado configuracion Cloudflare de WIFITEST."
    return
  fi

  info "Tunel configurado: ${tunnel_name:-desconocido}"
  info "Hostname configurado: ${tunnel_hostname:-desconocido}"

  if command -v cloudflared >/dev/null 2>&1 && [ -n "$tunnel_name" ]; then
    tunnel_id="$(get_tunnel_id "$tunnel_name" || true)"
    credentials_file="${tunnel_id:+$HOME/.cloudflared/${tunnel_id}.json}"

    if confirm "Quieres eliminar el tunel remoto de Cloudflare '$tunnel_name'?" "n"; then
      run_or_print cloudflared tunnel delete --force "$tunnel_name" || warn "No se pudo eliminar el tunel remoto."
    fi

    if [ -n "$credentials_file" ] && [ -f "$credentials_file" ]; then
      if confirm "Quieres borrar las credenciales locales del tunel $credentials_file?" "y"; then
        delete_path "$credentials_file"
      fi
    fi
  else
    info "cloudflared no esta instalado o no hay nombre de tunel."
  fi

  if [ -f "$config_file" ]; then
    if grep -q "hostname: ${tunnel_hostname}" "$config_file" 2>/dev/null || grep -q "tunnel: ${tunnel_name}" "$config_file" 2>/dev/null; then
      if confirm "Quieres borrar la config local de cloudflared $config_file?" "y"; then
        delete_path "$config_file"
      fi
    else
      warn "$config_file no parece exclusivo de WIFITEST; se conserva."
    fi
  fi

  if [ -f "$HOME/.cloudflared/cert.pem" ]; then
    if confirm "Quieres borrar tambien el login global de Cloudflare (~/.cloudflared/cert.pem)?" "n"; then
      delete_path "$HOME/.cloudflared/cert.pem"
    fi
  fi

  delete_empty_dir "$HOME/.cloudflared"
}

remove_project_local_files() {
  log "Ficheros locales, secretos y artefactos"

  local paths=(
    "$BACKEND_ENV_FILE"
    "$CHAT_ENV_FILE"
    "$ROOT_DIR/.env"
    "$FRONTEND_DIR/.env"
    "$LOCAL_CONFIG_FILE"
    "$BACKEND_DIR/.venv"
    "$CHAT_SERVICE_DIR/.venv"
    "$ROOT_DIR/.venv"
    "$FRONTEND_DIR/node_modules"
    "$FRONTEND_DIR/dist"
    "$FRONTEND_DIR/src-tauri/target"
    "$BACKEND_DIR/wifitest_mcp.egg-info"
    "$ROOT_DIR/dump.rdb"
    "$ROOT_DIR/scripts/dump.rdb"
    "$BACKEND_DIR/dump.rdb"
    "$CHAT_SERVICE_DIR/dump.rdb"
  )
  local path

  for path in "${paths[@]}"; do
    delete_path "$path"
  done

  while IFS= read -r path; do
    delete_path "$path"
  done < <(find "$ROOT_DIR" -type d -name "__pycache__" -not -path "$ROOT_DIR/.git/*" 2>/dev/null || true)

  delete_empty_dir "$CONFIG_DIR"
}

standard_packages_for_manager() {
  case "$PACKAGE_MANAGER" in
    pacman)
      STANDARD_PACKAGES=(
        redis aircrack-ng reaver webkit2gtk-4.1 gtk3 librsvg xdotool
        libayatana-appindicator cloudflared
      )
      ;;
    apt)
      STANDARD_PACKAGES=(
        redis-server redis valkey-server aircrack-ng reaver
        libglib2.0-dev libwebkit2gtk-4.1-dev libgtk-3-dev libgtk-3-common
        libayatana-appindicator3-dev librsvg2-dev libxdo-dev
        cloudflared podman docker.io
      )
      ;;
    dnf)
      STANDARD_PACKAGES=(
        redis aircrack-ng reaver webkit2gtk4.1-devel gtk3-devel
        libappindicator-gtk3-devel librsvg2-devel xdotool-devel cloudflared
      )
      ;;
    zypper)
      STANDARD_PACKAGES=(
        redis aircrack-ng reaver webkit2gtk-4_1-devel gtk3-devel
        libayatana-appindicator3-devel librsvg-devel xdotool-devel cloudflared
      )
      ;;
    *) STANDARD_PACKAGES=() ;;
  esac
}

aggressive_packages_for_manager() {
  case "$PACKAGE_MANAGER" in
    pacman)
      AGGRESSIVE_PACKAGES=(
        git base-devel python-pip python-virtualenv nodejs npm rustup
        iw iproute2 networkmanager net-tools curl wget file openssl pkgconf
      )
      ;;
    apt)
      AGGRESSIVE_PACKAGES=(
        git build-essential python3-venv python3-pip nodejs npm
        iw iproute2 network-manager net-tools iputils-ping rfkill
        curl wget file openssl pkg-config libssl-dev
      )
      ;;
    dnf)
      AGGRESSIVE_PACKAGES=(
        git gcc gcc-c++ make python3-pip nodejs npm cargo rust
        iw iproute NetworkManager net-tools iputils curl wget file
        openssl-devel pkgconf-pkg-config
      )
      ;;
    zypper)
      AGGRESSIVE_PACKAGES=(
        git patterns-devel-base-devel_basis python3-pip nodejs npm cargo rust
        iw iproute2 NetworkManager net-tools curl wget file libopenssl-devel pkg-config
      )
      ;;
    *) AGGRESSIVE_PACKAGES=() ;;
  esac
}

remove_packages() {
  if [ "$REMOVE_SYSTEM_DEPS" != "1" ]; then
    log "Dependencias de sistema"
    info "Se conservan. Usa --remove-system-deps si quieres ofrecer su eliminacion."
    return
  fi

  detect_package_manager
  if [ -z "$PACKAGE_MANAGER" ]; then
    warn "No se ha detectado un gestor de paquetes soportado."
    return
  fi

  standard_packages_for_manager
  aggressive_packages_for_manager

  local candidates=("${STANDARD_PACKAGES[@]}")
  if [ "$REMOVE_AGGRESSIVE_DEPS" = "1" ]; then
    candidates+=("${AGGRESSIVE_PACKAGES[@]}")
  fi

  local installed=()
  local package
  for package in "${candidates[@]}"; do
    if package_installed "$package"; then
      installed+=("$package")
    fi
  done

  log "Dependencias de sistema"
  if [ "${#installed[@]}" -eq 0 ]; then
    info "No se han encontrado paquetes candidatos instalados."
    return
  fi

  warn "Estos paquetes pueden estar compartidos con otras aplicaciones:"
  printf '  %s\n' "${installed[@]}"

  if [ "$REMOVE_AGGRESSIVE_DEPS" = "1" ]; then
    warn "Modo agresivo activo: la lista incluye paquetes basicos como node, git, toolchains o NetworkManager."
  fi

  if ! confirm "Quieres desinstalar estos paquetes del sistema?" "n"; then
    return
  fi

  case "$PACKAGE_MANAGER" in
    pacman) run_sudo pacman -Rns "${installed[@]}" ;;
    apt)
      run_sudo apt-get purge -y "${installed[@]}"
      run_sudo apt-get autoremove -y
      ;;
    dnf) run_sudo dnf remove -y "${installed[@]}" ;;
    zypper) run_sudo zypper remove -y "${installed[@]}" ;;
  esac
}

remove_rustup_home() {
  if [ ! -d "$HOME/.rustup" ] && [ ! -d "$HOME/.cargo" ]; then
    return
  fi

  log "Rust de usuario"
  warn "El instalador pudo instalar Rust con rustup, pero ~/.cargo y ~/.rustup pueden ser usados por otros proyectos."
  if confirm "Quieres eliminar Rust de usuario (~/.cargo y ~/.rustup)?" "n"; then
    if command -v rustup >/dev/null 2>&1 && [ "$DRY_RUN" != "1" ]; then
      rustup self uninstall -y || true
    else
      delete_path "$HOME/.cargo"
      delete_path "$HOME/.rustup"
    fi
  fi
}

remove_project_directory() {
  if [ "$REMOVE_PROJECT_DIR" != "1" ]; then
    return
  fi

  log "Directorio del proyecto"
  warn "Esto borrara el repo completo: $ROOT_DIR"
  if confirm "Quieres borrar completamente el directorio del proyecto?" "n"; then
    cd "$(dirname "$ROOT_DIR")"
    delete_path "$ROOT_DIR"
  fi
}

main() {
  parse_args "$@"

  cd "$ROOT_DIR"
  log "Desinstalador Linux de WIFITEST"
  [ "$DRY_RUN" = "1" ] && warn "Modo dry-run activo: no se borrara nada."

  stop_running_wifitest_processes
  remove_redis_data
  remove_redis_container
  remove_cloudflare_config
  remove_project_local_files
  remove_packages
  remove_rustup_home
  remove_project_directory

  log "Desinstalacion finalizada"
  info "Si no borraste el directorio del proyecto, el codigo fuente permanece en: $ROOT_DIR"
}

main "$@"
