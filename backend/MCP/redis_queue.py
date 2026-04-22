"""Módulo redis_queue.py. Contiene funciones helper para interactuar con Redis 
como sistema de colas para la ejecución de herramientas de forma asíncrona en MCP."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from typing import Any

from redis import Redis
from redis.exceptions import ResponseError

JOB_STREAM = "mcp:jobs:stream"
JOB_GROUP = "mcp-workers"
JOB_KEY_PREFIX = "mcp:job:"


def utc_now_iso() -> str:
    """
    Devuelve la fecha y hora actual en formato ISO 8601 con zona horaria UTC.
    """
    return datetime.now(UTC).isoformat()


def get_redis_client() -> Redis:
    """
    Devuelve una instancia de Redis configurada según la variable de entorno REDIS_URL 
    o con la configuración por defecto.
    """
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    return Redis.from_url(redis_url, decode_responses=True)


def job_key(job_id: str) -> str:
    """
    Helper para generar la clave de Redis donde se almacena la 
    metadata de un job dado su job_id.
    
    """
    return f"{JOB_KEY_PREFIX}{job_id}"


def ensure_worker_group(redis_client: Redis) -> None:
    """
    Crea el grupo de consumidores para los workers si no existe. 
    Esto es necesario para que los workers puedan leer del stream de jobs.
    """
    try:
        redis_client.xgroup_create(
            name=JOB_STREAM,
            groupname=JOB_GROUP,
            id="0",
            mkstream=True,
        )
    except ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


def create_job(redis_client: Redis, job_id: str, tool_name: str, input: dict[str, Any]) -> None:
    """
    
    Escribe en Redis la metadata incial de un nuevo job.
    Se escribe en un hash con key job:{job_id} que contiene toda la metadata del job, 
    incluyendo su estado inicial (queued) y el input serializado.
    
    """
    redis_client.hset(
        job_key(job_id),
        mapping={
            "job_id": job_id,
            "tool_name": tool_name,
            "status": "queued",
            "input": json.dumps(input),
            "result": json.dumps(None),
            "error": json.dumps(None),
            "submitted_at": utc_now_iso(),
            "started_at": "",
            "finished_at": "",
        },
    )


def enqueue_job(redis_client: Redis, job_id: str, tool_name: str, input: dict[str, Any]) -> str:
    """
    Encola un job para su procesamiento por parte de los workers.

    Se encola en un stream de Redis llamado mcp:jobs:stream. 
    Cada mensaje del stream representa un job pendiente de procesar, 
    e incluye el job_id, el nombre de la herramienta a ejecutar y el input serializado.
    """
    return redis_client.xadd(
        JOB_STREAM,
        {
            "job_id": job_id,
            "tool_name": tool_name,
            "input": json.dumps(input),
        },
    )


def update_job_status(
    redis_client: Redis,
    job_id: str,
    status: str,
    *,
    result: Any | None = None,
    error: Any | None = None,
    started_at: str | None = None,
    finished_at: str | None = None,
) -> None:
    """
    Funcion que actualiza el estado de un job dado su job_id.

    Se pueden actualizar los siguientes campos:
    - status: el nuevo estado del job.
    - result: el resultado de la ejecución del job, si está disponible. Se serializa
        como JSON.
    - error: el error ocurrido durante la ejecución del job, si está disponible. Se serializa
        como JSON.
    - started_at: la fecha y hora de inicio de la ejecución del job en formato ISO
        8601, si está disponible.
    - finished_at: la fecha y hora de finalización de la ejecución del job en formato
        ISO 8601, si está disponible.
    
    """
    mapping: dict[str, str] = {
        "status": status,
    }
    if result is not None:
        mapping["result"] = json.dumps(result)
    if error is not None:
        mapping["error"] = json.dumps(error)
    if started_at is not None:
        mapping["started_at"] = started_at
    if finished_at is not None:
        mapping["finished_at"] = finished_at
    redis_client.hset(job_key(job_id), mapping=mapping)


def get_job(redis_client: Redis, job_id: str) -> dict[str, Any]:
    """
    Funcion que recupera toda la metadata de un job dado su job_id.
    Devuelve un diccionario con los siguientes campos:
    - job_id: el ID del job.
    - tool_name: el nombre de la herramienta a ejecutar.
    - status: el estado actual del job (queued, in_progress, completed, failed).
    - input: el input serializado del job, deserializado como un diccionario.
    - result: el resultado de la ejecución del job, si está disponible, deserializado.
    - error: el error ocurrido durante la ejecución del job, si está disponible, deserializado
    - submitted_at: la fecha y hora de envío del job en formato ISO 8601, o None si no está disponible.
    - started_at: la fecha y hora de inicio de la ejecución del job en formato ISO
        8601, o None si no está disponible.
    - finished_at: la fecha y hora de finalización de la ejecución del job en formato
        ISO 8601, o None si no está disponible.

    Si el job no se encuentra en Redis, devuelve un diccionario con status "not_found" 
    y los demás campos como None.
    """
    raw_job = redis_client.hgetall(job_key(job_id))
    if not raw_job:
        return {
            "job_id": job_id,
            "status": "not_found",
            "tool_name": None,
            "input": None,
            "result": None,
            "error": {"message": "Job not found."},
            "submitted_at": None,
            "started_at": None,
            "finished_at": None,
        }

    return {
        "job_id": raw_job["job_id"],
        "tool_name": raw_job["tool_name"],
        "status": raw_job["status"],
        "input": json.loads(raw_job.get("input", "null")),
        "result": json.loads(raw_job.get("result", "null")),
        "error": json.loads(raw_job.get("error", "null")),
        "submitted_at": raw_job["submitted_at"] or None,
        "started_at": raw_job["started_at"] or None,
        "finished_at": raw_job["finished_at"] or None,
    }
