#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend/MCP"
FRONTEND_DIR="$ROOT_DIR/frontend"
CHAT_SERVICE_DIR="$ROOT_DIR/chat_service"
CONFIG_DIR="$ROOT_DIR/config"
LOCAL_CONFIG_FILE="$CONFIG_DIR/local.json"
BACKEND_ENV_FILE="$BACKEND_DIR/.env"
CHAT_ENV_FILE="$CHAT_SERVICE_DIR/.env"

ASSUME_YES="${ASSUME_YES:-0}"
FORCE_PIP_INSTALL="${FORCE_PIP_INSTALL:-0}"
FORCE_NPM_INSTALL="${FORCE_NPM_INSTALL:-0}"
AIRMON_MONITOR_INTERFACE=""
CONTAINER_RUNTIME=""
CONTAINER_USE_SUDO=0

DISTRO_ID="unknown"
DISTRO_LIKE=""
PACKAGE_MANAGER=""

if [ -d "$HOME/.cargo/bin" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

log() {
  printf '\n==> %s\n' "$*"
}

info() {
  printf '  %s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
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

prompt_value() {
  local question="$1"
  local default="${2:-}"
  local answer

  if [ -n "$default" ]; then
    read -r -p "$question [$default]: " answer
    printf '%s' "${answer:-$default}"
  else
    read -r -p "$question: " answer
    printf '%s' "$answer"
  fi
}

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

detect_distro() {
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_LIKE="${ID_LIKE:-}"
  fi

  if command -v pacman >/dev/null 2>&1; then
    PACKAGE_MANAGER="pacman"
  elif command -v apt-get >/dev/null 2>&1; then
    PACKAGE_MANAGER="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PACKAGE_MANAGER="dnf"
  elif command -v zypper >/dev/null 2>&1; then
    PACKAGE_MANAGER="zypper"
  else
    die "No se ha encontrado un gestor de paquetes soportado: pacman, apt, dnf o zypper."
  fi

  info "Distro detectada: $DISTRO_ID ${DISTRO_LIKE:+($DISTRO_LIKE)}"
  info "Gestor de paquetes: $PACKAGE_MANAGER"
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

package_available() {
  local package="$1"
  local candidate=""

  case "$PACKAGE_MANAGER" in
    apt)
      candidate="$(apt-cache policy "$package" 2>/dev/null | awk '/Candidate:/ { print $2; exit }')"
      [ -n "$candidate" ] && [ "$candidate" != "(none)" ]
      ;;
    *)
      return 0
      ;;
  esac
}

packages_for_manager() {
  case "$PACKAGE_MANAGER" in
    pacman)
      PACKAGES=(
        git base-devel
        python python-pip python-virtualenv
        nodejs npm rustup
        redis
        aircrack-ng reaver iw iproute2 networkmanager net-tools
        curl wget file openssl pkgconf
        webkit2gtk-4.1 gtk3 librsvg xdotool libayatana-appindicator
      )
      ;;
    apt)
      PACKAGES=(
        git build-essential
        python3 python3-venv python3-pip
        nodejs npm
        aircrack-ng reaver iw iproute2 network-manager net-tools iputils-ping rfkill
        curl wget file openssl pkg-config libssl-dev
        libglib2.0-dev
        libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev
      )
      ;;
    dnf)
      PACKAGES=(
        git gcc gcc-c++ make
        python3 python3-pip
        nodejs npm cargo rust
        redis
        aircrack-ng reaver iw iproute NetworkManager net-tools iputils
        curl wget file openssl-devel pkgconf-pkg-config
        webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel xdotool-devel
      )
      ;;
    zypper)
      PACKAGES=(
        git patterns-devel-base-devel_basis
        python3 python3-pip
        nodejs npm cargo rust
        redis
        aircrack-ng reaver iw iproute2 NetworkManager net-tools
        curl wget file libopenssl-devel pkg-config
        webkit2gtk-4_1-devel gtk3-devel libayatana-appindicator3-devel librsvg-devel xdotool-devel
      )
      ;;
    *)
      die "Gestor de paquetes no soportado: $PACKAGE_MANAGER"
      ;;
  esac
}

