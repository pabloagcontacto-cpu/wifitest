"""Worker process that turns queued user messages into assistant responses."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

from .errors import friendly_error_message
from .openai_client import create_openai_conversation
from .openai_mcp import run_openai_mcp_turn
from .queue import acquire_conversation_lock, enqueue_turn, pop_turn, release_conversation_lock
from .sse import publish_sse_event
from .store import (
    add_message,
    get_conversation,
    get_turn,
    list_messages,
    update_conversation_fields,
    update_turn,
    utc_epoch_ms,
)

logger = logging.getLogger("wifitest.chat.worker")


DEFAULT_OPENAI_INSTRUCTIONS = " ".join(
    [
        "Eres el asistente de WIFITEST, una aplicacion local de auditoria Wi-Fi y router.",
        "Hablas con un usuario final en espanol, con tono claro y practico.",
        "Entre tu y las herramientas existe un orchestrator.",
        "Cuando pidas una tool del MCP, el MCP devolvera un job_id y un resource job://.",
        "Si recibes un job_id de una tool, no respondas todavia al usuario final.",
        "Devuelve solo un objeto JSON con el job_id y, si esta disponible, el resource.",
        "Ejemplo de forma, no de valor real: {\"job_id\":\"<job_id_real>\",\"resource\":\"job://<job_id_real>\"}.",
        "El orchestrator resolvera el job y te devolvera el resultado en una ronda posterior.",
        "Puedes encadenar varias tools si necesitas mas evidencia.",
        "No puedes fijar la red objetivo desde el MCP. Solo el usuario puede fijarla desde la UI de WIFITEST.",
        "Si ejecutas scan_wifi_networks o muestras redes disponibles, recuerda al usuario que debe fijar manualmente la red objetivo desde el Dashboard o desde los botones que aparecen en el Chat.",
        "Antes de pedir herramientas, revisa el contexto global de WIFITEST que recibes con cada mensaje: red objetivo, jobs recientes, resultados manuales y estado de conexion.",
        "No inventes mediciones, redes, BSSIDs, servicios o riesgos no observados.",
        "Los resultados de tools usan el contrato raw_text, normalized y meta.",
        "No des instrucciones de abuso; manten el analisis en el contexto defensivo/local de WIFITEST.",
    ]
)


def build_user_input_with_context(user_text: str, context: dict | None) -> str:
    if not isinstance(context, dict) or not context:
        return user_text

    return (
        "Mensaje del usuario:\n"
        f"{user_text}\n\n"
        "Contexto global actual de WIFITEST enviado por la interfaz. "
        "Usalo como memoria operativa de los analisis hechos manualmente o por chat; no inventes datos fuera de este contexto.\n\n"
        f"{json.dumps(context, ensure_ascii=False, indent=2)}"
    )


def build_resolved_job_event_items(resolved_jobs: list[dict]) -> list[dict]:
    return [
        {
            "job_id": str(job.get("job_id") or ""),
            "resource": str(job.get("resource") or ""),
            "tool": str(job.get("tool") or ""),
            "status": str(job.get("status") or ""),
            "input": job.get("input") if isinstance(job.get("input"), dict) else None,
            "result": job.get("result") if isinstance(job.get("result"), dict) else None,
            "submitted_at": job.get("submitted_at"),
            "started_at": job.get("started_at"),
            "finished_at": job.get("finished_at"),
        }
        for job in resolved_jobs
    ]


async def ensure_openai_conversation(conversation_id: str) -> str:
    conversation = await get_conversation(conversation_id)
    if conversation is None:
        raise RuntimeError(f"Conversation {conversation_id} not found.")

    openai_conversation_id = str(conversation.get("openai_conversation_id") or "").strip()
    if openai_conversation_id:
        return openai_conversation_id

    created = await asyncio.to_thread(
        create_openai_conversation,
        metadata={
            "source": "wifitest-chat-worker",
            "chat_conversation_id": conversation_id,
        },
    )
    openai_conversation_id = str(created.get("id") or "").strip()
    if not openai_conversation_id:
        raise RuntimeError("OpenAI did not return a conversation id.")

    await update_conversation_fields(
        conversation_id,
        {
            "openai_conversation_id": openai_conversation_id,
        },
    )
    return openai_conversation_id


async def process_turn(turn_id: str) -> None:
    logger.info("turn %s: loading", turn_id)
    turn = await get_turn(turn_id)
    if turn is None:
        logger.warning("turn %s: not found", turn_id)
        return

    conversation_id = str(turn.get("conversation_id") or "").strip()
    user_message_id = str(turn.get("user_message_id") or "").strip()
    owner_token = uuid.uuid4().hex

    if not conversation_id or not user_message_id:
        await update_turn(
            turn_id,
            {
                "status": "failed",
                "error": "Turn is missing conversation_id or user_message_id.",
                "finished_at": utc_epoch_ms(),
            },
        )
        return

    acquired = await acquire_conversation_lock(conversation_id, owner_token)
    if not acquired:
        logger.info("turn %s: conversation %s locked, requeueing", turn_id, conversation_id)
        await enqueue_turn(turn_id)
        await asyncio.sleep(1.0)
        return

    try:
        logger.info("turn %s: started for conversation %s", turn_id, conversation_id)
        await update_turn(
            turn_id,
            {
                "status": "running",
                "started_at": utc_epoch_ms(),
            },
        )
        await publish_sse_event(
            conversation_id=conversation_id,
            event_name="status",
            data={
                "type": "turn_started",
                "conversation_id": conversation_id,
                "turn_id": turn_id,
                "user_message_id": user_message_id,
            },
        )

        messages = await list_messages(conversation_id)
        user_message = next(
            (message for message in messages if str(message.get("id") or "") == user_message_id),
            None,
        )
        if not user_message:
            raise RuntimeError(f"User message {user_message_id} not found.")

        user_text = str(user_message.get("content") or "").strip()
        if not user_text:
            raise RuntimeError("User message content is empty.")
        user_input = build_user_input_with_context(user_text, turn.get("context"))

        openai_conversation_id = await ensure_openai_conversation(conversation_id)
        logger.info("turn %s: using OpenAI conversation %s", turn_id, openai_conversation_id)
        await publish_sse_event(
            conversation_id=conversation_id,
            event_name="status",
            data={
                "type": "model_responding",
                "conversation_id": conversation_id,
                "turn_id": turn_id,
                "provider": "openai",
                "openai_conversation_id": openai_conversation_id,
            },
        )

        await publish_sse_event(
            conversation_id=conversation_id,
            event_name="status",
            data={
                "type": "mcp_available",
                "conversation_id": conversation_id,
                "turn_id": turn_id,
                "server_label": "wifitest-mcp",
            },
        )

        async def publish_resolved_jobs(resolved_jobs: list[dict], round_number: int) -> None:
            logger.info(
                "turn %s: resolved %s MCP job(s) in round %s",
                turn_id,
                len(resolved_jobs),
                round_number,
            )
            await publish_sse_event(
                conversation_id=conversation_id,
                event_name="status",
                data={
                    "type": "tool_jobs_resolved",
                    "conversation_id": conversation_id,
                    "turn_id": turn_id,
                    "round": round_number,
                    "count": len(resolved_jobs),
                    "jobs": build_resolved_job_event_items(resolved_jobs),
                },
            )

        openai_turn_result = await run_openai_mcp_turn(
            user_input=user_input,
            conversation_id=openai_conversation_id,
            instructions=DEFAULT_OPENAI_INSTRUCTIONS,
            on_jobs_resolved=publish_resolved_jobs,
        )

        resolved_jobs = openai_turn_result.get("resolved_jobs") or []
        if resolved_jobs:
            logger.info("turn %s: used %s resolved MCP job(s)", turn_id, len(resolved_jobs))

        assistant_text = str(openai_turn_result.get("final_text") or "").strip()
        if not assistant_text:
            raise RuntimeError("OpenAI turn did not produce assistant text.")

        assistant_message = await add_message(conversation_id, role="assistant", content=assistant_text)
        response_payload = openai_turn_result.get("response_payload") or {}
        provider_response_id = str(response_payload.get("id") or "").strip()

        await update_turn(
            turn_id,
            {
                "status": "completed",
                "assistant_message_id": assistant_message["id"],
                "provider_response_id": provider_response_id,
                "finished_at": utc_epoch_ms(),
            },
        )
        await publish_sse_event(
            conversation_id=conversation_id,
            event_name="message",
            data={
                "type": "message_created",
                "conversation_id": conversation_id,
                "message": assistant_message,
            },
        )
        await publish_sse_event(
            conversation_id=conversation_id,
            event_name="status",
            data={
                "type": "turn_completed",
                "conversation_id": conversation_id,
                "turn_id": turn_id,
                "assistant_message_id": assistant_message["id"],
                "provider_response_id": provider_response_id,
            },
        )
        logger.info("turn %s: completed", turn_id)

    except Exception as exc:
        friendly_error = friendly_error_message(exc)
        logger.exception("turn %s: failed: %s", turn_id, exc)
        await update_turn(
            turn_id,
            {
                "status": "failed",
                "error": str(exc),
                "friendly_error": friendly_error,
                "finished_at": utc_epoch_ms(),
            },
        )
        await publish_sse_event(
            conversation_id=conversation_id,
            event_name="status",
            data={
                "type": "turn_failed",
                "conversation_id": conversation_id,
                "turn_id": turn_id,
                "error": str(exc),
                "friendly_error": friendly_error,
            },
        )
    finally:
        await release_conversation_lock(conversation_id, owner_token)


async def worker_loop() -> None:
    while True:
        turn_id = await pop_turn(timeout_seconds=5)
        if turn_id is None:
            await asyncio.sleep(0.2)
            continue

        try:
            await process_turn(turn_id)
        except Exception:
            await asyncio.sleep(1.0)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
    )
    asyncio.run(worker_loop())


if __name__ == "__main__":
    main()
