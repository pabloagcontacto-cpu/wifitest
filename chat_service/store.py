"""Redis-backed conversation storage for the local chat service."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from . import settings
from .redis_client import get_redis_client


def utc_epoch_ms() -> int:
    """Return the current UTC epoch time in milliseconds."""
    return int(time.time() * 1000)


def conversation_key(conversation_id: str) -> str:
    return f"{settings.CHAT_CONVERSATION_PREFIX}{conversation_id}"


def messages_key(conversation_id: str) -> str:
    return f"{conversation_key(conversation_id)}:messages"


def turn_key(turn_id: str) -> str:
    return f"{settings.CHAT_TURN_PREFIX}{turn_id}"


async def create_conversation(title: str | None = None) -> dict[str, Any]:
    """Create and persist a chat conversation."""
    redis = get_redis_client()
    now = utc_epoch_ms()
    conversation_id = uuid.uuid4().hex
    conversation = {
        "id": conversation_id,
        "title": (title or "Nueva conversacion").strip() or "Nueva conversacion",
        "openai_conversation_id": "",
        "created_at": now,
        "updated_at": now,
    }

    await redis.hset(
        conversation_key(conversation_id),
        mapping={key: json.dumps(value) for key, value in conversation.items()},
    )
    await redis.zadd(settings.CHAT_CONVERSATIONS_KEY, {conversation_id: now})
    return conversation


async def get_conversation(conversation_id: str) -> dict[str, Any] | None:
    """Read one conversation by id."""
    redis = get_redis_client()
    raw = await redis.hgetall(conversation_key(conversation_id))
    if not raw:
        return None

    conversation: dict[str, Any] = {}
    for key, value in raw.items():
        try:
            conversation[key] = json.loads(value)
        except json.JSONDecodeError:
            conversation[key] = value
    return conversation


async def list_conversations(limit: int = 50) -> list[dict[str, Any]]:
    """Return recent conversations, newest first."""
    redis = get_redis_client()
    conversation_ids = await redis.zrevrange(settings.CHAT_CONVERSATIONS_KEY, 0, max(0, limit - 1))
    conversations = []

    for conversation_id in conversation_ids:
        conversation = await get_conversation(str(conversation_id))
        if conversation:
            conversations.append(conversation)

    return conversations


async def delete_conversation(conversation_id: str) -> bool:
    """Delete one conversation plus its messages and known turns."""
    redis = get_redis_client()
    if await get_conversation(conversation_id) is None:
        return False

    turn_keys = []
    async for key in redis.scan_iter(f"{settings.CHAT_TURN_PREFIX}*"):
        raw_turn = await redis.hgetall(key)
        raw_conversation_id = raw_turn.get("conversation_id")
        if raw_conversation_id is None:
            continue

        try:
            parsed_conversation_id = json.loads(raw_conversation_id)
        except json.JSONDecodeError:
            parsed_conversation_id = raw_conversation_id

        if str(parsed_conversation_id) == conversation_id:
            turn_keys.append(key)

    if turn_keys:
        await redis.delete(*turn_keys)

    await redis.delete(conversation_key(conversation_id), messages_key(conversation_id))
    await redis.zrem(settings.CHAT_CONVERSATIONS_KEY, conversation_id)
    return True


async def delete_all_conversations() -> int:
    """Delete all chat conversations and associated turns."""
    redis = get_redis_client()
    conversation_ids = await redis.zrange(settings.CHAT_CONVERSATIONS_KEY, 0, -1)
    deleted_count = 0

    for conversation_id in conversation_ids:
        if await delete_conversation(str(conversation_id)):
            deleted_count += 1

    await redis.delete(settings.CHAT_CONVERSATIONS_KEY)
    return deleted_count


async def update_conversation_fields(conversation_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    """Update selected conversation fields and return the fresh conversation."""
    redis = get_redis_client()
    conversation = await get_conversation(conversation_id)
    if conversation is None:
        raise KeyError("Conversation not found.")

    now = utc_epoch_ms()
    fields = {
        **fields,
        "updated_at": now,
    }

    await redis.hset(
        conversation_key(conversation_id),
        mapping={key: json.dumps(value, ensure_ascii=False) for key, value in fields.items()},
    )
    await redis.zadd(settings.CHAT_CONVERSATIONS_KEY, {conversation_id: now})

    updated = await get_conversation(conversation_id)
    if updated is None:
        raise KeyError("Conversation not found.")
    return updated


async def add_message(conversation_id: str, role: str, content: str) -> dict[str, Any]:
    """Append one message to a conversation."""
    redis = get_redis_client()
    conversation = await get_conversation(conversation_id)
    if conversation is None:
        raise KeyError("Conversation not found.")

    now = utc_epoch_ms()
    message = {
        "id": uuid.uuid4().hex,
        "conversation_id": conversation_id,
        "role": role,
        "content": content,
        "created_at": now,
    }

    await redis.rpush(messages_key(conversation_id), json.dumps(message, ensure_ascii=False))
    await redis.hset(
        conversation_key(conversation_id),
        mapping={
            "updated_at": json.dumps(now),
        },
    )
    await redis.zadd(settings.CHAT_CONVERSATIONS_KEY, {conversation_id: now})
    return message


async def list_messages(conversation_id: str, limit: int = 200) -> list[dict[str, Any]]:
    """Return messages for one conversation in insertion order."""
    redis = get_redis_client()
    if await get_conversation(conversation_id) is None:
        raise KeyError("Conversation not found.")

    start = -limit if limit > 0 else 0
    raw_messages = await redis.lrange(messages_key(conversation_id), start, -1)
    messages = []
    for raw_message in raw_messages:
        try:
            parsed = json.loads(raw_message)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            messages.append(parsed)

    return messages


async def create_turn(
    conversation_id: str,
    user_message_id: str,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a queued assistant turn for one user message."""
    redis = get_redis_client()
    if await get_conversation(conversation_id) is None:
        raise KeyError("Conversation not found.")

    now = utc_epoch_ms()
    turn = {
        "id": uuid.uuid4().hex,
        "conversation_id": conversation_id,
        "user_message_id": user_message_id,
        "assistant_message_id": "",
        "provider_response_id": "",
        "status": "queued",
        "error": "",
        "context": context if isinstance(context, dict) else {},
        "created_at": now,
        "started_at": 0,
        "finished_at": 0,
    }

    await redis.hset(
        turn_key(turn["id"]),
        mapping={key: json.dumps(value, ensure_ascii=False) for key, value in turn.items()},
    )
    return turn


async def get_turn(turn_id: str) -> dict[str, Any] | None:
    """Read one chat turn by id."""
    redis = get_redis_client()
    raw = await redis.hgetall(turn_key(turn_id))
    if not raw:
        return None

    turn: dict[str, Any] = {}
    for key, value in raw.items():
        try:
            turn[key] = json.loads(value)
        except json.JSONDecodeError:
            turn[key] = value
    return turn


async def update_turn(turn_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    """Patch selected turn fields and return the fresh turn."""
    redis = get_redis_client()
    if await get_turn(turn_id) is None:
        raise KeyError("Turn not found.")

    await redis.hset(
        turn_key(turn_id),
        mapping={key: json.dumps(value, ensure_ascii=False) for key, value in fields.items()},
    )
    updated = await get_turn(turn_id)
    if updated is None:
        raise KeyError("Turn not found.")
    return updated
