"""Execution logic for detecting UPnP exposure from inside the local network."""

from __future__ import annotations

import socket
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any

from tools.helpers import ensure_interface_mode, get_managed_connection_snapshot, utc_now_iso

SSDP_MULTICAST_IP = "239.255.255.250"
SSDP_MULTICAST_PORT = 1900
SSDP_SEARCH_TARGETS = [
    "ssdp:all",
    "upnp:rootdevice",
    "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
]
SSDP_DISCOVERY_ROUNDS = 3


def parse_ssdp_response(raw_text: str) -> dict[str, str]:
    """Parse one SSDP response block into a normalized header dictionary."""
    headers: dict[str, str] = {}
    lines = [line.strip() for line in raw_text.splitlines() if line.strip() != ""]
    for line in lines[1:]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return headers


def build_ssdp_request_payload(search_target: str) -> bytes:
    """Build one SSDP discovery payload for a specific ST."""
    return "\r\n".join(
        [
            "M-SEARCH * HTTP/1.1",
            f"HOST: {SSDP_MULTICAST_IP}:{SSDP_MULTICAST_PORT}",
            'MAN: "ssdp:discover"',
            "MX: 2",
            f"ST: {search_target}",
            "",
            "",
        ]
    ).encode("ascii")


def send_ssdp_discovery(interface_ip: str, timeout_seconds: int) -> tuple[list[dict[str, Any]], list[str]]:
    """Send several SSDP discovery queries and collect raw responses plus diagnostics."""
    responses: list[dict[str, Any]] = []
    diagnostics: list[str] = []
    seen_response_keys: set[tuple[str, str, str, str]] = set()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(interface_ip))
        sock.bind((interface_ip, 0))
        per_probe_timeout = max(1.0, timeout_seconds / max(1, len(SSDP_SEARCH_TARGETS)))

        for round_index in range(SSDP_DISCOVERY_ROUNDS):
            diagnostics.append(f"round={round_index + 1}")
            for search_target in SSDP_SEARCH_TARGETS:
                request_payload = build_ssdp_request_payload(search_target)
                diagnostics.append(f"send_st={search_target}")
                sock.sendto(request_payload, (SSDP_MULTICAST_IP, SSDP_MULTICAST_PORT))
                round_deadline = time.monotonic() + per_probe_timeout

                while time.monotonic() < round_deadline:
                    remaining_timeout = max(0.1, round_deadline - time.monotonic())
                    sock.settimeout(remaining_timeout)
                    try:
                        data, sender = sock.recvfrom(65535)
                    except socket.timeout:
                        break

                    raw_text = data.decode("utf-8", errors="ignore")
                    headers = parse_ssdp_response(raw_text)
                    response_key = (
                        sender[0],
                        str(headers.get("location") or ""),
                        str(headers.get("st") or ""),
                        str(headers.get("usn") or ""),
                    )
                    if response_key in seen_response_keys:
                        continue

                    seen_response_keys.add(response_key)
                    responses.append(
                        {
                            "sender_ip": sender[0],
                            "sender_port": sender[1],
                            "raw_text": raw_text,
                            "headers": headers,
                            "matched_search_target": search_target,
                        }
                    )

                time.sleep(0.1)
    finally:
        sock.close()

    diagnostics.append(f"responses_collected={len(responses)}")
    return (responses, diagnostics)


def is_likely_router_response(response: dict[str, Any], gateway_ip: str | None) -> bool:
    """Check whether an SSDP response likely belongs to the current router."""
    if gateway_ip is None:
        return False

    if response.get("sender_ip") == gateway_ip:
        return True

    location = str(response.get("headers", {}).get("location") or "")
    if location:
        parsed_location = urllib.parse.urlparse(location)
        if parsed_location.hostname == gateway_ip:
            return True

    return False


def score_upnp_response(response: dict[str, Any], gateway_ip: str | None) -> int:
    """Score responses so we can choose the most relevant one."""
    headers = response.get("headers", {})
    st = str(headers.get("st") or "").lower()
    usn = str(headers.get("usn") or "").lower()
    location = str(headers.get("location") or "")

    score = 0
    if is_likely_router_response(response, gateway_ip):
        score += 100
    if "internetgatewaydevice" in st or "internetgatewaydevice" in usn:
        score += 30
    if "wanipconnection" in st or "wanipconnection" in usn:
        score += 25
    if location != "":
        score += 10
    return score


