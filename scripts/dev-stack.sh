#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKEND_DIR="$ROOT_DIR/backend/MCP"
FRONTEND_DIR="$ROOT_DIR/frontend"
CHAT_SERVICE_DIR="$ROOT_DIR/chat_service"
BACKEND_ENV_FILE="$BACKEND_DIR/.env"
FRONTEND_BINARY_DEFAULT="$FRONTEND_DIR/src-tauri/target/release/wifitest-frontend"

if [ -f "$BACKEND_ENV_FILE" ]; then
  set -a
  . "$BACKEND_ENV_FILE"
  set +a
fi

REDIS_STARTED=0
REDIS_PID=""
REDIS_CONTAINER_STARTED=0
REDIS_CONTAINER_RUNTIME=""
WORKER_PID=""
SERVER_PID=""
FRONTEND_PID=""
CLOUDFLARED_PID=""
CHAT_SERVICE_PID=""
CHAT_WORKER_PID=""
WORKER_USE_SUDO=0

CHAT_SERVICE_ENABLED="${CHAT_SERVICE_ENABLED:-1}"
CHAT_WORKER_ENABLED="${CHAT_WORKER_ENABLED:-1}"
CHAT_SERVICE_PORT="${CHAT_SERVICE_PORT:-8796}"
CHAT_REDIS_URL="${CHAT_REDIS_URL:-redis://127.0.0.1:6379/1}"
CHAT_TURN_QUEUE_KEY="${CHAT_TURN_QUEUE_KEY:-wifitest:chat:turns:queue}"
TUNNEL_ENABLED="${TUNNEL_ENABLED:-1}"
TUNNEL_NAME="${TUNNEL_NAME:-wifitest-mcp}"
TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-mcp.pablotests.xyz}"
CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"
FRONTEND_MODE="${FRONTEND_MODE:-dev}"
FRONTEND_DEV_SCRIPT="${FRONTEND_DEV_SCRIPT:-dev:safe}"
FRONTEND_BINARY="${FRONTEND_BINARY:-$FRONTEND_BINARY_DEFAULT}"
FRONTEND_RUNTIME_SAFE="${FRONTEND_RUNTIME_SAFE:-1}"

cleanup() {
  echo
  echo "Parando stack local..."

  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [ -n "$CHAT_WORKER_PID" ] && kill -0 "$CHAT_WORKER_PID" 2>/dev/null; then
    kill "$CHAT_WORKER_PID" 2>/dev/null || true
    wait "$CHAT_WORKER_PID" 2>/dev/null || true
  fi

  if [ -n "$CHAT_SERVICE_PID" ] && kill -0 "$CHAT_SERVICE_PID" 2>/dev/null; then
    kill "$CHAT_SERVICE_PID" 2>/dev/null || true
    wait "$CHAT_SERVICE_PID" 2>/dev/null || true
  fi

  if [ -n "$CLOUDFLARED_PID" ] && kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    kill "$CLOUDFLARED_PID" 2>/dev/null || true
    wait "$CLOUDFLARED_PID" 2>/dev/null || true
  fi

  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi

  if [ "$REDIS_STARTED" -eq 1 ] && [ -n "$REDIS_PID" ] && kill -0 "$REDIS_PID" 2>/dev/null; then
    kill "$REDIS_PID" 2>/dev/null || true
    wait "$REDIS_PID" 2>/dev/null || true
  fi

  if [ "$REDIS_CONTAINER_STARTED" -eq 1 ] && [ -n "$REDIS_CONTAINER_RUNTIME" ]; then
    "$REDIS_CONTAINER_RUNTIME" stop wifitest-redis >/dev/null 2>&1 || true
  fi
}

trap 'cleanup; exit 0' INT TERM
trap 'cleanup' EXIT

redis_port_open() {
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi

  python3 -c 'import socket, sys; s=socket.socket(); s.settimeout(0.5); sys.exit(0 if s.connect_ex(("127.0.0.1", 6379)) == 0 else 1)' >/dev/null 2>&1
}

