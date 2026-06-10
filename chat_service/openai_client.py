"""Small synchronous OpenAI Responses API wrapper."""

from __future__ import annotations

from typing import Any

from openai import OpenAI

from . import settings


_OPENAI_CLIENT: OpenAI | None = None


def get_openai_client() -> OpenAI:
    global _OPENAI_CLIENT

    if _OPENAI_CLIENT is not None:
        return _OPENAI_CLIENT

    if not settings.OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not configured.")

    client_kwargs: dict[str, Any] = {
        "api_key": settings.OPENAI_API_KEY,
    }
    if settings.OPENAI_BASE_URL:
        client_kwargs["base_url"] = settings.OPENAI_BASE_URL

    _OPENAI_CLIENT = OpenAI(**client_kwargs)
    return _OPENAI_CLIENT


def create_openai_conversation(metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    client = get_openai_client()
    kwargs: dict[str, Any] = {}
    if metadata:
        kwargs["metadata"] = metadata

    conversation = client.conversations.create(**kwargs)
    return conversation.model_dump()


def create_openai_response(
    *,
    user_input: str,
    conversation_id: str,
    instructions: str = "",
    tools: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    client = get_openai_client()

    kwargs: dict[str, Any] = {
        "model": settings.OPENAI_MODEL,
        "input": user_input,
        "conversation": conversation_id,
    }

    if instructions.strip():
        kwargs["instructions"] = instructions.strip()

    if settings.OPENAI_REASONING_EFFORT.strip():
        kwargs["reasoning"] = {
            "effort": settings.OPENAI_REASONING_EFFORT.strip(),
        }

    if tools:
        kwargs["tools"] = tools

    response = client.responses.create(**kwargs)
    return response.model_dump()


def extract_response_text(response_payload: dict[str, Any]) -> str:
    output_text = response_payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()

    output = response_payload.get("output")
    if not isinstance(output, list):
        return ""

    fragments: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue

        content = item.get("content")
        if not isinstance(content, list):
            continue

        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") != "output_text":
                continue

            text = part.get("text")
            if isinstance(text, str) and text.strip():
                fragments.append(text.strip())

    return "\n".join(fragments).strip()

