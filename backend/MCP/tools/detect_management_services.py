"""Execution logic for detecting management services exposed by the router."""

from __future__ import annotations

import socket
from typing import Any

from tools.discover_gateway_and_router_profile import probe_web_admin
from tools.helpers import ensure_interface_mode, get_managed_connection_snapshot, utc_now_iso

COMMON_MANAGEMENT_PORTS = [
    {"port": 80, "protocol": "tcp", "service_name": "HTTP admin"},
    {"port": 443, "protocol": "tcp", "service_name": "HTTPS admin"},
    {"port": 22, "protocol": "tcp", "service_name": "SSH management"},
    {"port": 23, "protocol": "tcp", "service_name": "Telnet management"},
    {"port": 21, "protocol": "tcp", "service_name": "FTP management"},
    {"port": 161, "protocol": "udp", "service_name": "SNMP management"},
    {"port": 7547, "protocol": "tcp", "service_name": "TR-069 / CWMP"},
    {"port": 8080, "protocol": "tcp", "service_name": "HTTP admin alt"},
    {"port": 8443, "protocol": "tcp", "service_name": "HTTPS admin alt"},
]


def read_tcp_banner(host: str, port: int, timeout_seconds: int) -> str | None:
    """Try to read a short banner from a TCP service when possible."""
    try:
        with socket.create_connection((host, port), timeout=timeout_seconds) as sock:
            sock.settimeout(timeout_seconds)
            if port == 23:
                try:
                    sock.sendall(b"\r\n")
                except OSError:
                    pass
            data = sock.recv(512)
    except OSError:
        return None

    if not data:
        return None
    return data.decode("utf-8", errors="ignore").strip() or None


def probe_snmp_public(host: str, port: int, timeout_seconds: int) -> tuple[bool, str | None]:
    """Try a minimal SNMPv1 sysDescr request with community 'public'."""
    request = bytes.fromhex(
        "302602010004067075626c6963a01902044d434001020100020100300b300906052b060102010500"
    )
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(timeout_seconds)
            sock.sendto(request, (host, port))
            data, _ = sock.recvfrom(1024)
    except OSError:
        return False, None

    if not data:
        return False, None

    ascii_preview = data.decode("utf-8", errors="ignore").strip()
    if ascii_preview:
        return True, f"SNMP response: {ascii_preview[:120]}"
    return True, f"SNMP response ({len(data)} bytes)"


def classify_management_risk(service_name: str, reachable: bool, requires_auth: bool | None) -> str:
    """Assign a coarse risk level to a management service."""
    normalized_name = service_name.lower()
    if not reachable:
        return "none"
    if "telnet" in normalized_name:
        return "high"
    if "snmp" in normalized_name:
        return "high"
    if "ftp" in normalized_name:
        return "high"
    if "tr-069" in normalized_name or "cwmp" in normalized_name:
        return "medium"
    if "http" in normalized_name and "https" not in normalized_name:
        return "high" if requires_auth is False else "medium"
    if "ssh" in normalized_name:
        return "medium"
    if "https" in normalized_name:
        return "medium"
    return "low"


def summarize_management_exposure(services: list[dict[str, Any]]) -> str:
    """Compute a coarse overall management exposure level."""
    detected = [service for service in services if service["reachable"]]
    if not detected:
        return "low"

    if any(service["risk_level"] == "high" for service in detected):
        return "high"
    if any(service["risk_level"] == "medium" for service in detected):
        return "medium"
    return "low"


def build_recommendations(services: list[dict[str, Any]]) -> list[str]:
    """Generate a few human-readable recommendations from the detected services."""
    detected = [service for service in services if service["reachable"]]
    recommendations: list[str] = []

    if not detected:
        return [
            "No se han detectado servicios tipicos de administracion abiertos durante esta comprobacion.",
        ]

    if any(service["port"] == 23 and service["reachable"] for service in services):
        recommendations.append("Si Telnet esta habilitado y no es imprescindible, seria recomendable desactivarlo.")
    if any(service["port"] == 21 and service["reachable"] for service in services):
        recommendations.append("Si FTP aparece abierto y no se utiliza de forma consciente, conviene cerrarlo porque expone credenciales y transferencias sin cifrar.")
    if any(service["port"] == 161 and service["reachable"] for service in services):
        recommendations.append("Si SNMP responde en la LAN, revisa si realmente es necesario y cambia comunidades por defecto como 'public' o desactivalo.")
    if any(service["port"] == 7547 and service["reachable"] for service in services):
        recommendations.append("Si TR-069/CWMP esta accesible, conviene confirmar que solo se usa para gestion del operador y que no expone funciones innecesarias en la LAN.")
    if any(service["port"] == 80 and service["reachable"] for service in services):
        recommendations.append("Si el panel web responde por HTTP, conviene priorizar HTTPS siempre que el router lo permita.")
    if any(service["port"] == 22 and service["reachable"] for service in services):
        recommendations.append("Si SSH no se utiliza para administracion, cerrar ese acceso reduce superficie de ataque.")
    if any(service["port"] in {8080, 8443} and service["reachable"] for service in services):
        recommendations.append("La presencia de puertos alternativos de administracion merece una revision adicional del panel del router.")
    if not recommendations:
        recommendations.append("Los servicios detectados parecen limitados, pero conviene revisar manualmente el panel del router para confirmar la configuracion.")

    return recommendations


