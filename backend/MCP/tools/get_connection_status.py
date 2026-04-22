"""Execution logic for reading the current managed Wi-Fi connection state."""

from __future__ import annotations

import json
import shutil
from typing import Any

from tools.helpers import ensure_interface_mode, get_managed_connection_snapshot, utc_now_iso


def get_connection_status_execute(input: dict[str, Any]) -> dict[str, Any]:
    """Check the current connection state for the requested wireless interface."""
    requested_interface = str(input["interface"])
    expected_ssid = str(input["expected_ssid"]).strip()

    if shutil.which("nmcli") is None:
        raise RuntimeError(
            "The 'nmcli' binary is not available in PATH. "
            "Install and enable NetworkManager before using this tool."
        )

    interface_details = ensure_interface_mode(requested_interface, "managed")
    resolved_interface = interface_details["resolved_interface"]
    snapshot = get_managed_connection_snapshot(resolved_interface, expected_ssid)

    normalized = {
        "interface": requested_interface,
        "resolved_interface": resolved_interface,
        "required_mode": "managed",
        "connected": snapshot["connected"],
        "active_ssid": snapshot["active_ssid"],
        "active_bssid": snapshot["active_bssid"],
        "matches_expected_target": snapshot["matches_expected_target"],
        "expected_ssid": snapshot["expected_ssid"],
        "ipv4": snapshot["ipv4"],
        "gateway": snapshot["gateway"],
        "dns_servers": snapshot["dns_servers"],
        "connection_profile": snapshot["connection_profile"],
        "completed_at": utc_now_iso(),
    }

    return {
        "raw_text": json.dumps(normalized, ensure_ascii=True, indent=2),
        "normalized": normalized,
    }