def choose_best_upnp_response(
    responses: list[dict[str, Any]],
    gateway_ip: str | None,
) -> dict[str, Any] | None:
    """Choose the best SSDP response for the target router."""
    if not responses:
        return None

    return max(responses, key=lambda response: score_upnp_response(response, gateway_ip))


def strip_xml_namespace(tag: str) -> str:
    """Remove the XML namespace prefix from an ElementTree tag."""
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def find_first_text(root: ET.Element, tag_name: str) -> str | None:
    """Find the first XML node with the given local name and return its text."""
    for element in root.iter():
        if strip_xml_namespace(element.tag) != tag_name:
            continue
        if element.text and element.text.strip():
            return element.text.strip()
    return None


def xml_contains_text(root: ET.Element, expected_fragment: str) -> bool:
    """Check whether any XML text or tag contains one expected fragment."""
    normalized_fragment = expected_fragment.lower()
    for element in root.iter():
        if normalized_fragment in strip_xml_namespace(element.tag).lower():
            return True
        if element.text and normalized_fragment in element.text.lower():
            return True
    return False


def fetch_device_description(location: str | None) -> dict[str, Any]:
    """Download and parse the device description XML when available."""
    if not location:
        return {
            "device_description_retrieved": False,
            "device_friendly_name": None,
            "device_manufacturer": None,
            "device_model": None,
            "igd_detected": False,
            "wan_ip_connection_service": None,
            "port_mapping_capable": None,
            "evidence": [],
            "xml_summary": "",
        }

    try:
        request_obj = urllib.request.Request(location, headers={"User-Agent": "WIFITEST/1.0"})
        with urllib.request.urlopen(request_obj, timeout=4) as response:
            xml_text = response.read(65536).decode("utf-8", errors="ignore")
    except Exception as exc:
        return {
            "device_description_retrieved": False,
            "device_friendly_name": None,
            "device_manufacturer": None,
            "device_model": None,
            "igd_detected": False,
            "wan_ip_connection_service": None,
            "port_mapping_capable": None,
            "evidence": [f"Could not retrieve the UPnP device description: {exc}"],
            "xml_summary": "",
        }

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        return {
            "device_description_retrieved": False,
            "device_friendly_name": None,
            "device_manufacturer": None,
            "device_model": None,
            "igd_detected": False,
            "wan_ip_connection_service": None,
            "port_mapping_capable": None,
            "evidence": [f"The UPnP device description could not be parsed as XML: {exc}"],
            "xml_summary": xml_text[:1200],
        }

    igd_detected = xml_contains_text(root, "internetgatewaydevice")
    wan_ip_connection_service = (
        xml_contains_text(root, "wanipconnection")
        or xml_contains_text(root, "wanpppconnection")
    )
    port_mapping_capable = True if wan_ip_connection_service else None

    evidence: list[str] = []
    if igd_detected:
        evidence.append("The device description references an InternetGatewayDevice profile.")
    if wan_ip_connection_service:
        evidence.append("The device description references WANIPConnection or WANPPPConnection services.")

    return {
        "device_description_retrieved": True,
        "device_friendly_name": find_first_text(root, "friendlyName"),
        "device_manufacturer": find_first_text(root, "manufacturer"),
        "device_model": find_first_text(root, "modelName"),
        "igd_detected": igd_detected,
        "wan_ip_connection_service": wan_ip_connection_service,
        "port_mapping_capable": port_mapping_capable,
        "evidence": evidence,
        "xml_summary": xml_text[:2000],
    }


def determine_upnp_confidence(
    upnp_detected: bool,
    matching_router_response: bool,
    igd_detected: bool,
    port_mapping_capable: bool | None,
) -> str:
    """Summarize the confidence of the UPnP finding."""
    if upnp_detected and matching_router_response and (igd_detected or port_mapping_capable):
        return "high"
    if upnp_detected and (matching_router_response or igd_detected):
        return "medium"
    if upnp_detected:
        return "low"
    return "none"


