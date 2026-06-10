"""Runtime settings for the WIFITEST chat service."""

from __future__ import annotations

import json
import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _read_default_wifi_interface_from_local_config() -> str:
    config_path = PROJECT_ROOT / "config" / "local.json"
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""

    value = payload.get("default_wifi_interface")
    return value.strip() if isinstance(value, str) else ""


CHAT_SERVICE_HOST = os.getenv("CHAT_SERVICE_HOST", "127.0.0.1").strip()
CHAT_SERVICE_PORT = int(os.getenv("CHAT_SERVICE_PORT", "8796"))

CHAT_REDIS_URL = os.getenv("CHAT_REDIS_URL", "redis://127.0.0.1:6379/1").strip()
CHAT_CONVERSATION_PREFIX = os.getenv("CHAT_CONVERSATION_PREFIX", "wifitest:chat:conversation:").strip()
CHAT_CONVERSATIONS_KEY = os.getenv("CHAT_CONVERSATIONS_KEY", "wifitest:chat:conversations").strip()
CHAT_TURN_PREFIX = os.getenv("CHAT_TURN_PREFIX", "wifitest:chat:turn:").strip()
CHAT_TURN_QUEUE_KEY = os.getenv("CHAT_TURN_QUEUE_KEY", "wifitest:chat:turns:queue").strip()
CHAT_CONVERSATION_LOCK_PREFIX = os.getenv(
    "CHAT_CONVERSATION_LOCK_PREFIX",
    "wifitest:chat:conversation-lock:",
).strip()
CHAT_CONVERSATION_LOCK_TTL_SECONDS = int(os.getenv("CHAT_CONVERSATION_LOCK_TTL_SECONDS", "1200"))
CHAT_EVENTS_CHANNEL = os.getenv("CHAT_EVENTS_CHANNEL", "wifitest:chat:events").strip()

CHAT_SERVICE_CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CHAT_SERVICE_CORS_ALLOW_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173,http://tauri.localhost,tauri://localhost",
    ).split(",")
    if origin.strip()
]
CHAT_SERVICE_CORS_ALLOW_ORIGIN_REGEX = os.getenv(
    "CHAT_SERVICE_CORS_ALLOW_ORIGIN_REGEX",
    r"^(http://127\.0\.0\.1:\d+|http://localhost:\d+|http://tauri\.localhost|tauri://localhost|null)$",
).strip()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini").strip()
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "").strip()
OPENAI_REASONING_EFFORT = os.getenv("OPENAI_REASONING_EFFORT", "").strip()

OPENAI_MCP_SERVER_URL = os.getenv("OPENAI_MCP_SERVER_URL", "https://mcp.pablotests.xyz/mcp").strip()
OPENAI_MCP_SERVER_LABEL = os.getenv("OPENAI_MCP_SERVER_LABEL", "wifitest-mcp").strip()
OPENAI_MCP_SERVER_DESCRIPTION = os.getenv(
    "OPENAI_MCP_SERVER_DESCRIPTION",
    "Servidor MCP de WIFITEST con herramientas locales de auditoria Wi-Fi y router.",
).strip()
OPENAI_MAX_TOOL_ROUNDS = int(os.getenv("OPENAI_MAX_TOOL_ROUNDS", "6"))
OPENAI_JOB_POLL_INTERVAL_MS = int(os.getenv("OPENAI_JOB_POLL_INTERVAL_MS", "2000"))
OPENAI_JOB_POLL_TIMEOUT_SECONDS = int(os.getenv("OPENAI_JOB_POLL_TIMEOUT_SECONDS", "600"))

WIFITEST_WIFI_INTERFACE = (
    os.getenv("WIFITEST_WIFI_INTERFACE", "").strip()
    or _read_default_wifi_interface_from_local_config()
)