install_missing_packages() {
  local missing=()
  local package

  packages_for_manager

  for package in "${PACKAGES[@]}"; do
    if package_installed "$package"; then
      continue
    fi

    missing+=("$package")
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    info "Dependencias del sistema ya instaladas."
    return
  fi

  log "Dependencias pendientes"
  printf '  %s\n' "${missing[@]}"

  if ! confirm "Quieres instalar las dependencias que faltan?" "y"; then
    warn "Se omite la instalacion de paquetes. Algunos pasos pueden fallar."
    return
  fi

  case "$PACKAGE_MANAGER" in
    pacman)
      run_sudo pacman -Syu --needed "${missing[@]}"
      ;;
    apt)
      run_sudo apt-get update
      local installable=()
      local unavailable=()
      local failed=()

      for package in "${missing[@]}"; do
        if package_available "$package"; then
          installable+=("$package")
        elif [ "$package" = "libgtk-3-dev" ] && package_available "libgtk-3-common"; then
          unavailable+=("$package")
          if package_installed "libgtk-3-common"; then
            warn "libgtk-3-dev no esta disponible; libgtk-3-common ya esta instalado como fallback."
          else
            warn "libgtk-3-dev no esta disponible; se instalara libgtk-3-common como fallback."
            installable+=("libgtk-3-common")
          fi
        else
          unavailable+=("$package")
        fi
      done

      if [ "${#unavailable[@]}" -gt 0 ]; then
        warn "Se omiten paquetes sin candidato en los repositorios actuales:"
        printf '  %s\n' "${unavailable[@]}" >&2
      fi

      for package in "${installable[@]}"; do
        if ! run_sudo apt-get install -y "$package"; then
          failed+=("$package")
        fi
      done

      if [ "${#failed[@]}" -gt 0 ]; then
        warn "No se pudieron instalar estos paquetes apt:"
        printf '  %s\n' "${failed[@]}" >&2
      fi
      ;;
    dnf)
      run_sudo dnf install -y "${missing[@]}"
      ;;
    zypper)
      run_sudo zypper install -y "${missing[@]}"
      ;;
  esac
}

