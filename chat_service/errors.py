"""User-facing error helpers for the chat service."""

from __future__ import annotations


def friendly_error_message(error: object) -> str:
    raw_message = str(error or "").strip()
    lower_message = raw_message.lower()

    if not raw_message:
        return "El turno ha fallado sin detalle disponible."

    if "openai_api_key" in lower_message or "api key" in lower_message:
        return "Falta configurar OPENAI_API_KEY para que el asistente pueda responder."

    if "timed out" in lower_message or "timeout" in lower_message:
        return "La operacion ha tardado demasiado. Revisa el estado del MCP o vuelve a intentarlo."

    if "mcp http" in lower_message or "mcp json-rpc" in lower_message:
        return "No se pudo completar la comunicacion con el servidor MCP."

    if "job not found" in lower_message or "status=not_found" in lower_message:
        return "El MCP devolvio un job que ya no esta disponible. Prueba con una conversacion nueva."

    if "did not produce assistant text" in lower_message:
        return "OpenAI no devolvio una respuesta final. Prueba a reformular el mensaje."

    return raw_message

