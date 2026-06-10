"""Redis queue and lock helpers for chat turns."""

from __future__ import annotations

from . import settings
from .redis_client import get_redis_client


def conversation_lock_key(conversation_id: str) -> str:
    return f"{settings.CHAT_CONVERSATION_LOCK_PREFIX}{conversation_id}"


async def enqueue_turn(turn_id: str) -> None:
    redis = get_redis_client()
    await redis.rpush(settings.CHAT_TURN_QUEUE_KEY, turn_id)


async def pop_turn(timeout_seconds: int = 5) -> str | None:
    redis = get_redis_client()
    item = await redis.blpop(settings.CHAT_TURN_QUEUE_KEY, timeout=timeout_seconds)
    if not item:
        return None

    _, turn_id = item
    return str(turn_id)


async def acquire_conversation_lock(conversation_id: str, owner_token: str) -> bool:
    redis = get_redis_client()
    acquired = await redis.set(
        conversation_lock_key(conversation_id),
        owner_token,
        nx=True,
        ex=settings.CHAT_CONVERSATION_LOCK_TTL_SECONDS,
    )
    return bool(acquired)


async def release_conversation_lock(conversation_id: str, owner_token: str) -> None:
    redis = get_redis_client()
    key = conversation_lock_key(conversation_id)
    current_owner = await redis.get(key)
    if current_owner == owner_token:
        await redis.delete(key)