redis_runtime_available() {
  if redis_port_open; then
    return 0
  fi

  if command -v redis-server >/dev/null 2>&1 || command -v valkey-server >/dev/null 2>&1; then
    return 0
  fi

  if command -v redis-cli >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1; then
    return 0
  fi

  if command -v valkey-cli >/dev/null 2>&1 && valkey-cli ping >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

redis_port_open() {
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi

  python3 -c 'import socket, sys; s=socket.socket(); s.settimeout(0.5); sys.exit(0 if s.connect_ex(("127.0.0.1", 6379)) == 0 else 1)' >/dev/null 2>&1
}

detect_container_runtime() {
  CONTAINER_RUNTIME=""
  CONTAINER_USE_SUDO=0

  if command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    CONTAINER_RUNTIME="podman"
    return 0
  fi

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    CONTAINER_RUNTIME="docker"
    return 0
  fi

  if command -v docker >/dev/null 2>&1 && run_sudo docker info >/dev/null 2>&1; then
    CONTAINER_RUNTIME="docker"
    CONTAINER_USE_SUDO=1
    return 0
  fi

  return 1
}

container_cmd() {
  if [ "$CONTAINER_USE_SUDO" = "1" ]; then
    run_sudo "$CONTAINER_RUNTIME" "$@"
    return
  fi

  "$CONTAINER_RUNTIME" "$@"
}

ensure_container_runtime_dependency() {
  local candidates=()
  local package=""

  if detect_container_runtime; then
    info "Runtime de contenedores disponible: $CONTAINER_RUNTIME"
    return 0
  fi

  if [ "$PACKAGE_MANAGER" != "apt" ]; then
    warn "No se ha encontrado Docker/Podman para arrancar Redis en contenedor."
    return 1
  fi

  candidates=(podman docker.io)

  if ! confirm "No hay Redis/Valkey nativo. Quieres instalar Podman/Docker para arrancar Redis en contenedor?" "y"; then
    return 1
  fi

  run_sudo apt-get update
  for package in "${candidates[@]}"; do
    if package_available "$package"; then
      if run_sudo apt-get install -y "$package"; then
        if [ "$package" = "docker.io" ] && command -v systemctl >/dev/null 2>&1; then
          run_sudo systemctl enable --now docker.service || warn "No se pudo activar docker.service."
        fi

        if detect_container_runtime; then
          info "Runtime de contenedores preparado: $CONTAINER_RUNTIME"
          return 0
        fi
      fi
    fi
  done

  warn "No se ha podido instalar Podman/Docker desde apt."
  return 1
}

start_redis_container() {
  local container_name="wifitest-redis"
  local image="docker.io/library/redis:7-alpine"

  if redis_port_open; then
    info "Ya hay un servicio escuchando en 127.0.0.1:6379."
    return 0
  fi

  if ! ensure_container_runtime_dependency; then
    return 1
  fi

  if container_cmd ps --format '{{.Names}}' 2>/dev/null | grep -Fxq "$container_name"; then
    info "El contenedor $container_name ya esta en ejecucion."
    return 0
  fi

  if container_cmd ps -a --format '{{.Names}}' 2>/dev/null | grep -Fxq "$container_name"; then
    info "Arrancando contenedor Redis existente: $container_name"
    container_cmd start "$container_name"
    sleep 2
    redis_port_open
    return
  fi

  info "Creando contenedor Redis local: $container_name"
  container_cmd run -d \
    --name "$container_name" \
    --restart unless-stopped \
    -p 127.0.0.1:6379:6379 \
    "$image"
  sleep 2
  redis_port_open
}

ensure_redis_dependency() {
  local candidates=()
  local package=""

  if redis_runtime_available; then
    info "Redis/Valkey ya esta disponible."
    return
  fi

  if [ "$PACKAGE_MANAGER" != "apt" ]; then
    warn "No se ha encontrado Redis/Valkey. Instala Redis o Valkey antes de arrancar la app."
    return
  fi

  candidates=(redis-server redis valkey-server)

  log "Preparando Redis/Valkey"
  run_sudo apt-get update

  for package in "${candidates[@]}"; do
    if package_available "$package"; then
      if run_sudo apt-get install -y "$package"; then
        info "Redis/Valkey instalado mediante paquete apt: $package"
        return
      fi
    fi
  done

  warn "No se ha encontrado ningun paquete apt compatible para Redis/Valkey."
  if start_redis_container; then
    info "Redis queda disponible en 127.0.0.1:6379 mediante contenedor."
    return
  fi

  warn "Sin Redis/Valkey el MCP y el chat no podran procesar jobs."
}

ensure_services() {
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl no esta disponible. Inicia Redis/Valkey y NetworkManager manualmente."
    return
  fi

  if systemctl list-unit-files NetworkManager.service >/dev/null 2>&1; then
    log "Activando NetworkManager"
    run_sudo systemctl enable --now NetworkManager.service || warn "No se pudo activar NetworkManager."
  fi

  if systemctl list-unit-files redis.service >/dev/null 2>&1; then
    log "Activando Redis"
    if ! run_sudo systemctl enable --now redis.service; then
      warn "No se pudo activar redis.service; probando redis-server.service."
      if systemctl list-unit-files redis-server.service >/dev/null 2>&1; then
        run_sudo systemctl enable --now redis-server.service || warn "No se pudo activar redis-server.service."
      fi
    fi
  elif systemctl list-unit-files redis-server.service >/dev/null 2>&1; then
    log "Activando Redis"
    run_sudo systemctl enable --now redis-server.service || warn "No se pudo activar redis-server.service."
  elif systemctl list-unit-files valkey.service >/dev/null 2>&1; then
    log "Activando Valkey"
    run_sudo systemctl enable --now valkey.service || warn "No se pudo activar valkey.service."
  fi
}

ensure_rust_toolchain() {
  if command -v rustup >/dev/null 2>&1; then
    if ! rustup show active-toolchain >/dev/null 2>&1; then
      log "Configurando Rust stable"
      rustup default stable
    fi
    return
  fi

  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    info "Rust ya esta disponible."
    return
  fi

  log "Preparando Rust"
  if ! command -v curl >/dev/null 2>&1; then
    warn "No se ha encontrado curl. Instala Rust manualmente con rustup antes de compilar Tauri."
    return
  fi

  if ! confirm "No se ha encontrado Rust completo. Quieres instalarlo con rustup en tu usuario?" "y"; then
    warn "Rust no queda instalado. La app podra preparar backend/chat, pero no compilar Tauri."
    return
  fi

  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  export PATH="$HOME/.cargo/bin:$PATH"
  rustup default stable
}

set_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"

  mkdir -p "$(dirname "$file")"
  touch "$file"

  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
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

detect_wifi_interfaces() {
  if ! command -v iw >/dev/null 2>&1; then
    warn "No se puede detectar Wi-Fi porque falta 'iw'."
    return 0
  fi

  iw dev 2>/dev/null | awk '$1 == "Interface" { print $2 }'
}

interface_exists() {
  local interface="$1"
  [ -n "$interface" ] && ip link show "$interface" >/dev/null 2>&1
}

get_interface_mode() {
  local interface="$1"
  iw dev "$interface" info 2>/dev/null | awk '/type/ { print $2; exit }'
}

networkmanager_sees_wifi_interface() {
  local interface="$1"

  command -v nmcli >/dev/null 2>&1 || return 1
  nmcli -t -f DEVICE,TYPE device status 2>/dev/null | grep -Fxq "${interface}:wifi"
}

find_monitor_interface_for() {
  local base_interface="$1"
  local normalized_base="${base_interface%mon}"
  local candidate

  for candidate in "$base_interface" "${normalized_base}mon" "$normalized_base"; do
    if interface_exists "$candidate" && [ "$(get_interface_mode "$candidate")" = "monitor" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  iw dev 2>/dev/null | awk -v base="$normalized_base" '
    $1 == "Interface" { iface = $2 }
    $1 == "type" && $2 == "monitor" && iface ~ "^" base { print iface; exit }
  '
}

restore_wifi_interface_after_check() {
  local base_interface="$1"
  local original_mode="$2"
  local monitor_interface="$3"
  local normalized_base="${base_interface%mon}"

  log "Restaurando interfaz Wi-Fi"

  if command -v rfkill >/dev/null 2>&1; then
    run_sudo rfkill unblock wifi >/dev/null 2>&1 || true
  fi

  if [ -n "$monitor_interface" ] && [ "$monitor_interface" != "$base_interface" ] && command -v airmon-ng >/dev/null 2>&1; then
    run_sudo airmon-ng stop "$monitor_interface" >/dev/null 2>&1 || true
  fi

  if interface_exists "$normalized_base" && [ "$original_mode" != "monitor" ]; then
    run_sudo ip link set "$normalized_base" down >/dev/null 2>&1 || true
    run_sudo iw dev "$normalized_base" set type managed >/dev/null 2>&1 || true
    run_sudo ip link set "$normalized_base" up >/dev/null 2>&1 || true
  elif interface_exists "$base_interface" && [ "$original_mode" != "monitor" ]; then
    run_sudo ip link set "$base_interface" down >/dev/null 2>&1 || true
    run_sudo iw dev "$base_interface" set type managed >/dev/null 2>&1 || true
    run_sudo ip link set "$base_interface" up >/dev/null 2>&1 || true
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_sudo systemctl start NetworkManager.service >/dev/null 2>&1 || true
  fi

  if command -v nmcli >/dev/null 2>&1; then
    run_sudo nmcli radio wifi on >/dev/null 2>&1 || true
    if interface_exists "$normalized_base"; then
      run_sudo nmcli device set "$normalized_base" managed yes >/dev/null 2>&1 || true
    fi
  fi

  sleep 2

  if ! networkmanager_sees_wifi_interface "$normalized_base" && command -v systemctl >/dev/null 2>&1; then
    run_sudo systemctl restart NetworkManager.service >/dev/null 2>&1 || true
    sleep 2
    run_sudo ip link set "$normalized_base" up >/dev/null 2>&1 || true
    if command -v nmcli >/dev/null 2>&1; then
      run_sudo nmcli radio wifi on >/dev/null 2>&1 || true
      run_sudo nmcli device set "$normalized_base" managed yes >/dev/null 2>&1 || true
    fi
  fi
}

try_direct_monitor_mode() {
  local interface="$1"

  info "Probando cambio directo a modo monitor con iw..."
  if command -v nmcli >/dev/null 2>&1; then
    run_sudo nmcli device disconnect "$interface" >/dev/null 2>&1 || true
    run_sudo nmcli device set "$interface" managed no >/dev/null 2>&1 || true
  fi
  run_sudo ip link set "$interface" down
  run_sudo iw dev "$interface" set type monitor
  run_sudo ip link set "$interface" up
  sleep 2

  [ "$(get_interface_mode "$interface")" = "monitor" ]
}

try_airmon_monitor_mode() {
  local interface="$1"
  local monitor_interface=""
  AIRMON_MONITOR_INTERFACE=""

  if ! command -v airmon-ng >/dev/null 2>&1; then
    return 1
  fi

  info "Probando modo monitor con airmon-ng..."
  run_sudo airmon-ng start "$interface" >/dev/null 2>&1 || true
  sleep 3
  monitor_interface="$(find_monitor_interface_for "$interface")"

  if [ -n "$monitor_interface" ]; then
    AIRMON_MONITOR_INTERFACE="$monitor_interface"
    return 0
  fi

  if confirm "airmon-ng no ha conseguido entrar en monitor. Quieres ejecutar 'airmon-ng check kill' y reintentar? Esto corta Wi-Fi temporalmente." "n"; then
    run_sudo airmon-ng check kill >/dev/null 2>&1 || true
    run_sudo airmon-ng start "$interface" >/dev/null 2>&1 || true
    sleep 3
    monitor_interface="$(find_monitor_interface_for "$interface")"
    if [ -n "$monitor_interface" ]; then
      AIRMON_MONITOR_INTERFACE="$monitor_interface"
      return 0
    fi
  fi

  return 1
}

count_capture_rows() {
  local csv_file="$1"
  awk -F',' '
    $1 ~ /^[[:space:]]*([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}[[:space:]]*$/ { count++ }
    END { print count + 0 }
  ' "$csv_file"
}

run_airodump_capture_check() {
  local monitor_interface="$1"
  local tmp_dir=""
  local output_prefix=""
  local csv_file=""
  local rows="0"
  local command_status=0

  tmp_dir="$(mktemp -d)"
  output_prefix="$tmp_dir/wifitest-capture"
  csv_file="$output_prefix-01.csv"

  info "Lanzando captura corta con airodump-ng en $monitor_interface..."
  set +e
  run_sudo timeout --foreground --signal=INT 8s \
    airodump-ng --write "$output_prefix" --output-format csv "$monitor_interface" \
    >/tmp/wifitest-airodump-check.out 2>/tmp/wifitest-airodump-check.err
  command_status=$?
  set -e

  if [ "$command_status" -ne 0 ] && [ "$command_status" -ne 124 ] && [ "$command_status" -ne 130 ]; then
    warn "airodump-ng termino con codigo $command_status."
  fi

  if [ ! -s "$csv_file" ]; then
    warn "airodump-ng no ha generado CSV. La antena no parece capturar correctamente."
    rm -rf "$tmp_dir"
    return 1
  fi

  rows="$(count_capture_rows "$csv_file")"
  rm -rf "$tmp_dir"

  if [ "$rows" -gt 0 ]; then
    info "Captura valida: se han observado $rows fila(s) con MAC en el CSV."
    return 0
  fi

  warn "La antena entra en monitor y genera CSV, pero no se han observado paquetes durante la prueba."
  warn "Puede ser una zona sin redes visibles, un canal/banda concreto o un problema de driver."
  return 2
}

verify_wifi_adapter_capability() {
  local interface="$1"
  local original_mode=""
  local monitor_interface=""
  local capture_status=1
  local direct_status=1
  local airmon_status=1

  if ! command -v iw >/dev/null 2>&1 || ! command -v ip >/dev/null 2>&1; then
    warn "No se puede verificar la antena porque faltan 'iw' o 'ip'."
    return
  fi

  if ! command -v airodump-ng >/dev/null 2>&1; then
    warn "No se puede verificar captura porque falta 'airodump-ng'."
    return
  fi

  if ! command -v timeout >/dev/null 2>&1; then
    warn "No se puede verificar captura porque falta 'timeout'."
    return
  fi

  if ! interface_exists "$interface"; then
    warn "No se puede verificar '$interface' porque no existe ahora mismo."
    return
  fi

  log "Prueba de antena Wi-Fi"
  info "Esta prueba puede cortar temporalmente la conexion Wi-Fi."
  info "Se probara modo monitor y una captura corta de unos segundos."

  if ! confirm "Quieres ejecutar la prueba de aptitud de la antena ahora?" "y"; then
    info "Prueba de antena omitida."
    return
  fi

  run_sudo true
  original_mode="$(get_interface_mode "$interface")"

  set +e
  try_direct_monitor_mode "$interface"
  direct_status=$?
  set -e

  if [ "$direct_status" -eq 0 ]; then
    monitor_interface="$interface"
  else
    warn "El cambio directo a monitor no ha funcionado."
    restore_wifi_interface_after_check "$interface" "$original_mode" "$monitor_interface"
    if confirm "Quieres probar con airmon-ng como alternativa?" "y"; then
      set +e
      try_airmon_monitor_mode "$interface"
      airmon_status=$?
      set -e
      if [ "$airmon_status" -ne 0 ]; then
        warn "No se ha podido poner la interfaz en modo monitor."
        restore_wifi_interface_after_check "$interface" "$original_mode" "$monitor_interface"
        set_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_ADAPTER_CHECK" "failed_monitor"
        return
      fi
      monitor_interface="$AIRMON_MONITOR_INTERFACE"
    else
      set_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_ADAPTER_CHECK" "skipped_after_direct_failure"
      return
    fi
  fi

  if [ -z "$monitor_interface" ]; then
    monitor_interface="$(find_monitor_interface_for "$interface")"
  fi

  if [ -z "$monitor_interface" ]; then
    warn "No se ha encontrado una interfaz monitor tras el cambio."
    restore_wifi_interface_after_check "$interface" "$original_mode" "$monitor_interface"
    set_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_ADAPTER_CHECK" "failed_monitor"
    return
  fi

  info "Interfaz monitor activa: $monitor_interface"
  set +e
  run_airodump_capture_check "$monitor_interface"
  capture_status=$?
  set -e

  restore_wifi_interface_after_check "$interface" "$original_mode" "$monitor_interface"

  if ! networkmanager_sees_wifi_interface "${interface%mon}"; then
    set_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_ADAPTER_CHECK" "restore_failed_networkmanager"
    warn "La captura termino, pero NetworkManager no ve la interfaz restaurada como Wi-Fi."
    warn "Ejecuta: sudo rfkill unblock wifi; sudo ip link set ${interface%mon} up; sudo systemctl restart NetworkManager; sudo nmcli radio wifi on; sudo nmcli device set ${interface%mon} managed yes"
    return
  fi

  case "$capture_status" in
    0)
      set_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_ADAPTER_CHECK" "passed"
      info "Antena apta: modo monitor y captura verificados."
      ;;
    2)
      set_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_ADAPTER_CHECK" "monitor_ok_capture_empty"
      warn "Antena parcialmente verificada: modo monitor OK, captura sin paquetes observados."
      ;;
    *)
      set_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_ADAPTER_CHECK" "failed_capture"
      warn "La antena entra en monitor, pero la captura no se ha verificado correctamente."
      ;;
  esac
}