start_redis_container_if_available() {
  for runtime in podman docker; do
    if ! command -v "$runtime" >/dev/null 2>&1; then
      continue
    fi

    if "$runtime" ps --format '{{.Names}}' 2>/dev/null | grep -Fxq wifitest-redis; then
      echo "Redis en contenedor ya estaba levantado ($runtime)."
      REDIS_CONTAINER_RUNTIME="$runtime"
      return 0
    fi

    if "$runtime" ps -a --format '{{.Names}}' 2>/dev/null | grep -Fxq wifitest-redis; then
      echo "Arrancando Redis en contenedor ($runtime)..."
      "$runtime" start wifitest-redis >/dev/null
      REDIS_CONTAINER_RUNTIME="$runtime"
      REDIS_CONTAINER_STARTED=1
      sleep 2
      redis_port_open
      return
    fi
  done

  return 1
}

start_redis_if_needed() {
  if command -v redis-cli >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1; then
    echo "Redis ya estaba levantado."
    return
  fi

  if command -v valkey-cli >/dev/null 2>&1 && valkey-cli ping >/dev/null 2>&1; then
    echo "Valkey ya estaba levantado."
    return
  fi

  if command -v redis-server >/dev/null 2>&1; then
    echo "Arrancando redis-server..."
    redis-server &
    REDIS_PID=$!
    REDIS_STARTED=1
    sleep 1
    return
  fi

  if command -v valkey-server >/dev/null 2>&1; then
    echo "Arrancando valkey-server..."
    valkey-server &
    REDIS_PID=$!
    REDIS_STARTED=1
    sleep 1
    return
  fi

  if redis_port_open; then
    echo "Redis/Valkey ya responde en 127.0.0.1:6379."
    return
  fi

  if start_redis_container_if_available; then
    return
  fi

  echo "No se ha encontrado Redis/Valkey instalado y no habia ninguna instancia levantada." >&2
  echo "Ejecuta ./scripts/install-linux.sh para instalar Redis o crear el contenedor wifitest-redis." >&2
  exit 1
}

ensure_port_available() {
  port="$1"
  label="$2"

  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" | grep -q ":$port"; then
    echo "$label no puede arrancar: el puerto $port ya esta ocupado." >&2
    echo "Cierra el proceso anterior o ejecuta: ss -ltnp 'sport = :$port'" >&2
    exit 1
  fi
}

ensure_worker_privileges() {
  if [ "$(id -u)" -eq 0 ]; then
    return
  fi

  echo "Solicitando permisos para el worker MCP..."
  sudo -v
  WORKER_USE_SUDO=1
}

run_backend_worker() {
  echo "Arrancando worker MCP..."
  (
    cd "$BACKEND_DIR"
    if [ "$WORKER_USE_SUDO" -eq 1 ]; then
      exec sudo -n env \
        PATH="$PATH" \
        REDIS_URL="${REDIS_URL:-}" \
        MCP_WORKER_NAME="${MCP_WORKER_NAME:-worker-1}" \
        ./.venv/bin/python worker.py
    fi

    exec ./.venv/bin/python worker.py
  ) &
  WORKER_PID=$!
}

run_backend_server() {
  echo "Arrancando servidor MCP..."
  (
    cd "$BACKEND_DIR"
    exec ./.venv/bin/python server.py
  ) &
  SERVER_PID=$!
}

run_cloudflared_tunnel() {
  if [ "$TUNNEL_ENABLED" != "1" ]; then
    echo "Tunel Cloudflare desactivado (TUNNEL_ENABLED=$TUNNEL_ENABLED)."
    return
  fi

  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared no esta instalado; se omite el tunel publico." >&2
    return
  fi

  if [ ! -f "$CLOUDFLARED_CONFIG" ]; then
    echo "No se ha encontrado la config de cloudflared en $CLOUDFLARED_CONFIG; se omite el tunel publico." >&2
    return
  fi

  echo "Arrancando tunel Cloudflare..."
  cloudflared tunnel \
    --config "$CLOUDFLARED_CONFIG" \
    run \
    --protocol "$CLOUDFLARED_PROTOCOL" \
    "$TUNNEL_NAME" &
  CLOUDFLARED_PID=$!
  sleep 2

  if ! kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    echo "cloudflared no ha podido arrancar. Revisa la configuracion del tunel." >&2
    CLOUDFLARED_PID=""
    return
  fi
}

