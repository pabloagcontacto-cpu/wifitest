#!/bin/sh

set -eu

INTERFACE="${1:-wlan0}"
MONITOR_ALIAS="${INTERFACE}mon"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: no se ha encontrado el comando '$1' en PATH." >&2
    exit 1
  fi
}

get_interface_type() {
  iw dev "$1" info 2>/dev/null | awk '/type/ { print $2; exit }'
}

interface_exists() {
  ip link show "$1" >/dev/null 2>&1
}

is_monitor_interface() {
  if ! interface_exists "$1"; then
    return 1
  fi

  [ "$(get_interface_type "$1")" = "monitor" ]
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Error: este script necesita ejecutarse como root." >&2
    echo "Ejemplo: sudo ./scripts/enable-monitor-mode.sh ${INTERFACE}" >&2
    exit 1
  fi
}

require_command iw
require_command ip
require_root

if is_monitor_interface "$INTERFACE"; then
  echo "La interfaz '${INTERFACE}' ya esta en modo monitor. No hay nada que hacer."
  exit 0
fi

if is_monitor_interface "$MONITOR_ALIAS"; then
  echo "La interfaz monitor '${MONITOR_ALIAS}' ya existe. No hay nada que hacer."
  exit 0
fi

if ! interface_exists "$INTERFACE"; then
  echo "Error: la interfaz '${INTERFACE}' no existe y tampoco se ha detectado '${MONITOR_ALIAS}' en modo monitor." >&2
  exit 1
fi

echo "Poniendo '${INTERFACE}' en modo monitor..."
ip link set "$INTERFACE" down
iw dev "$INTERFACE" set type monitor
ip link set "$INTERFACE" up

if is_monitor_interface "$INTERFACE"; then
  echo "La interfaz '${INTERFACE}' ya esta en modo monitor."
  exit 0
fi

echo "Error: no se ha podido poner '${INTERFACE}' en modo monitor." >&2
exit 1