choose_wifi_interface() {
  local configured_interface=""
  local interfaces=()
  local selected=""
  local answer=""
  local index=1

  configured_interface="$(read_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_INTERFACE" || true)"

  mapfile -t interfaces < <(detect_wifi_interfaces)

  if [ -n "$configured_interface" ] && interface_exists "$configured_interface"; then
    if confirm "Ya hay una interfaz configurada ($configured_interface). Quieres mantenerla?" "y"; then
      selected="$configured_interface"
    fi
  fi

  if [ -z "$selected" ]; then
    if [ "${#interfaces[@]}" -eq 0 ]; then
      warn "No se han detectado interfaces Wi-Fi ahora mismo."
      selected="$(prompt_value "Nombre de la interfaz Wi-Fi que quieres usar" "${configured_interface:-wlan0}")"
    elif [ "${#interfaces[@]}" -eq 1 ]; then
      selected="${interfaces[0]}"
      if ! confirm "Se ha detectado '$selected'. Quieres usar esta interfaz?" "y"; then
        selected="$(prompt_value "Nombre de la interfaz Wi-Fi que quieres usar" "$selected")"
      fi
    else
      log "Interfaces Wi-Fi detectadas"
      for interface in "${interfaces[@]}"; do
        local mode
        mode="$(iw dev "$interface" info 2>/dev/null | awk '/type/ { print $2; exit }')"
        printf '  %s) %s%s\n' "$index" "$interface" "${mode:+ ($mode)}"
        index=$((index + 1))
      done

      answer="$(prompt_value "Elige numero o escribe el nombre de la interfaz" "1")"
      if [[ "$answer" =~ ^[0-9]+$ ]] && [ "$answer" -ge 1 ] && [ "$answer" -le "${#interfaces[@]}" ]; then
        selected="${interfaces[$((answer - 1))]}"
      else
        selected="$answer"
      fi
    fi
  fi

  if [ -z "$selected" ]; then
    die "No se ha elegido ninguna interfaz Wi-Fi."
  fi

  if command -v iw >/dev/null 2>&1; then
    if iw list 2>/dev/null | grep -qE '^[[:space:]]*\*[[:space:]]+monitor\b'; then
      info "El sistema anuncia soporte para modo monitor."
    else
      warn "No se ha encontrado 'monitor' en 'iw list'. La antena/driver puede no servir para escaneos."
    fi
  fi

  mkdir -p "$CONFIG_DIR"
  printf '{\n  "default_wifi_interface": "%s"\n}\n' "$selected" > "$LOCAL_CONFIG_FILE"
  chmod 600 "$LOCAL_CONFIG_FILE"

  set_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_INTERFACE" "$selected"
  set_env_var "$BACKEND_ENV_FILE" "REDIS_URL" "redis://127.0.0.1:6379/0"
  chmod 600 "$BACKEND_ENV_FILE"

  info "Interfaz configurada para WIFITEST: $selected"
}

