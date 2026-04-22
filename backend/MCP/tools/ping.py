"""Execution logic for the ping tool."""

from __future__ import annotations

from typing import Any

from tools.helpers import utc_now_iso


def ping_execute(input: dict[str, Any]) -> dict[str, Any]:
    """Execute the ping job."""
    message = input["message"]

    return {
        "raw_text": message,
        "normalized": {
            "message": message,
            "completed_at": utc_now_iso(),
        },
    }
