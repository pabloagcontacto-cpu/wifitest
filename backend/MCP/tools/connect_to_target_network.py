"""Execution logic for connecting the local machine to a Wi-Fi target network."""

from __future__ import annotations

import shutil
from typing import Any

from tools.helpers import (
    ensure_interface_mode,
    get_managed_connection_snapshot,
    list_visible_wifi_ssids,
    reconnect_interface_with_networkmanager,
    rescan_wifi_networks,
    run_command,
    utc_now_iso,
)


def classify_connection_failure(error_text: str) -> tuple[str, str]:
    """Map common nmcli failures to a stable stage/reason pair."""
    normalized = error_text.lower()

    if "secrets were required" in normalized or "wrong password" in normalized:
        return ("authentication", "wrong_password")
    if "activation failed" in normalized or "association took too long" in normalized:
        return ("association", "association_failed")
    if (
        "no network with ssid" in normalized
        or "no se encontró una red con ssid" in normalized
        or "no se encontro una red con ssid" in normalized
        or "ssid_not_found" in normalized
    ):
        return ("association", "ssid_not_found")
    if "not found" in normalized and "device" in normalized:
        return ("interface_prepare", "interface_not_found")
    return ("status_check", "networkmanager_error")


def connect_to_target_network_execute(input: dict[str, Any]) -> dict[str, Any]:
    """Connect to the requested Wi-Fi network using NetworkManager."""
    requested_interface = str(input["interface"])
    requested_ssid = str(input["ssid"])
    password = str(input["password"])

    if shutil.which("nmcli") is None:
        raise RuntimeError(
            "The 'nmcli' binary is not available in PATH. "
            "Install and enable NetworkManager before using this tool."
        )

    interface_details = ensure_interface_mode(requested_interface, "managed")
    resolved_interface = interface_details["resolved_interface"]
    reconnect_interface_with_networkmanager(resolved_interface)
    rescan_output = rescan_wifi_networks(resolved_interface)
    visible_ssids = list_visible_wifi_ssids(resolved_interface)

    command = [
        "nmcli",
        "device",
        "wifi",
        "connect",
        requested_ssid,
        "ifname",
        resolved_interface,
    ]
    if password.strip() != "":
        command.extend(["password", password])

    connection_attempted = True
    raw_command_output = ""
    failure_stage = None
    failure_reason = None

    if requested_ssid not in visible_ssids:
        snapshot = get_managed_connection_snapshot(resolved_interface, requested_ssid)
        diagnostic = {
            "requested_ssid": requested_ssid,
            "visible_ssids": visible_ssids,
            "rescan_output": rescan_output or "<empty>",
        }
        return {
            "raw_text": (
                "Requested SSID not visible to NetworkManager after interface preparation.\n"
                f"{diagnostic}"
            ),
            "normalized": {
                "requested_ssid": requested_ssid,
                "interface": requested_interface,
                "resolved_interface": resolved_interface,
                "required_mode": "managed",
                "connection_attempted": False,
                "connected": False,
                "active_ssid": snapshot["active_ssid"],
                "active_bssid": snapshot["active_bssid"],
                "ipv4": snapshot["ipv4"],
                "gateway": snapshot["gateway"],
                "dns_servers": snapshot["dns_servers"],
                "connection_profile": snapshot["connection_profile"],
                "failure_stage": "association",
                "failure_reason": "ssid_not_found",
                "completed_at": utc_now_iso(),
            },
        }

    try:
        completed = run_command(command)
        raw_command_output = "\n".join(
            part
            for part in [
                rescan_output,
                completed.stdout.strip(),
                completed.stderr.strip(),
            ]
            if part
        )
    except Exception as exc:
        raw_command_output = "\n".join(part for part in [rescan_output, str(exc)] if part)
        failure_stage, failure_reason = classify_connection_failure(raw_command_output)
        snapshot = get_managed_connection_snapshot(resolved_interface, requested_ssid)

        return {
            "raw_text": raw_command_output,
            "normalized": {
                "requested_ssid": requested_ssid,
                "interface": requested_interface,
                "resolved_interface": resolved_interface,
                "required_mode": "managed",
                "connection_attempted": connection_attempted,
                "connected": False,
                "active_ssid": snapshot["active_ssid"],
                "active_bssid": snapshot["active_bssid"],
                "ipv4": snapshot["ipv4"],
                "gateway": snapshot["gateway"],
                "dns_servers": snapshot["dns_servers"],
                "connection_profile": snapshot["connection_profile"],
                "failure_stage": failure_stage,
                "failure_reason": failure_reason,
                "completed_at": utc_now_iso(),
            },
        }

    snapshot = get_managed_connection_snapshot(resolved_interface, requested_ssid)
    connected = bool(snapshot["connected"]) and bool(snapshot["matches_expected_target"])

    return {
        "raw_text": raw_command_output or f"Connection attempted for SSID '{requested_ssid}'.",
        "normalized": {
            "requested_ssid": requested_ssid,
            "interface": requested_interface,
            "resolved_interface": resolved_interface,
            "required_mode": "managed",
            "connection_attempted": connection_attempted,
            "connected": connected,
            "active_ssid": snapshot["active_ssid"],
            "active_bssid": snapshot["active_bssid"],
            "ipv4": snapshot["ipv4"],
            "gateway": snapshot["gateway"],
            "dns_servers": snapshot["dns_servers"],
            "connection_profile": snapshot["connection_profile"],
            "failure_stage": None if connected else "status_check",
            "failure_reason": None if connected else "unknown",
            "completed_at": utc_now_iso(),
        },
    }