setup_backend_python() {
  log "Preparando entorno Python del MCP"
  cd "$BACKEND_DIR"

  if [ ! -d .venv ]; then
    python3 -m venv .venv
  fi

  if [ "$FORCE_PIP_INSTALL" = "1" ] || ! ./.venv/bin/python -c "import mcp, redis" >/dev/null 2>&1; then
    ./.venv/bin/python -m pip install --upgrade pip
    ./.venv/bin/python -m pip install -e .
  else
    info "Dependencias Python del MCP ya disponibles."
  fi
}

setup_chat_python() {
  if [ ! -d "$CHAT_SERVICE_DIR" ]; then
    return
  fi

  log "Preparando entorno Python del chat"
  cd "$CHAT_SERVICE_DIR"

  if [ ! -d .venv ]; then
    python3 -m venv .venv
  fi

  if [ "$FORCE_PIP_INSTALL" = "1" ] || ! ./.venv/bin/python -c "import fastapi, openai, redis, uvicorn" >/dev/null 2>&1; then
    ./.venv/bin/python -m pip install --upgrade pip
    ./.venv/bin/python -m pip install -r requirements.txt
  else
    info "Dependencias Python del chat ya disponibles."
  fi
}

setup_frontend() {
  log "Preparando frontend"
  cd "$FRONTEND_DIR"

  if [ "$FORCE_NPM_INSTALL" = "1" ] || [ ! -d node_modules ]; then
    npm install
  else
    info "node_modules ya existe. Se omite npm install."
  fi
}

