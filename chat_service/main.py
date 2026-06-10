"""FastAPI entrypoint for the local WIFITEST chat service."""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import settings
from .redis_client import get_redis_client
from .sse import (
    dispatch_sse_event_locally,
    format_sse_event,
    publish_sse_event,
    register_sse_listener,
    unregister_sse_listener,
)
from .queue import enqueue_turn
from .store import (
    add_message,
    create_conversation,
    create_turn,
    delete_all_conversations,
    delete_conversation,
    get_conversation,
    get_turn,
    list_conversations,
    list_messages,
)


app = FastAPI(title="WIFITEST Chat Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CHAT_SERVICE_CORS_ALLOW_ORIGINS,
    allow_origin_regex=settings.CHAT_SERVICE_CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

redis_events_task = None


class CreateConversationRequest(BaseModel):
    title: Optional[str] = None


class CreateMessageRequest(BaseModel):
    content: str
    context: dict[str, Any] | None = None


@app.get("/api/chat/health")
async def chat_health():
    return {
        "ok": True,
        "service": "wifitest-chat",
        "redis_url": settings.CHAT_REDIS_URL,
        "events_channel": settings.CHAT_EVENTS_CHANNEL,
    }


@app.post("/api/chat/conversations")
async def create_chat_conversation(body: CreateConversationRequest):
    conversation = await create_conversation(title=body.title)
    await publish_sse_event(
        conversation_id=conversation["id"],
        event_name="status",
        data={
            "type": "conversation_created",
            "conversation_id": conversation["id"],
        },
    )
    return {
        "ok": True,
        "conversation": conversation,
    }


@app.get("/api/chat/conversations")
async def get_chat_conversations():
    conversations = await list_conversations()
    return {
        "ok": True,
        "conversations": conversations,
    }


@app.get("/api/chat/conversations/{conversation_id}")
async def get_chat_conversation(conversation_id: str):
    conversation = await get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {
        "ok": True,
        "conversation": conversation,
    }


@app.delete("/api/chat/conversations/{conversation_id}")
async def delete_chat_conversation(conversation_id: str):
    deleted = await delete_conversation(conversation_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    await publish_sse_event(
        conversation_id=conversation_id,
        event_name="status",
        data={
            "type": "conversation_deleted",
            "conversation_id": conversation_id,
        },
    )
    return {
        "ok": True,
        "deleted": True,
        "conversation_id": conversation_id,
    }


@app.delete("/api/chat/conversations")
async def delete_chat_conversations():
    deleted_count = await delete_all_conversations()
    return {
        "ok": True,
        "deleted_count": deleted_count,
    }


@app.get("/api/chat/conversations/{conversation_id}/messages")
async def get_chat_messages(conversation_id: str):
    try:
        messages = await list_messages(conversation_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Conversation not found.") from exc
    return {
        "ok": True,
        "messages": messages,
    }


@app.post("/api/chat/conversations/{conversation_id}/messages")
async def create_chat_message(conversation_id: str, body: CreateMessageRequest):
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message content cannot be empty.")

    try:
        message = await add_message(conversation_id, role="user", content=content)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Conversation not found.") from exc

    await publish_sse_event(
        conversation_id=conversation_id,
        event_name="message",
        data={
            "type": "message_created",
            "conversation_id": conversation_id,
            "message": message,
        },
    )
    turn = await create_turn(
        conversation_id=conversation_id,
        user_message_id=message["id"],
        context=body.context,
    )
    await enqueue_turn(turn["id"])
    await publish_sse_event(
        conversation_id=conversation_id,
        event_name="status",
        data={
            "type": "turn_queued",
            "conversation_id": conversation_id,
            "turn_id": turn["id"],
            "user_message_id": message["id"],
        },
    )

    return {
        "ok": True,
        "message": message,
        "turn": turn,
    }


@app.get("/api/chat/turns/{turn_id}")
async def get_chat_turn(turn_id: str):
    turn = await get_turn(turn_id)
    if turn is None:
        raise HTTPException(status_code=404, detail="Turn not found.")
    return {
        "ok": True,
        "turn": turn,
    }


@app.get("/api/chat/stream/{conversation_id}")
async def stream_conversation_events(conversation_id: str):
    if await get_conversation(conversation_id) is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    queue = register_sse_listener(conversation_id)

    async def event_generator():
        try:
            yield format_sse_event(
                "status",
                {
                    "type": "connected",
                    "conversation_id": conversation_id,
                },
            )

            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue

                event_name = str(event.get("event", "message"))
                data = event.get("data", {})
                yield format_sse_event(event_name, data if isinstance(data, dict) else {})
        finally:
            unregister_sse_listener(conversation_id, queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


async def redis_event_listener_loop() -> None:
    redis = get_redis_client()
    pubsub = redis.pubsub()
    await pubsub.subscribe(settings.CHAT_EVENTS_CHANNEL)

    try:
        while True:
            message = await pubsub.get_message(
                ignore_subscribe_messages=True,
                timeout=1.0,
            )
            if not message:
                await asyncio.sleep(0.1)
                continue

            raw_data = message.get("data")
            if not raw_data:
                continue

            try:
                payload = json.loads(raw_data)
            except (TypeError, ValueError):
                continue

            conversation_id = str(payload.get("conversation_id") or "").strip()
            if not conversation_id:
                continue

            event_name = str(payload.get("event", "message"))
            data = payload.get("data", {})
            await dispatch_sse_event_locally(
                conversation_id=conversation_id,
                event_name=event_name,
                data=data if isinstance(data, dict) else {},
            )
    finally:
        with contextlib.suppress(Exception):
            await pubsub.unsubscribe(settings.CHAT_EVENTS_CHANNEL)
        with contextlib.suppress(Exception):
            await pubsub.close()


@app.on_event("startup")
async def on_startup() -> None:
    global redis_events_task
    redis_events_task = asyncio.create_task(redis_event_listener_loop())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global redis_events_task
    if redis_events_task is not None:
        redis_events_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await redis_events_task
        redis_events_task = None
