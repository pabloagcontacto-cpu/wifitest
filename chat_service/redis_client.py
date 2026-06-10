"""Shared Redis client for the chat service."""

from __future__ import annotations

from redis.asyncio import Redis

from . import settings


_REDIS_CLIENT: Redis | None = None


def get_redis_client() -> Redis:
    """Return a lazily-created Redis client."""
    global _REDIS_CLIENT

    if _REDIS_CLIENT is None:
        _REDIS_CLIENT = Redis.from_url(
            settings.CHAT_REDIS_URL,
            decode_responses=True,
        )

    return _REDIS_CLIENT