ensure_cloudflared_installed() {
  if command -v cloudflared >/dev/null 2>&1; then
    info "cloudflared ya esta instalado."
    return 0
  fi

  log "Instalacion de cloudflared"

  case "$PACKAGE_MANAGER" in
    pacman)
      if command -v yay >/dev/null 2>&1; then
        yay -S --needed cloudflared
      elif command -v paru >/dev/null 2>&1; then
        paru -S --needed cloudflared
      else
        warn "En Arch/Endeavour instala cloudflared con AUR, por ejemplo: yay -S cloudflared"
        return 1
      fi
      ;;
    apt)
      local arch deb_file
      arch="$(uname -m)"
      case "$arch" in
        x86_64) arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        *) warn "Arquitectura no soportada automaticamente para cloudflared: $arch"; return 1 ;;
      esac
      deb_file="/tmp/cloudflared-linux-${arch}.deb"
      wget -O "$deb_file" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
      run_sudo apt-get install -y "$deb_file"
      ;;
    dnf|zypper)
      local arch rpm_file
      arch="$(uname -m)"
      case "$arch" in
        x86_64) arch="x86_64" ;;
        aarch64|arm64) arch="aarch64" ;;
        *) warn "Arquitectura no soportada automaticamente para cloudflared: $arch"; return 1 ;;
      esac
      rpm_file="/tmp/cloudflared-linux-${arch}.rpm"
      wget -O "$rpm_file" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.rpm"
      if [ "$PACKAGE_MANAGER" = "dnf" ]; then
        run_sudo dnf install -y "$rpm_file"
      else
        run_sudo zypper install -y "$rpm_file"
      fi
      ;;
  esac
}

