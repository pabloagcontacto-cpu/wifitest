"""OpenAI Responses + remote MCP orchestration loop."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from typing import Any

from . import settings
from .mcp_client import wait_for_async_job_result
from .openai_client import create_openai_response, extract_response_text


UUID_PATTERN = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
PLACEHOLDER_JOB_IDS = {
    "123e4567-e89b-12d3-a456-426614174000",
    "00000000-0000-0000-0000-000000000000",
}
JOB_ID_REGEX = re.compile(rf'"job_id"\s*:\s*"({UUID_PATTERN})"', re.IGNORECASE)
RESOURCE_REGEX = re.compile(r'"resource"\s*:\s*"([^"]+)"', re.IGNORECASE)
RESOURCE_URI_REGEX = re.compile(rf"job://({UUID_PATTERN})", re.IGNORECASE)
JOB_ID_TEXT_REGEX = re.compile(
    rf"(?:job[\s_-]*id|id\s+del\s+trabajo|trabajo\s+con\s+id|trabajo\s+tiene\s+el\s+id)\D*({UUID_PATTERN})",
    re.IGNORECASE,
)


def build_mcp_tool() -> dict[str, Any]:
    server_description = settings.OPENAI_MCP_SERVER_DESCRIPTION
    if settings.WIFITEST_WIFI_INTERFACE:
        server_description = (
            f"{server_description} Interfaz Wi-Fi local configurada: "
            f"{settings.WIFITEST_WIFI_INTERFACE}."
        )

    return {
        "type": "mcp",
        "server_label": settings.OPENAI_MCP_SERVER_LABEL,
        "server_description": server_description,
        "server_url": settings.OPENAI_MCP_SERVER_URL,
        "require_approval": "never",
    }


def _default_resource(job_id: str) -> str:
    return f"job://{job_id}"


def _is_placeholder_job_id(job_id: str) -> bool:
    return str(job_id or "").strip().lower() in PLACEHOLDER_JOB_IDS


def _collect_job_refs(value: Any, found: list[dict[str, str]]) -> None:
    if isinstance(value, str):
        found.extend(_collect_job_refs_from_text(value))
        return

    if isinstance(value, list):
        for item in value:
            _collect_job_refs(item, found)
        return

    if not isinstance(value, dict):
        return

    maybe_job_id = str(value.get("job_id") or "").strip()
    maybe_resource = str(value.get("resource") or "").strip()

    if maybe_job_id and not _is_placeholder_job_id(maybe_job_id):
        found.append(
            {
                "job_id": maybe_job_id,
                "resource": maybe_resource or _default_resource(maybe_job_id),
            }
        )

    for child in value.values():
        _collect_job_refs(child, found)


def _collect_job_refs_from_text(text: str) -> list[dict[str, str]]:
    if not isinstance(text, str) or not text.strip():
        return []

    normalized_text = text.strip()
    found: list[dict[str, str]] = []

    try:
        parsed = json.loads(normalized_text)
    except ValueError:
        parsed = None

    if parsed is not None:
        _collect_job_refs(parsed, found)

    job_ids = [match.group(1).strip() for match in JOB_ID_REGEX.finditer(normalized_text)]
    resources = [match.group(1).strip() for match in RESOURCE_REGEX.finditer(normalized_text)]
    resource_job_ids = [match.group(1).strip() for match in RESOURCE_URI_REGEX.finditer(normalized_text)]
    text_job_ids = [match.group(1).strip() for match in JOB_ID_TEXT_REGEX.finditer(normalized_text)]

    for index, job_id in enumerate(job_ids):
        if _is_placeholder_job_id(job_id):
            continue
        found.append(
            {
                "job_id": job_id,
                "resource": resources[index] if index < len(resources) else _default_resource(job_id),
            }
        )

    for job_id in resource_job_ids:
        if _is_placeholder_job_id(job_id):
            continue
        found.append(
            {
                "job_id": job_id,
                "resource": _default_resource(job_id),
            }
        )

    for job_id in text_job_ids:
        if _is_placeholder_job_id(job_id):
            continue
        found.append(
            {
                "job_id": job_id,
                "resource": _default_resource(job_id),
            }
        )

    return found


def extract_job_refs_from_response(response_payload: dict[str, Any]) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []

    output_text = response_payload.get("output_text")
    if isinstance(output_text, str):
        _collect_job_refs(output_text, found)

    output = response_payload.get("output")
    if isinstance(output, list):
        _collect_job_refs(output, found)

    deduped: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for item in found:
        job_id = str(item.get("job_id") or "").strip()
        resource = str(item.get("resource") or "").strip()
        if not job_id or _is_placeholder_job_id(job_id):
            continue

        signature = (job_id, resource or _default_resource(job_id))
        if signature in seen:
            continue

        seen.add(signature)
        deduped.append(
            {
                "job_id": job_id,
                "resource": resource or _default_resource(job_id),
            }
        )

    return deduped


def build_followup_input_from_resolved_jobs(resolved_jobs: list[dict[str, Any]], round_number: int) -> str:
    payload = {
        "type": "mcp_job_results",
        "round": round_number,
        "jobs": resolved_jobs,
    }

    return (
        "El orchestrator ha resuelto los siguientes jobs MCP de WIFITEST. "
        "Usa estos resultados como evidencia. Si necesitas mas herramientas, puedes pedirlas. "
        "Si ya tienes suficiente informacion, responde al usuario final.\n\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )


def _extract_result_payload(job_payload: dict[str, Any]) -> dict[str, Any]:
    result = job_payload.get("result")
    if isinstance(result, dict):
        return {
            "raw_text": result.get("raw_text") if isinstance(result.get("raw_text"), str) else "",
            "normalized": result.get("normalized") if isinstance(result.get("normalized"), dict) else {},
            "meta": result.get("meta") if isinstance(result.get("meta"), dict) else {},
        }

    if isinstance(result, str) and result.strip():
        try:
            parsed = json.loads(result)
        except ValueError:
            return {
                "raw_text": result,
                "normalized": {},
                "meta": {},
            }

        if isinstance(parsed, dict):
            return {
                "raw_text": parsed.get("raw_text") if isinstance(parsed.get("raw_text"), str) else result,
                "normalized": parsed.get("normalized") if isinstance(parsed.get("normalized"), dict) else {},
                "meta": parsed.get("meta") if isinstance(parsed.get("meta"), dict) else {},
            }

    return {
        "raw_text": "",
        "normalized": {},
        "meta": {},
    }


async def resolve_job_refs(job_refs: list[dict[str, str]]) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []

    for job_ref in job_refs:
        job_id = str(job_ref.get("job_id") or "").strip()
        resource = str(job_ref.get("resource") or _default_resource(job_id)).strip()
        job_payload = await wait_for_async_job_result(job_id, resource=resource)
        result_payload = _extract_result_payload(job_payload)

        resolved.append(
            {
                "job_id": job_id,
                "resource": resource,
                "status": job_payload.get("status", "completed"),
                "tool": job_payload.get("tool") or job_payload.get("tool_name") or "",
                "input": job_payload.get("input") if isinstance(job_payload.get("input"), dict) else None,
                "result": result_payload,
                "error": job_payload.get("error") if isinstance(job_payload.get("error"), dict) else None,
                "submitted_at": job_payload.get("submitted_at"),
                "started_at": job_payload.get("started_at"),
                "finished_at": job_payload.get("finished_at"),
            }
        )

    return resolved


async def run_openai_mcp_turn(
    *,
    user_input: str,
    conversation_id: str,
    instructions: str,
    on_jobs_resolved: Callable[[list[dict[str, Any]], int], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    current_response = await asyncio.to_thread(
        create_openai_response,
        user_input=user_input,
        conversation_id=conversation_id,
        instructions=instructions,
        tools=[build_mcp_tool()],
    )

    round_number = 1
    all_resolved_jobs: list[dict[str, Any]] = []

    while round_number <= settings.OPENAI_MAX_TOOL_ROUNDS:
        final_text = extract_response_text(current_response)
        job_refs = extract_job_refs_from_response(current_response)

        if not job_refs:
            return {
                "final_text": final_text,
                "response_payload": current_response,
                "job_refs": [],
                "resolved_jobs": all_resolved_jobs,
                "rounds_used": round_number,
            }

        resolved_jobs = await resolve_job_refs(job_refs)
        all_resolved_jobs.extend(resolved_jobs)
        if on_jobs_resolved is not None:
            await on_jobs_resolved(resolved_jobs, round_number)

        if round_number >= settings.OPENAI_MAX_TOOL_ROUNDS:
            raise RuntimeError(f"OpenAI MCP turn exceeded max rounds ({settings.OPENAI_MAX_TOOL_ROUNDS}).")

        followup_input = build_followup_input_from_resolved_jobs(resolved_jobs, round_number=round_number)
        current_response = await asyncio.to_thread(
            create_openai_response,
            user_input=followup_input,
            conversation_id=conversation_id,
            instructions=instructions,
            tools=[build_mcp_tool()],
        )
        round_number += 1

    raise RuntimeError(f"OpenAI MCP turn exceeded max rounds ({settings.OPENAI_MAX_TOOL_ROUNDS}).")
