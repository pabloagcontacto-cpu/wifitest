"""Helpers shared by tool execution modules."""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now_iso() -> str:
    """Return a UTC timestamp in ISO 8601 format."""
    return datetime.now(UTC).isoformat()
