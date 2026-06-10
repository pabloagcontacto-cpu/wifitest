"""Minimal JSON-RPC client for the remote WIFITEST MCP server."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx

from . import settings


async def call_mcp_json_rpc(method: str, params: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "jsonrpc": "2.0",
        "id": uuid.uuid4().hex,
        "method": method,
        "params": params,
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            settings.OPENAI_MCP_SERVER_URL,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            json=payload,
        )

    if response.status_code >= 400:
        raise RuntimeError(f"MCP HTTP {response.status_code}: {response.text.strip() or 'sin detalle'}")

    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError("MCP returned invalid JSON.") from exc

    if data.get("error"):
        raise RuntimeError(f"MCP JSON-RPC error: {data['error']}")

    result = data.get("result") or {}
    if not isinstance(result, dict):
        raise RuntimeError("MCP returned an invalid JSON-RPC result.")
    return result


async def read_mcp_resource(uri: str) -> dict[str, Any]:
    result = await call_mcp_json_rpc("resources/read", {"uri": uri})

    if isinstance(result.get("structuredContent"), dict):
        return result["structuredContent"]

    contents = result.get("contents") or result.get("content") or []
    first = contents[0] if isinstance(contents, list) and contents else None

    if isinstance(first, dict):
        text = first.get("text") or first.get("content")
        if isinstance(text, str) and text.strip():
            try:
                parsed = json.loads(text)
            except ValueError as exc:
                raise RuntimeError(f"MCP resource returned invalid JSON for uri={uri}") from exc
            if isinstance(parsed, dict):
                return parsed

    raise RuntimeError(f"MCP resource returned no structured content for uri={uri}")


async def wait_for_async_job_result(job_id: str, resource: str | None = None) -> dict[str, Any]:
    safe_job_id = str(job_id or "").strip()
    if not safe_job_id:
        raise RuntimeError("job_id cannot be empty.")

    uri = str(resource or f"job://{safe_job_id}").strip()
    deadline = asyncio.get_running_loop().time() + settings.OPENAI_JOB_POLL_TIMEOUT_SECONDS

    while True:
        payload = await read_mcp_resource(uri)
        status = str(payload.get("status") or "").strip().lower()

        if status == "completed":
            return payload

        if status in {"failed", "error", "cancelled", "not_found"}:
            detail = payload.get("message") or payload.get("error") or "sin detalle"
            raise RuntimeError(f"MCP job {safe_job_id} finished with status={status}: {detail}")

        if asyncio.get_running_loop().time() >= deadline:
            raise RuntimeError(
                f"MCP job {safe_job_id} timed out after "
                f"{settings.OPENAI_JOB_POLL_TIMEOUT_SECONDS} seconds."
            )

        await asyncio.sleep(settings.OPENAI_JOB_POLL_INTERVAL_MS / 1000)