def detect_management_services_execute(input: dict[str, Any]) -> dict[str, Any]:
    """Detect common management services on the connected router."""
    requested_interface = str(input["interface"])
    requested_gateway_ip = str(input["gateway_ip"]).strip() or None
    timeout_seconds = int(str(input["timeout_seconds"]))

    interface_details = ensure_interface_mode(requested_interface, "managed")
    resolved_interface = interface_details["resolved_interface"]
    snapshot = get_managed_connection_snapshot(resolved_interface)
    gateway_ip = requested_gateway_ip or snapshot["gateway"]

    if not gateway_ip:
        raise RuntimeError("No gateway IP is available for management service detection.")

    http_result = probe_web_admin("http", gateway_ip)
    https_result = probe_web_admin("https", gateway_ip)

    web_results_by_port = {
        80: http_result,
        443: https_result,
        8080: {
            "reachable": False,
            "url": f"http://{gateway_ip}:8080",
            "final_url": None,
            "status_code": None,
            "title": None,
            "server": None,
            "content_type": None,
            "text_preview": [],
            "auth_detection": {
                "auth_required": None,
                "auth_type": None,
                "login_form_detected": False,
                "password_field_detected": False,
                "username_field_detected": False,
                "source_url": None,
                "evidence": [],
            },
        },
        8443: {
            "reachable": False,
            "url": f"https://{gateway_ip}:8443",
            "final_url": None,
            "status_code": None,
            "title": None,
            "server": None,
            "content_type": None,
            "text_preview": [],
            "auth_detection": {
                "auth_required": None,
                "auth_type": None,
                "login_form_detected": False,
                "password_field_detected": False,
                "username_field_detected": False,
                "source_url": None,
                "evidence": [],
            },
        },
    }

    services: list[dict[str, Any]] = []
    raw_blocks: list[str] = []

    for port_definition in COMMON_MANAGEMENT_PORTS:
        port = port_definition["port"]
        protocol = port_definition["protocol"]
        service_name = port_definition["service_name"]

        if port in web_results_by_port and port in {80, 443}:
            web_result = web_results_by_port[port]
            reachable = bool(web_result["reachable"])
            requires_auth = web_result["auth_detection"]["auth_required"]
            auth_type = web_result["auth_detection"]["auth_type"]
            banner = web_result["server"]
            url = web_result["url"]
            title = web_result["title"]
            server = web_result["server"]
        elif port in {8080, 8443}:
            scheme = "http" if port == 8080 else "https"
            web_result = probe_web_admin(scheme, f"{gateway_ip}:{port}")
            web_results_by_port[port] = web_result
            reachable = bool(web_result["reachable"])
            requires_auth = web_result["auth_detection"]["auth_required"]
            auth_type = web_result["auth_detection"]["auth_type"]
            banner = web_result["server"]
            url = web_result["url"]
            title = web_result["title"]
            server = web_result["server"]
        elif protocol == "udp" and port == 161:
            reachable, banner = probe_snmp_public(gateway_ip, port, timeout_seconds)
            requires_auth = True if reachable else None
            auth_type = "community_public" if reachable else None
            url = None
            title = None
            server = None
        else:
            banner = read_tcp_banner(gateway_ip, port, timeout_seconds)
            reachable = banner is not None
            if not reachable:
                try:
                    with socket.create_connection((gateway_ip, port), timeout=timeout_seconds):
                        reachable = True
                except OSError:
                    reachable = False
            requires_auth = None
            auth_type = None
            url = None
            title = None
            server = None

        risk_level = classify_management_risk(service_name, reachable, requires_auth)

        service_result = {
            "service_name": service_name,
            "port": port,
            "protocol": protocol,
            "reachable": reachable,
            "banner": banner,
            "requires_auth": requires_auth,
            "auth_type": auth_type,
            "risk_level": risk_level,
            "url": url,
            "title": title,
            "server": server,
        }
        services.append(service_result)

        raw_blocks.append(
            "\n".join(
                [
                    f"service={service_name}",
                    f"port={port}",
                    f"reachable={reachable}",
                    f"banner={banner or '<empty>'}",
                    f"requires_auth={requires_auth}",
                    f"auth_type={auth_type or '<none>'}",
                    f"url={url or '<none>'}",
                    f"title={title or '<none>'}",
                    f"server={server or '<none>'}",
                ]
            )
        )

    detected_services = [service for service in services if service["reachable"]]
    normalized = {
        "interface": requested_interface,
        "resolved_interface": resolved_interface,
        "required_mode": "managed",
        "gateway_ip": gateway_ip,
        "services_detected_count": len(detected_services),
        "web_admin_detected": any(service["reachable"] and "admin" in service["service_name"].lower() for service in services if service["port"] in {80, 443, 8080, 8443}),
        "ssh_detected": any(service["port"] == 22 and service["reachable"] for service in services),
        "telnet_detected": any(service["port"] == 23 and service["reachable"] for service in services),
        "management_exposure_level": summarize_management_exposure(services),
        "services": services,
        "recommendations": build_recommendations(services),
        "completed_at": utc_now_iso(),
    }

    return {
        "raw_text": "\n\n".join(raw_blocks),
        "normalized": normalized,
    }
