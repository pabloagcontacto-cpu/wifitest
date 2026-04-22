"""MCP server entrypoint for WIFITEST using streamable HTTP and async job dispatch."""

from __future__ import annotations

import os
from typing import Any
from uuid import uuid4

from mcp.server.fastmcp import FastMCP
from starlette.middleware.cors import CORSMiddleware
import uvicorn

from redis_queue import create_job, enqueue_job, get_job, get_redis_client
from serializer import serializer

mcp = FastMCP(
    name="WIFITEST",
    instructions=(
        "Servidor MCP del repositorio WIFITEST. Las tools publican jobs "
        "asincronos en Redis y sus resultados se consultan en recursos job://."
    ),
    host=os.getenv("MCP_HOST", "127.0.0.1"),
    port=int(os.getenv("MCP_PORT", "8000")),
    streamable_http_path=os.getenv("MCP_STREAMABLE_HTTP_PATH", "/mcp"),
    stateless_http=True,
    json_response=True,
)


def enqueue_tool_call(tool_name: str, raw_args: dict[str, Any]) -> dict[str, Any]:
    """Serialize a tool call, enqueue it, and return the polling metadata."""
    input_data = serializer(tool_name, raw_args)
    job_id = str(uuid4())
    redis_client = get_redis_client()
    create_job(redis_client, job_id, tool_name, input_data)
    enqueue_job(redis_client, job_id, tool_name, input_data)

    return {
        "job_id": job_id,
        "tool_name": tool_name,
        "status": "queued",
        "resource": f"job://{job_id}",
    }


def procesarTool(nombreTool: str, raw_args: dict[str, Any]) -> dict[str, Any]:
    """
    Helper que realiza todo el proceso de ejecutar una herramienta. Siempre es el mismo procedimiento:
    - Serializar los argumentos de la herramienta.
    - Encolar la ejecución de la herramienta en Redis.
    - Devolver el job_id y la metadata necesaria para que el orquestador pueda consultar el resultado posteriormente.
    """

    # Llamamos a la funcion principal para serializar los argumentos en funcion del nombre de la herramienta. 
    input = serializer(nombreTool, raw_args)

    # Generamos un job_id unico para esta tarea.
    job_id = str(uuid4())

    redis_client = get_redis_client()
    create_job(redis_client, job_id, nombreTool, input)
    enqueue_job(redis_client, job_id, nombreTool, input)

    return {
        "job_id": job_id,
        "tool_name": nombreTool,
        "status": "queued",
        "resource": f"job://{job_id}",
    }


@mcp.tool()
def ping(message: str | None = None) -> dict[str, Any]:
    """Tool for doing a ping test with a constrained input message.
    
    This tool is asynchronous. It will return a job_id that you have to return in your response.
    Your response must only be: {"job_id": job_id}. The orchestrator will then obtnain the result and
    resend it to you so you can ask for another tool or return the final answer.

    Shared tool contract:
    - file: /contracts/tools.json
    - accepted values for `message`: "ping", "pong", "hello"

    Example input:
    {
        "message": "ping"
    }

    Example first output:
    {
        "job_id": "123e4567-e89b-12d3-a456-426614174000"
    }

    Example final output (after the job is done and the orchestrator resends the result to you):
    {
        "raw_text": "ping",
        "normalized": {
            "message": "ping",
            "completed_at": "2026-04-14T12:00:00+00:00"
        },
        "nombreTool": "ping",
        "job_id": "123e4567-e89b-12d3-a456-426614174000"
    }

    """
    return procesarTool("ping", {"message": message})


@mcp.tool()
def scan_wifi_networks(
    interface: str | None = None,
    scan_seconds: str | None = None,
    band: str | None = None,
    include_hidden: str | None = None,
) -> dict[str, Any]:
    """Scan visible Wi-Fi networks and observed wireless clients.

    This tool is asynchronous. It returns a job_id that must be used later to
    poll the final result from the corresponding job resource.

    Shared tool contract:
    - file: /contracts/tools.json
    - this tool is designed to capture nearby networks, their beacon metadata
      and the wireless clients observed during the scan window

    Example input:
    {
        "interface": "wlan1mon",
        "scan_seconds": "8",
        "band": "all",
        "include_hidden": "true"
    }

    Example first output:
    {
        "job_id": "123e4567-e89b-12d3-a456-426614174000"
    }

    Example final output shape:
    {
        "raw_text": "csv output ...",
        "normalized": {
            "interface": "wlan1mon",
            "scan_seconds": 8,
            "band": "all",
            "include_hidden": true,
            "networks_count": 3,
            "clients_count": 2,
            "networks": [],
            "clients": []
        },
        "nombreTool": "scan_wifi_networks",
        "job_id": "123e4567-e89b-12d3-a456-426614174000"
    }
    """
    return procesarTool(
        "scan_wifi_networks",
        {
            "interface": interface,
            "scan_seconds": scan_seconds,
            "band": band,
            "include_hidden": include_hidden,
        },
    )


