"""Execution logic for disconnecting the local machine from the current Wi-Fi network."""

from __future__ import annotations

import shutil
from typing import Any

from tools.helpers import (
    ensure_interface_mode,
    ensure_networkmanager_manages_interface,
    get_managed_connection_snapshot,
    run_command,
    utc_now_iso,
)


def disconnect_from_network_execute(input: dict[str, Any]) -> dict[str, Any]:
    """Disconnect one managed wireless interface through NetworkManager."""
    requested_interface = str(input["interface"])

    if shutil.which("nmcli") is None:
        raise RuntimeError(
            "The 'nmcli' binary is not available in PATH. "
            "Install and enable NetworkManager before using this tool."
        )

    interface_details = ensure_interface_mode(requested_interface, "managed")
    resolved_interface = interface_details["resolved_interface"]
    ensure_networkmanager_manages_interface(resolved_interface)

    completed = run_command(["nmcli", "device", "down", resolved_interface], check=False)

    raw_text = "\n".join(
        part for part in [completed.stdout.strip(), completed.stderr.strip()] if part
    ) or f"Disconnect attempted for interface '{resolved_interface}'."

    snapshot = get_managed_connection_snapshot(resolved_interface)
    disconnected = not bool(snapshot["connected"])

    return {
        "raw_text": raw_text,
        "normalized": {
            "interface": requested_interface,
            "resolved_interface": resolved_interface,
            "required_mode": "managed",
            "disconnect_attempted": True,
            "disconnected": disconnected,
            "active_ssid": snapshot["active_ssid"],
            "active_bssid": snapshot["active_bssid"],
            "ipv4": snapshot["ipv4"],
            "gateway": snapshot["gateway"],
            "dns_servers": snapshot["dns_servers"],
            "connection_profile": snapshot["connection_profile"],
            "completed_at": utc_now_iso(),
        },
    }