run_chat_service() {
  if [ "$CHAT_SERVICE_ENABLED" != "1" ]; then
    echo "Servicio de chat desactivado (CHAT_SERVICE_ENABLED=$CHAT_SERVICE_ENABLED)."
    return
  fi

  if [ ! -x "$CHAT_SERVICE_DIR/runChatService.sh" ]; then
    echo "No se ha encontrado $CHAT_SERVICE_DIR/runChatService.sh; se omite el servicio de chat." >&2
    return
  fi

  ensure_port_available "$CHAT_SERVICE_PORT" "Servicio de chat"

  echo "Arrancando servicio de chat..."
  (
    cd "$ROOT_DIR"
    exec env \
      CHAT_SERVICE_PORT="$CHAT_SERVICE_PORT" \
      CHAT_REDIS_URL="$CHAT_REDIS_URL" \
      "$CHAT_SERVICE_DIR/runChatService.sh"
  ) &
  CHAT_SERVICE_PID=$!
  sleep 2

  if ! kill -0 "$CHAT_SERVICE_PID" 2>/dev/null; then
    echo "El servicio de chat no ha podido arrancar." >&2
    CHAT_SERVICE_PID=""
    return
  fi
}

run_chat_worker() {
  if [ "$CHAT_WORKER_ENABLED" != "1" ]; then
    echo "Worker de chat desactivado (CHAT_WORKER_ENABLED=$CHAT_WORKER_ENABLED)."
    return
  fi

  if [ ! -x "$CHAT_SERVICE_DIR/runChatWorker.sh" ]; then
    echo "No se ha encontrado $CHAT_SERVICE_DIR/runChatWorker.sh; se omite el worker de chat." >&2
    return
  fi

  echo "Arrancando worker de chat..."
  (
    cd "$ROOT_DIR"
    exec env \
      CHAT_REDIS_URL="$CHAT_REDIS_URL" \
      "$CHAT_SERVICE_DIR/runChatWorker.sh"
  ) &
  CHAT_WORKER_PID=$!
  sleep 2

  if ! kill -0 "$CHAT_WORKER_PID" 2>/dev/null; then
    echo "El worker de chat no ha podido arrancar." >&2
    CHAT_WORKER_PID=""
    return
  fi
}

run_frontend() {
  case "$FRONTEND_MODE" in
    dev)
      echo "Arrancando frontend Tauri en modo dev ($FRONTEND_DEV_SCRIPT)..."
      (
        cd "$FRONTEND_DIR"
        exec npm run "$FRONTEND_DEV_SCRIPT"
      ) &
      FRONTEND_PID=$!
      ;;
    binary)
      if [ ! -x "$FRONTEND_BINARY" ]; then
        echo "No se ha encontrado el binario del frontend en $FRONTEND_BINARY." >&2
        echo "Ejecuta primero: ./scripts/run-app.sh" >&2
        exit 1
      fi

      echo "Arrancando frontend Tauri desde binario..."
      if [ "$FRONTEND_RUNTIME_SAFE" = "1" ]; then
        WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}" \
          GDK_BACKEND="${GDK_BACKEND:-x11}" \
          "$FRONTEND_BINARY" &
      else
        "$FRONTEND_BINARY" &
      fi
      FRONTEND_PID=$!
      ;;
    none)
      echo "Frontend desactivado (FRONTEND_MODE=none)."
      ;;
    *)
      echo "FRONTEND_MODE no soportado: $FRONTEND_MODE. Usa dev, binary o none." >&2
      exit 1
      ;;
  esac
}

start_redis_if_needed
ensure_worker_privileges
run_backend_worker
run_backend_server
run_cloudflared_tunnel
run_chat_service
run_chat_worker
run_frontend

echo
echo "Stack local levantado."
echo "  Backend MCP:  $BACKEND_DIR"
if [ "$TUNNEL_ENABLED" = "1" ] && [ -n "$CLOUDFLARED_PID" ]; then
  echo "  MCP publico:  https://$TUNNEL_HOSTNAME/mcp"
fi
if [ "$CHAT_SERVICE_ENABLED" = "1" ] && [ -n "$CHAT_SERVICE_PID" ]; then
  echo "  Chat service: http://127.0.0.1:$CHAT_SERVICE_PORT/api/chat/health"
fi
if [ "$CHAT_WORKER_ENABLED" = "1" ] && [ -n "$CHAT_WORKER_PID" ]; then
  echo "  Chat worker:  cola Redis $CHAT_TURN_QUEUE_KEY"
fi
echo "  Frontend:     $FRONTEND_DIR"
echo "  Modo UI:      $FRONTEND_MODE"
echo "Pulsa Ctrl+C para pararlo todo."
echo

wait
