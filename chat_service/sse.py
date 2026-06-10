"""Server-Sent Events helpers for chat updates."""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict

from . import settings
from .redis_client import get_redis_client


SSE_LISTENERS: dict[str, list[asyncio.Queue]] = defaultdict(list)


def register_sse_listener(conversation_id: str) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue()
    SSE_LISTENERS[str(conversation_id)].append(queue)
    return queue


def unregister_sse_listener(conversation_id: str, queue: asyncio.Queue) -> None:
    listeners = SSE_LISTENERS.get(str(conversation_id), [])
    if queue in listeners:
        listeners.remove(queue)
    if not listeners and str(conversation_id) in SSE_LISTENERS:
        del SSE_LISTENERS[str(conversation_id)]


async def dispatch_sse_event_locally(conversation_id: str, event_name: str, data: dict) -> None:
    listeners = list(SSE_LISTENERS.get(str(conversation_id), []))
    for queue in listeners:
        await queue.put(
            {
                "event": event_name,
                "data": data,
            }
        )


async def publish_sse_event(conversation_id: str, event_name: str, data: dict) -> None:
    redis = get_redis_client()
    payload = {
        "conversation_id": str(conversation_id),
        "event": event_name,
        "data": data,
    }
    await redis.publish(settings.CHAT_EVENTS_CHANNEL, json.dumps(payload, ensure_ascii=False))


def format_sse_event(event_name: str, data: dict) -> str:
    return f"event: {event_name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