def build_raw_text(
    responses: list[dict[str, Any]],
    chosen_response: dict[str, Any] | None,
    description_summary: dict[str, Any],
    diagnostics: list[str],
) -> str:
    """Build a readable raw summary from SSDP responses and XML data."""
    blocks = []
    if diagnostics:
        blocks.append("--- SSDP DIAGNOSTIC ---\n" + "\n".join(diagnostics))

    for index, response in enumerate(responses, start=1):
        blocks.append(
            "\n".join(
                [
                    f"--- SSDP RESPONSE {index} ---",
                    f"sender={response.get('sender_ip')}:{response.get('sender_port')}",
                    f"matched_search_target={response.get('matched_search_target', '')}",
                    response.get("raw_text", "").strip(),
                ]
            )
        )

    if chosen_response:
        blocks.append(
            "\n".join(
                [
                    "--- SELECTED RESPONSE ---",
                    f"sender={chosen_response.get('sender_ip')}:{chosen_response.get('sender_port')}",
                    f"location={chosen_response.get('headers', {}).get('location', '')}",
                    f"st={chosen_response.get('headers', {}).get('st', '')}",
                    f"usn={chosen_response.get('headers', {}).get('usn', '')}",
                ]
            )
        )

    if description_summary.get("xml_summary"):
        blocks.append("--- DEVICE DESCRIPTION XML PREVIEW ---\n" + description_summary["xml_summary"])

    return "\n\n".join(block for block in blocks if block.strip() != "")


def detect_upnp_exposure_execute(input: dict[str, Any]) -> dict[str, Any]:
    """Discover whether the connected router exposes UPnP/IGD over SSDP."""
    requested_interface = str(input["interface"])
    requested_gateway_ip = str(input["gateway_ip"]).strip() or None
    timeout_seconds = int(str(input["timeout_seconds"]))

    interface_details = ensure_interface_mode(requested_interface, "managed")
    resolved_interface = interface_details["resolved_interface"]
    snapshot = get_managed_connection_snapshot(resolved_interface)
    interface_ip = snapshot["ipv4"]
    gateway_ip = requested_gateway_ip or snapshot["gateway"]

    if not interface_ip:
        raise RuntimeError("The managed interface does not have an IPv4 address, so SSDP discovery cannot be sent.")

    responses, diagnostics = send_ssdp_discovery(interface_ip, timeout_seconds)
    chosen_response = choose_best_upnp_response(responses, gateway_ip)
    chosen_headers = chosen_response.get("headers", {}) if chosen_response else {}
    location = chosen_headers.get("location")
    description_summary = fetch_device_description(location)
    matching_router_response = bool(chosen_response and is_likely_router_response(chosen_response, gateway_ip))

    evidence = [f"Collected {len(responses)} SSDP response(s) on the local network."]
    evidence.extend(description_summary.get("evidence", []))

    if chosen_response:
        evidence.append("A candidate UPnP response was selected as the most relevant one.")
    if matching_router_response:
        evidence.append("The selected UPnP response appears to belong to the current gateway.")

    upnp_detected = len(responses) > 0
    igd_detected = bool(
        description_summary.get("igd_detected")
        or "internetgatewaydevice" in str(chosen_headers.get("st") or "").lower()
        or "internetgatewaydevice" in str(chosen_headers.get("usn") or "").lower()
    )

    normalized = {
        "interface": requested_interface,
        "resolved_interface": resolved_interface,
        "required_mode": "managed",
        "gateway_ip": gateway_ip,
        "target_matches_gateway": matching_router_response if gateway_ip else None,
        "upnp_detected": upnp_detected,
        "igd_detected": igd_detected,
        "ssdp_responses_count": len(responses),
        "matching_router_response": matching_router_response,
        "location": location,
        "server": chosen_headers.get("server"),
        "usn": chosen_headers.get("usn"),
        "st": chosen_headers.get("st"),
        "device_description_retrieved": description_summary["device_description_retrieved"],
        "device_friendly_name": description_summary["device_friendly_name"],
        "device_manufacturer": description_summary["device_manufacturer"],
        "device_model": description_summary["device_model"],
        "wan_ip_connection_service": description_summary["wan_ip_connection_service"],
        "port_mapping_capable": description_summary["port_mapping_capable"],
        "confidence": determine_upnp_confidence(
            upnp_detected,
            matching_router_response,
            igd_detected,
            description_summary["port_mapping_capable"],
        ),
        "evidence": evidence,
        "completed_at": utc_now_iso(),
    }

    return {
        "raw_text": build_raw_text(responses, chosen_response, description_summary, diagnostics),
        "normalized": normalized,
    }