get_tunnel_id() {
  local tunnel_name="$1"
  local tunnel_id=""

  tunnel_id="$(cloudflared tunnel info "$tunnel_name" 2>/dev/null | awk '/ID:/ { print $2; exit }')"
  if [ -n "$tunnel_id" ]; then
    printf '%s' "$tunnel_id"
    return 0
  fi

  cloudflared tunnel list 2>/dev/null | awk -v name="$tunnel_name" '$2 == name { print $1; exit }'
}

write_cloudflared_config() {
  local tunnel_name="$1"
  local tunnel_id="$2"
  local hostname="$3"
  local config_file="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
  local credentials_file="$HOME/.cloudflared/${tunnel_id}.json"

  if [ -f "$config_file" ]; then
    if grep -q "hostname: $hostname" "$config_file" && grep -q "httpHostHeader: 127.0.0.1:8000" "$config_file"; then
      info "La configuracion de cloudflared ya parece preparada en $config_file."
      return
    fi

    if ! confirm "Ya existe $config_file. Quieres sobrescribirlo para WIFITEST?" "n"; then
      warn "No se ha modificado $config_file. Revisa que apunte a http://127.0.0.1:8000."
      return
    fi

    cp "$config_file" "${config_file}.bak.$(date +%Y%m%d%H%M%S)"
  fi

  mkdir -p "$(dirname "$config_file")"
  cat > "$config_file" <<EOF
tunnel: $tunnel_name
credentials-file: $credentials_file

ingress:
  - hostname: $hostname
    service: http://127.0.0.1:8000
    originRequest:
      httpHostHeader: 127.0.0.1:8000
  - service: http_status:404
EOF
  chmod 600 "$config_file"
  info "Configuracion escrita en $config_file."
}

configure_chat_env() {
  local mcp_url="${1:-}"
  local existing_key=""

  mkdir -p "$CHAT_SERVICE_DIR"
  touch "$CHAT_ENV_FILE"
  chmod 600 "$CHAT_ENV_FILE"

  set_env_var "$CHAT_ENV_FILE" "OPENAI_MODEL" "$(read_env_var "$CHAT_ENV_FILE" "OPENAI_MODEL" || printf 'gpt-4.1-mini')"

  if [ -n "$mcp_url" ]; then
    set_env_var "$CHAT_ENV_FILE" "OPENAI_MCP_SERVER_URL" "$mcp_url"
  elif ! read_env_var "$CHAT_ENV_FILE" "OPENAI_MCP_SERVER_URL" >/dev/null 2>&1; then
    set_env_var "$CHAT_ENV_FILE" "OPENAI_MCP_SERVER_URL" "https://mcp.tudominio.com/mcp"
  fi

  existing_key="$(read_env_var "$CHAT_ENV_FILE" "OPENAI_API_KEY" || true)"
  if [ -z "$existing_key" ] && confirm "Quieres guardar ahora OPENAI_API_KEY para el chat?" "n"; then
    local openai_key
    read -r -s -p "OPENAI_API_KEY: " openai_key
    printf '\n'
    if [ -n "$openai_key" ]; then
      set_env_var "$CHAT_ENV_FILE" "OPENAI_API_KEY" "$openai_key"
    fi
  fi
}

