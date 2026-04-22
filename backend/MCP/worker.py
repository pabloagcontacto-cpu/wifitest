"""Redis-backed worker process for asynchronous MCP jobs."""

from __future__ import annotations

import importlib
import json
import os

from redis_queue import (
    JOB_GROUP,
    JOB_STREAM,
    ensure_worker_group,
    get_redis_client,
    update_job_status,
    utc_now_iso,
)


def resolve_executor(tool_name: str):
    """Esta función recibe el nombre de una tool y localiza su función de ejecución real."""
    module = importlib.import_module(f"tools.{tool_name}")
    executor_name = f"{tool_name}_execute"
    executor = getattr(module, executor_name, None)
    if executor is None or not callable(executor):
        raise ValueError(f"No executor registered for tool '{tool_name}'.")
    return executor


def build_tool_result(
    tool_name: str,
    job_id: str,
    execution_result: dict[str, object],
) -> dict[str, object]:
    """
    Construye el contrato comun de salida para todas las tools.

    Cada tool puede centrarse en devolver su `raw_text` y su bloque
    `normalized`, y el worker completa el sobre comun con `nombreTool`
    y `job_id`.
    """
    raw_text = execution_result.get("raw_text", "")
    normalized = execution_result.get("normalized", {})

    if not isinstance(normalized, dict):
        raise ValueError(
            f"Tool '{tool_name}' returned an invalid 'normalized' field. "
            "Expected a dictionary."
        )

    return {
        "raw_text": str(raw_text),
        "normalized": normalized,
        "nombreTool": tool_name,
        "job_id": job_id,
    }


def process_message(redis_client, stream_message_id: str, fields: dict[str, str]) -> None:
    """Funcion encargada de procesar un mensaje del stream de Redis, 
    que representa un job a ejecutar."""
    job_id = fields["job_id"]
    tool_name = fields["tool_name"]
    input = json.loads(fields["input"])


    # Actualizamos el estado del job a "running" antes de ejecutar la herramienta,
    update_job_status(
        redis_client,
        job_id,
        "running",
        started_at=utc_now_iso(),
    )

    try:
        executor = resolve_executor(tool_name)
        execution_result = executor(input)
        result = build_tool_result(tool_name, job_id, execution_result)
        update_job_status(
            redis_client,
            job_id,
            "completed",
            result=result,
            finished_at=utc_now_iso(),
        )
    except Exception as exc:
        update_job_status(
            redis_client,
            job_id,
            "failed",
            error={"message": str(exc), "type": exc.__class__.__name__},
            finished_at=utc_now_iso(),
        )
    finally:
        redis_client.xack(JOB_STREAM, JOB_GROUP, stream_message_id)


def worker_loop(consumer_name: str) -> None:
    """Bucle principal del worker, que se queda escuchando nuevos trabajos 
    en Redis y los procesa a medida que llegan."""
    redis_client = get_redis_client()
    ensure_worker_group(redis_client)

    while True:
        messages = redis_client.xreadgroup(
            groupname=JOB_GROUP,
            consumername=consumer_name,
            streams={JOB_STREAM: ">"},
            count=1,
            block=5000,
        )
        if not messages:
            continue

        for _, entries in messages:
            for stream_message_id, fields in entries:
                process_message(redis_client, stream_message_id, fields)


def main() -> None:
    """Obtiene el nombre del worker y ejecuta el loop princiapal de consumo de trabajos."""
    consumer_name = os.getenv("MCP_WORKER_NAME", "worker-1")
    worker_loop(consumer_name)


if __name__ == "__main__":
    main()
