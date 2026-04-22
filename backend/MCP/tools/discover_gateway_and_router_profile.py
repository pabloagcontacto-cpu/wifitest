"""Execution logic for identifying the connected gateway and router profile."""

from __future__ import annotations

import csv
import gzip
import re
import socket
import ssl
from functools import lru_cache
from html import unescape
from pathlib import Path
from typing import Any
from urllib import error, request

from tools.helpers import (
    ensure_interface_mode,
    get_dns_servers_for_interface,
    get_gateway_for_interface,
    get_managed_connection_snapshot,
    get_nmcli_connection_name,
    run_command,
    utc_now_iso,
)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
MAC_VENDOR_DB_PATH = PROJECT_ROOT / "mac.csv"
COMMON_ROUTER_PORTS = [53, 80, 443, 22, 23, 8080]


@lru_cache(maxsize=1)
def load_mac_vendor_index() -> dict[str, str]:
    """Load the local MAC/OUI vendor index from `mac.csv` when available."""
    if not MAC_VENDOR_DB_PATH.exists():
        return {}

    vendor_index: dict[str, str] = {}
    with MAC_VENDOR_DB_PATH.open("r", encoding="utf-8", newline="") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            assignment = str(row.get("Assignment") or "").strip().upper()
            organization_name = str(row.get("Organization Name") or "").strip()
            if assignment == "" or organization_name == "":
                continue
            vendor_index[assignment] = organization_name
    return vendor_index


def extract_mac_prefix(mac_address: str | None) -> str | None:
    """Convert a MAC address into its canonical 6-hex-character OUI prefix."""
    if not mac_address:
        return None

    normalized = re.sub(r"[^0-9A-Fa-f]", "", mac_address).upper()
    if len(normalized) < 6:
        return None
    return normalized[:6]


def lookup_mac_vendor(mac_address: str | None) -> tuple[str | None, str | None]:
    """Resolve the vendor for a MAC address using the local IEEE OUI export."""
    prefix = extract_mac_prefix(mac_address)
    if prefix is None:
        return (None, None)

    vendor = load_mac_vendor_index().get(prefix)
    if vendor is None:
        return (None, "mac.csv")
    return (vendor, "mac.csv")


def extract_mac_from_text(raw_text: str) -> str | None:
    """Extract one MAC address from a text blob when present."""
    match = re.search(r"([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", raw_text)
    if not match:
        return None
    return match.group(0).upper()


def get_gateway_mac_from_ip_neigh(interface: str, gateway_ip: str) -> str | None:
    """Read the gateway MAC from `ip neigh`."""
    completed = run_command(
        ["ip", "neigh", "show", gateway_ip, "dev", interface],
        check=False,
    )
    return extract_mac_from_text(completed.stdout)


def get_gateway_mac_from_proc_arp(interface: str, gateway_ip: str) -> str | None:
    """Read the gateway MAC from `/proc/net/arp` when available."""
    try:
        with Path("/proc/net/arp").open("r", encoding="utf-8") as arp_file:
            for line in arp_file.readlines()[1:]:
                columns = line.split()
                if len(columns) < 6:
                    continue
                ip_address, _, _, hw_address, _, device = columns[:6]
                if ip_address == gateway_ip and device == interface:
                    mac_address = extract_mac_from_text(hw_address)
                    if mac_address:
                        return mac_address
    except OSError:
        return None
    return None


def get_gateway_mac_from_arp_command(gateway_ip: str) -> str | None:
    """Read the gateway MAC from the `arp` command when installed."""
    completed = run_command(["arp", "-n", gateway_ip], check=False)
    return extract_mac_from_text(completed.stdout)


def get_gateway_mac(interface: str, gateway_ip: str | None) -> tuple[str | None, str | None]:
    """Read the gateway MAC address from the local neighbor table."""
    if not gateway_ip:
        return (None, None)

    for _ in range(2):
        gateway_mac = get_gateway_mac_from_ip_neigh(interface, gateway_ip)
        if gateway_mac:
            return (gateway_mac, "ip_neigh")

        gateway_mac = get_gateway_mac_from_proc_arp(interface, gateway_ip)
        if gateway_mac:
            return (gateway_mac, "proc_net_arp")

        gateway_mac = get_gateway_mac_from_arp_command(gateway_ip)
        if gateway_mac:
            return (gateway_mac, "arp_command")

        run_command(["ping", "-c", "1", "-W", "1", gateway_ip], check=False)

    return (None, None)