@mcp.tool()
def inspect_target_network_profile(
    interface: str | None = None,
    target_ssid: str | None = None,
    scan_seconds: str | None = None,
) -> dict[str, Any]:
    """Refresh and enrich the profile of a fixed target network by SSID.

    This tool is asynchronous. It returns a job_id that must be used later to
    poll the final result from the corresponding job resource.
    """
    return procesarTool(
        "inspect_target_network_profile",
        {
            "interface": interface,
            "target_ssid": target_ssid,
            "scan_seconds": scan_seconds,
        },
    )


@mcp.tool()
def detect_wps_exposure(
    interface: str | None = None,
    target_bssids: str | None = None,
    scan_seconds: str | None = None,
) -> dict[str, Any]:
    """Check whether the target network exposes WPS information.

    This tool is asynchronous. It returns a job_id that must be used later to
    poll the final result from the corresponding job resource.

    Shared tool contract:
    - file: /contracts/tools.json
    - this tool is designed to inspect a target BSSID for visible WPS exposure

    Example input:
    {
        "interface": "wlan0mon",
        "target_bssids": "44:3B:14:2B:A5:7F,44:3B:14:2B:A5:78",
        "scan_seconds": "8"
    }
    """
    return procesarTool(
        "detect_wps_exposure",
        {
            "interface": interface,
            "target_bssids": target_bssids,
            "scan_seconds": scan_seconds,
        },
    )


@mcp.tool()
def connect_to_target_network(
    interface: str | None = None,
    ssid: str | None = None,
    password: str | None = None,
) -> dict[str, Any]:
    """Connect the local machine to the fixed Wi-Fi target network.

    This tool is asynchronous. It returns a job_id that must be used later to
    poll the final result from the corresponding job resource.
    """
    return procesarTool(
        "connect_to_target_network",
        {
            "interface": interface,
            "ssid": ssid,
            "password": password,
        },
    )


@mcp.tool()
def get_connection_status(
    interface: str | None = None,
    expected_ssid: str | None = None,
) -> dict[str, Any]:
    """Check the current managed Wi-Fi connection state for one interface.

    This tool is asynchronous. It returns a job_id that must be used later to
    poll the final result from the corresponding job resource.
    """
    return procesarTool(
        "get_connection_status",
        {
            "interface": interface,
            "expected_ssid": expected_ssid,
        },
    )


@mcp.tool()
def disconnect_from_network(
    interface: str | None = None,
) -> dict[str, Any]:
    """Disconnect the managed Wi-Fi interface from its current network.

    This tool is asynchronous. It returns a job_id that must be used later to
    poll the final result from the corresponding job resource.
    """
    return procesarTool(
        "disconnect_from_network",
        {
            "interface": interface,
        },
    )


@mcp.tool()
def discover_gateway_and_router_profile(
    interface: str | None = None,
    expected_ssid: str | None = None,
) -> dict[str, Any]:
    """Identify the connected router, gateway and basic admin surface.

    This tool is asynchronous. It returns a job_id that must be used later to
    poll the final result from the corresponding job resource.
    """
    return procesarTool(
        "discover_gateway_and_router_profile",
        {
            "interface": interface,
            "expected_ssid": expected_ssid,
        },
    )


@mcp.resource("job://{job_id}")
def job_result(job_id: str) -> dict[str, Any]:
    """Expose the state and result of a queued job."""
    redis_client = get_redis_client()
    return get_job(redis_client, job_id)


def main() -> None:
    """Run the MCP server over local streamable HTTP with CORS enabled."""
    app = mcp.streamable_http_app()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=os.getenv("MCP_CORS_ALLOW_ORIGINS", "*").split(","),
        allow_methods=["OPTIONS", "POST"],
        allow_headers=["Content-Type", "MCP-Protocol-Version"],
    )

    uvicorn.run(
        app,
        host=os.getenv("MCP_HOST", "127.0.0.1"),
        port=int(os.getenv("MCP_PORT", "8000")),
    )


if __name__ == "__main__":
    main()