configure_cloudflare() {
  log "Cloudflare Tunnel para el chat"
  info "Sin tunel, el dashboard y las tools locales pueden funcionar."
  info "El chat con OpenAI + MCP necesita una URL publica HTTPS porque OpenAI no puede llamar a localhost."
  info "Para usarlo necesitas una cuenta de Cloudflare y un dominio/subdominio gestionado en Cloudflare."

  local existing_tunnel existing_hostname existing_enabled
  existing_tunnel="$(read_env_var "$BACKEND_ENV_FILE" "TUNNEL_NAME" || true)"
  existing_hostname="$(read_env_var "$BACKEND_ENV_FILE" "TUNNEL_HOSTNAME" || true)"
  existing_enabled="$(read_env_var "$BACKEND_ENV_FILE" "TUNNEL_ENABLED" || true)"

  if ! confirm "Quieres configurar Cloudflare Tunnel ahora?" "n"; then
    if [ -n "$existing_tunnel" ] && [ -n "$existing_hostname" ] && [ "$existing_hostname" != "mcp.tudominio.com" ]; then
      info "Se conserva la configuracion Cloudflare existente: $existing_tunnel -> $existing_hostname."
      if [ "$existing_enabled" = "1" ]; then
        configure_chat_env "https://${existing_hostname}/mcp"
      else
        info "TUNNEL_ENABLED no esta activo. Para usar el tunel, pon TUNNEL_ENABLED=1 o vuelve a configurar Cloudflare."
        configure_chat_env ""
      fi
      return
    fi

    set_env_var "$BACKEND_ENV_FILE" "TUNNEL_ENABLED" "0"
    configure_chat_env ""
    info "No habia configuracion Cloudflare previa. Puedes arrancar el resto de la app sin chat MCP remoto."
    return
  fi

  if ! ensure_cloudflared_installed; then
    warn "No se pudo instalar cloudflared automaticamente."
    return
  fi

  mkdir -p "$HOME/.cloudflared"

  if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    info "Se abrira el login de Cloudflare. Elige la cuenta y el dominio que usaras."
    cloudflared tunnel login
  else
    info "Certificado de Cloudflare ya disponible."
  fi

  local current_tunnel current_hostname tunnel_name hostname tunnel_id
  current_tunnel="$(read_env_var "$BACKEND_ENV_FILE" "TUNNEL_NAME" || printf 'wifitest-mcp')"
  current_hostname="$(read_env_var "$BACKEND_ENV_FILE" "TUNNEL_HOSTNAME" || printf 'mcp.tudominio.com')"
  tunnel_name="$(prompt_value "Nombre del tunel" "$current_tunnel")"
  hostname="$(prompt_value "Hostname publico para el MCP" "$current_hostname")"

  if ! cloudflared tunnel info "$tunnel_name" >/dev/null 2>&1; then
    cloudflared tunnel create "$tunnel_name"
  else
    info "El tunel '$tunnel_name' ya existe."
  fi

  tunnel_id="$(get_tunnel_id "$tunnel_name")"
  if [ -z "$tunnel_id" ]; then
    warn "No se pudo obtener el ID del tunel. Revisa 'cloudflared tunnel list'."
    return
  fi

  if [ ! -f "$HOME/.cloudflared/${tunnel_id}.json" ]; then
    warn "No se ha encontrado $HOME/.cloudflared/${tunnel_id}.json."
    warn "Si el tunel ya existia en otra maquina, copia sus credenciales o crea un tunel nuevo."
  fi

  if confirm "Quieres crear/asociar el DNS $hostname al tunel?" "y"; then
    if ! cloudflared tunnel route dns "$tunnel_name" "$hostname"; then
      warn "No se pudo crear la ruta DNS. Si el registro ya existe, revisalo en Cloudflare."
    fi
  fi

  write_cloudflared_config "$tunnel_name" "$tunnel_id" "$hostname"

  set_env_var "$BACKEND_ENV_FILE" "TUNNEL_ENABLED" "1"
  set_env_var "$BACKEND_ENV_FILE" "TUNNEL_NAME" "$tunnel_name"
  set_env_var "$BACKEND_ENV_FILE" "TUNNEL_HOSTNAME" "$hostname"
  configure_chat_env "https://${hostname}/mcp"

  info "Cloudflare listo para exponer https://${hostname}/mcp cuando arranques dev-stack."
}

print_summary() {
  log "Instalacion preparada"
  info "Interfaz Wi-Fi: $(read_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_INTERFACE" || printf 'no configurada')"
  info "Prueba de antena: $(read_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_ADAPTER_CHECK" || printf 'no ejecutada')"
  info "Config local frontend: $LOCAL_CONFIG_FILE"
  info "Backend env: $BACKEND_ENV_FILE"
  info "Chat env: $CHAT_ENV_FILE"
  info "Arranque recomendado: ./scripts/dev-stack.sh"
  info "Si quieres forzar reinstalacion Python: FORCE_PIP_INSTALL=1 ./scripts/install-linux.sh"
  info "Si quieres forzar npm install: FORCE_NPM_INSTALL=1 ./scripts/install-linux.sh"
}

main() {
  cd "$ROOT_DIR"

  log "Instalador Linux de WIFITEST"
  detect_distro
  install_missing_packages
  ensure_redis_dependency
  ensure_services
  ensure_rust_toolchain
  choose_wifi_interface
  verify_wifi_adapter_capability "$(read_env_var "$BACKEND_ENV_FILE" "WIFITEST_WIFI_INTERFACE" || true)"
  setup_backend_python
  setup_chat_python
  setup_frontend
  configure_cloudflare
  print_summary
}

main "$@"