def probe_icmp_latency(host: str | None) -> tuple[bool | None, float | None, str]:
    """Check whether the gateway replies to ICMP and parse average latency."""
    if not host:
        return (None, None, "No gateway IP available for ICMP probe.")

    completed = run_command(["ping", "-c", "2", "-W", "2", host], check=False)
    combined_output = "\n".join(
        part for part in [completed.stdout.strip(), completed.stderr.strip()] if part
    )

    if completed.returncode != 0:
        return (False, None, combined_output or "ICMP probe failed.")

    avg_latency_ms = None
    latency_match = re.search(
        r"=\s*([0-9.]+)/([0-9.]+)/([0-9.]+)/",
        completed.stdout,
    )
    if latency_match:
        avg_latency_ms = float(latency_match.group(2))

    return (True, avg_latency_ms, combined_output or "ICMP probe succeeded.")


def probe_open_tcp_ports(host: str | None, ports: list[int]) -> list[int]:
    """Try a short TCP connection to a small set of common router ports."""
    if not host:
        return []

    open_ports: list[int] = []
    for port in ports:
        try:
            with socket.create_connection((host, port), timeout=1.2):
                open_ports.append(port)
        except OSError:
            continue
    return open_ports


def extract_html_title(html_text: str) -> str | None:
    """Extract the best human-readable page title or heading when present."""
    title_match = re.search(
        r"<title[^>]*>\s*(.*?)\s*</title>",
        html_text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if title_match:
        title = unescape(re.sub(r"\s+", " ", title_match.group(1)).strip())
        if title:
            return title

    for pattern in [
        r"<meta[^>]+property=['\"]og:title['\"][^>]+content=['\"](.*?)['\"]",
        r"<meta[^>]+name=['\"]title['\"][^>]+content=['\"](.*?)['\"]",
        r"<h1[^>]*>\s*(.*?)\s*</h1>",
        r"<h2[^>]*>\s*(.*?)\s*</h2>",
    ]:
        match = re.search(pattern, html_text, flags=re.IGNORECASE | re.DOTALL)
        if not match:
            continue
        extracted = re.sub(r"<[^>]+>", " ", match.group(1))
        extracted = unescape(re.sub(r"\s+", " ", extracted).strip())
        if extracted:
            return extracted

    return None


def detect_response_charset(
    raw_body: bytes,
    content_type: str | None,
) -> str | None:
    """Infer the response charset from headers or HTML meta tags."""
    if content_type:
        header_match = re.search(r"charset=([A-Za-z0-9._-]+)", content_type, flags=re.IGNORECASE)
        if header_match:
            return header_match.group(1).strip("\"' ").lower()

    ascii_preview = raw_body[:4096].decode("ascii", errors="ignore")
    meta_match = re.search(
        r"<meta[^>]+charset=['\"]?\s*([A-Za-z0-9._-]+)\s*['\"]?",
        ascii_preview,
        flags=re.IGNORECASE,
    )
    if meta_match:
        return meta_match.group(1).lower()

    http_equiv_match = re.search(
        r"<meta[^>]+content=['\"][^'\"]*charset=([A-Za-z0-9._-]+)[^'\"]*['\"]",
        ascii_preview,
        flags=re.IGNORECASE,
    )
    if http_equiv_match:
        return http_equiv_match.group(1).lower()

    return None


def decode_response_body(raw_body: bytes, content_encoding: str | None, content_type: str | None) -> str:
    """Decode a small HTTP body with basic support for gzip responses and charsets."""
    encoding = (content_encoding or "").lower()

    if encoding == "gzip":
        try:
            raw_body = gzip.decompress(raw_body)
        except OSError:
            pass

    candidate_charsets = []
    detected_charset = detect_response_charset(raw_body, content_type)
    if detected_charset:
        candidate_charsets.append(detected_charset)
    candidate_charsets.extend(["utf-8", "latin-1", "cp1252"])

    for charset in candidate_charsets:
        try:
            return raw_body.decode(charset, errors="strict")
        except (LookupError, UnicodeDecodeError):
            continue

    return raw_body.decode("utf-8", errors="ignore")


def extract_visible_text_lines(html_text: str, max_lines: int = 6) -> list[str]:
    """Extract a short preview of human-visible text from an HTML document."""
    cleaned = re.sub(r"(?is)<(script|style|noscript|svg).*?>.*?</\1>", " ", html_text)
    cleaned = re.sub(r"(?is)<br\s*/?>", "\n", cleaned)
    cleaned = re.sub(r"(?is)</(p|div|section|article|header|footer|li|h1|h2|h3|h4|h5|h6)>", "\n", cleaned)
    cleaned = re.sub(r"(?is)<[^>]+>", " ", cleaned)
    cleaned = unescape(cleaned)

    lines: list[str] = []
    for raw_line in cleaned.splitlines():
        normalized_line = re.sub(r"\s+", " ", raw_line).strip()
        if len(normalized_line) < 4:
            continue
        if normalized_line.lower() in {"entrar", "login", "aceptar"}:
            continue
        if normalized_line in lines:
            continue
        lines.append(normalized_line)
        if len(lines) >= max_lines:
            break

    return lines


def infer_title_from_visible_text(text_lines: list[str]) -> str | None:
    """Infer a useful page name from visible text when no HTML title exists."""
    if not text_lines:
        return None

    preferred_patterns = [
        r"router",
        r"wifi",
        r"movistar",
        r"configur",
        r"fibra",
    ]

    for line in text_lines:
        normalized = line.lower()
        if any(pattern in normalized for pattern in preferred_patterns):
            return line

    return text_lines[0]


def detect_admin_auth(body: str, response_headers: Any, status_code: int | None, source_url: str | None) -> dict[str, Any]:
    """Infer whether the router panel is requesting authentication and in what form."""
    normalized_body = body.lower()
    evidence: list[str] = []

    password_field_detected = bool(
        re.search(r"<input[^>]+type=['\"]password['\"]", body, flags=re.IGNORECASE)
        or re.search(r"(contrasen|contrase|password)", normalized_body)
    )
    username_field_detected = bool(
        re.search(
            r"<input[^>]+(?:name|id|placeholder)=['\"][^'\"]*(user|usuario|login|correo|email|admin)[^'\"]*['\"]",
            body,
            flags=re.IGNORECASE,
        )
        or re.search(r"(usuario|username|user name|correo|email)", normalized_body)
    )
    login_form_detected = bool(re.search(r"<form\b", body, flags=re.IGNORECASE) and password_field_detected)

    if password_field_detected:
        evidence.append("password_field")
    if username_field_detected:
        evidence.append("username_hint")
    if login_form_detected:
        evidence.append("login_form")

    www_authenticate = None
    if response_headers is not None:
        try:
            www_authenticate = response_headers.get("WWW-Authenticate")
        except Exception:
            www_authenticate = None

    if www_authenticate:
        evidence.append("www_authenticate_header")

    auth_required = None
    if status_code in {401, 403} or www_authenticate:
        auth_required = True
    elif password_field_detected or username_field_detected or login_form_detected:
        auth_required = True
    elif status_code is not None:
        auth_required = False

    auth_type = None
    if auth_required:
        if username_field_detected and password_field_detected:
            auth_type = "username_password"
        elif password_field_detected:
            auth_type = "password_only"
        elif www_authenticate:
            auth_type = "http_auth"
        else:
            auth_type = "unknown"

    return {
        "auth_required": auth_required,
        "auth_type": auth_type,
        "login_form_detected": login_form_detected,
        "password_field_detected": password_field_detected,
        "username_field_detected": username_field_detected,
        "source_url": source_url,
        "evidence": evidence,
    }


def probe_web_admin(scheme: str, host: str | None) -> dict[str, Any]:
    """Probe a possible web admin surface on the gateway."""
    url = f"{scheme}://{host}" if host else f"{scheme}://"
    result = {
        "reachable": False,
        "url": url,
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
    }

    if not host:
        return result

    req = request.Request(
        url,
        headers={
            "User-Agent": "WIFITEST/1.0",
            "Accept-Encoding": "identity",
        },
        method="GET",
    )

    try:
        if scheme == "https":
            context = ssl._create_unverified_context()
            response = request.urlopen(req, timeout=3, context=context)
        else:
            response = request.urlopen(req, timeout=3)

        raw_body = response.read(65536)
        body = decode_response_body(
            raw_body,
            response.headers.get("Content-Encoding"),
            response.headers.get("Content-Type"),
        )
        text_preview = extract_visible_text_lines(body)
        result["reachable"] = True
        result["status_code"] = getattr(response, "status", None)
        result["final_url"] = response.geturl()
        result["title"] = extract_html_title(body) or infer_title_from_visible_text(text_preview)
        result["server"] = response.headers.get("Server")
        result["content_type"] = response.headers.get("Content-Type")
        result["text_preview"] = text_preview
        result["auth_detection"] = detect_admin_auth(
            body,
            response.headers,
            getattr(response, "status", None),
            response.geturl(),
        )
        return result
    except error.HTTPError as exc:
        raw_body = exc.read(65536)
        body = decode_response_body(
            raw_body,
            exc.headers.get("Content-Encoding"),
            exc.headers.get("Content-Type"),
        )
        text_preview = extract_visible_text_lines(body)
        result["reachable"] = True
        result["status_code"] = exc.code
        result["final_url"] = exc.geturl()
        result["title"] = extract_html_title(body) or infer_title_from_visible_text(text_preview)
        result["server"] = exc.headers.get("Server")
        result["content_type"] = exc.headers.get("Content-Type")
        result["text_preview"] = text_preview
        result["auth_detection"] = detect_admin_auth(
            body,
            exc.headers,
            exc.code,
            exc.geturl(),
        )
        return result
    except Exception:
        return result


def build_router_profile_confidence(
    gateway_ip: str | None,
    gateway_mac: str | None,
    gateway_vendor: str | None,
    icmp_reachable: bool | None,
    open_ports: list[int],
    web_admin: dict[str, Any],
) -> str:
    """Summarize how complete the discovered router profile is."""
    score = 0
    if gateway_ip:
        score += 1
    if gateway_mac:
        score += 1
    if gateway_vendor:
        score += 1
    if icmp_reachable:
        score += 1
    if open_ports:
        score += 1
    if web_admin["http"]["reachable"] or web_admin["https"]["reachable"]:
        score += 1

    if score >= 5:
        return "high"
    if score >= 3:
        return "medium"
    if score >= 1:
        return "low"
    return "none"


def build_raw_text(normalized: dict[str, Any], icmp_probe_text: str) -> str:
    """Build a compact human-readable summary for the router profile."""
    lines = [
        "Router discovery summary",
        f"Connected: {normalized['connected']}",
        f"Expected target match: {normalized['matches_expected_target']}",
        f"SSID: {normalized['active_ssid'] or '<none>'}",
        f"BSSID: {normalized['active_bssid'] or '<none>'}",
        f"Gateway IP: {normalized['gateway_ip'] or '<none>'}",
        f"Gateway MAC: {normalized['gateway_mac'] or '<none>'}",
        f"Gateway MAC source: {normalized['gateway_mac_source'] or '<unknown>'}",
        f"Gateway vendor: {normalized['gateway_vendor'] or '<unknown>'}",
        f"Open ports: {', '.join(str(port) for port in normalized['open_ports']) or '<none>'}",
        (
            "Web admin: "
            f"HTTP={normalized['web_admin']['http']['reachable']} ({normalized['web_admin']['http']['url']}) "
            f"HTTPS={normalized['web_admin']['https']['reachable']} ({normalized['web_admin']['https']['url']})"
        ),
        f"Confidence: {normalized['router_profile_confidence']}",
        "",
        "ICMP probe",
        icmp_probe_text or "<empty>",
    ]
    return "\n".join(lines)


def discover_gateway_and_router_profile_execute(input: dict[str, Any]) -> dict[str, Any]:
    """Identify the current gateway and a basic router profile for the connected target."""
    requested_interface = str(input["interface"])
    expected_ssid = str(input["expected_ssid"]).strip()

    interface_details = ensure_interface_mode(requested_interface, "managed")
    resolved_interface = interface_details["resolved_interface"]
    snapshot = get_managed_connection_snapshot(resolved_interface, expected_ssid)

    gateway_ip = snapshot["gateway"]
    gateway_mac, gateway_mac_source = get_gateway_mac(resolved_interface, gateway_ip)
    gateway_vendor, gateway_vendor_source = lookup_mac_vendor(gateway_mac)
    icmp_reachable, avg_latency_ms, icmp_probe_text = probe_icmp_latency(gateway_ip)
    open_ports = probe_open_tcp_ports(gateway_ip, COMMON_ROUTER_PORTS)
    web_admin = {
        "http": probe_web_admin("http", gateway_ip),
        "https": probe_web_admin("https", gateway_ip),
    }
    preferred_auth = (
        web_admin["https"]["auth_detection"]
        if web_admin["https"]["reachable"]
        else web_admin["http"]["auth_detection"]
    )

    normalized = {
        "interface": requested_interface,
        "resolved_interface": resolved_interface,
        "required_mode": "managed",
        "connected": snapshot["connected"],
        "matches_expected_target": snapshot["matches_expected_target"],
        "expected_ssid": snapshot["expected_ssid"],
        "active_ssid": snapshot["active_ssid"],
        "active_bssid": snapshot["active_bssid"],
        "gateway_ip": gateway_ip,
        "gateway_mac": gateway_mac,
        "gateway_mac_source": gateway_mac_source,
        "gateway_vendor": gateway_vendor,
        "gateway_vendor_source": gateway_vendor_source,
        "icmp_reachable": icmp_reachable,
        "avg_latency_ms": avg_latency_ms,
        "open_ports": open_ports,
        "dns_servers": get_dns_servers_for_interface(resolved_interface),
        "connection_profile": get_nmcli_connection_name(resolved_interface),
        "web_admin": web_admin,
        "admin_auth": preferred_auth,
        "router_profile_confidence": build_router_profile_confidence(
            gateway_ip,
            gateway_mac,
            gateway_vendor,
            icmp_reachable,
            open_ports,
            web_admin,
        ),
        "completed_at": utc_now_iso(),
    }

    return {
        "raw_text": build_raw_text(normalized, icmp_probe_text),
        "normalized": normalized,
    }
