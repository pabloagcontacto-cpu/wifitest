"""Helpers shared by tool execution modules."""

from __future__ import annotations

import re
import shutil
import subprocess
import time
from datetime import UTC, datetime
from typing import Any


def utc_now_iso() -> str:
    """Return a UTC timestamp in ISO 8601 format."""
    return datetime.now(UTC).isoformat()


def run_command(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run a command and return the completed process with text output."""
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )
    if check and completed.returncode != 0:
        stderr = completed.stderr.strip() or "<empty>"
        stdout = completed.stdout.strip() or "<empty>"
        raise RuntimeError(
            f"Command failed: {' '.join(command)} | returncode={completed.returncode} | "
            f"stderr={stderr} | stdout={stdout}"
        )
    return completed


def normalize_base_interface_name(interface: str) -> str:
    """Normalize a preferred interface name to its logical base name."""
    normalized = interface.strip()
    if normalized.endswith("mon") and len(normalized) > 3:
        return normalized[:-3]
    return normalized


def normalize_interface_mode(mode: str) -> str:
    """Normalize the different Linux names used for interface modes."""
    normalized = mode.strip().lower()
    if normalized in {"managed", "station"}:
        return "managed"
    if normalized == "monitor":
        return "monitor"
    return normalized


def parse_iw_dev_output(raw_text: str) -> list[dict[str, str | None]]:
    """Parse `iw dev` output into a list of interfaces with name/type/phy."""
    interfaces: list[dict[str, str | None]] = []
    current_phy: str | None = None
    current_interface: dict[str, str | None] | None = None

    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if line == "":
            continue

        phy_match = re.match(r"^phy#(\d+)$", line)
        if phy_match:
            current_phy = f"phy#{phy_match.group(1)}"
            continue

        interface_match = re.match(r"^Interface\s+(.+)$", line)
        if interface_match:
            current_interface = {
                "name": interface_match.group(1).strip(),
                "mode": None,
                "phy": current_phy,
            }
            interfaces.append(current_interface)
            continue

        type_match = re.match(r"^type\s+(.+)$", line)
        if type_match and current_interface is not None:
            current_interface["mode"] = normalize_interface_mode(type_match.group(1))

    return interfaces


def get_wireless_interfaces() -> list[dict[str, str | None]]:
    """Return the wireless interfaces currently known by `iw`."""
    completed = run_command(["iw", "dev"])
    return parse_iw_dev_output(completed.stdout)


def get_interface_details(interface: str) -> dict[str, str | None] | None:
    """Return the details for one wireless interface when available."""
    for details in get_wireless_interfaces():
        if details.get("name") == interface:
            return details
    return None


def build_interface_candidates(base_interface: str, preferred_mode: str | None = None) -> list[str]:
    """Build likely concrete interface names from the logical base interface."""
    normalized_base = normalize_base_interface_name(base_interface)
    monitor_alias = f"{normalized_base}mon"

    if preferred_mode == "monitor":
        candidates = [monitor_alias, normalized_base]
    else:
        candidates = [normalized_base]
        if not normalized_base.endswith("mon"):
            candidates.append(monitor_alias)
    return candidates


def resolve_existing_interface(
    base_interface: str,
    preferred_mode: str | None = None,
) -> dict[str, str | None] | None:
    """Find the best existing wireless interface for a logical base name."""
    interfaces = get_wireless_interfaces()
    candidates = build_interface_candidates(base_interface, preferred_mode)

    for candidate_name in candidates:
        for details in interfaces:
            if details.get("name") == candidate_name:
                return details

    normalized_base = normalize_base_interface_name(base_interface)
    for details in interfaces:
        name = str(details.get("name") or "")
        if name == normalized_base or name.startswith(normalized_base):
            return details

    return None


def set_interface_mode(interface: str, target_mode: str) -> None:
    """Switch a wireless interface to monitor or managed mode in-place."""
    if target_mode not in {"monitor", "managed"}:
        raise ValueError(f"Unsupported interface mode '{target_mode}'.")

    iw_mode = "monitor" if target_mode == "monitor" else "managed"

    run_command(["ip", "link", "set", interface, "down"])
    try:
        run_command(["iw", "dev", interface, "set", "type", iw_mode])
    finally:
        run_command(["ip", "link", "set", interface, "up"], check=False)


def bounce_interface(interface: str, settle_seconds: float = 1.0) -> None:
    """Bring an interface down and up to stabilize its runtime state."""
    run_command(["ip", "link", "set", interface, "down"], check=False)
    run_command(["ip", "link", "set", interface, "up"], check=False)
    if settle_seconds > 0:
        time.sleep(settle_seconds)


def release_interface_from_networkmanager(interface: str) -> None:
    """Disconnect one interface and ask NetworkManager to stop managing it."""
    run_command(["nmcli", "device", "disconnect", interface], check=False)
    run_command(["nmcli", "device", "set", interface, "managed", "no"], check=False)


def try_switch_with_airmon(base_interface: str, target_mode: str) -> dict[str, str] | None:
    """
    Try to switch interface mode using airmon-ng when available.

    This tends to be more reliable than plain `iw set type monitor` for some
    Realtek drivers and chipsets.
    """
    if shutil.which("airmon-ng") is None:
        return None

    normalized_base = normalize_base_interface_name(base_interface)

    if target_mode == "monitor":
        run_command(["airmon-ng", "check", "kill"], check=False)
        run_command(["airmon-ng", "start", normalized_base], check=False)
        time.sleep(2)

        details = resolve_existing_interface(normalized_base, preferred_mode="monitor")
        if details and normalize_interface_mode(str(details.get("mode") or "")) == "monitor":
            bounce_interface(str(details.get("name")), settle_seconds=1.0)
            return {
                "requested_interface": normalized_base,
                "resolved_interface": str(details.get("name")),
                "mode": "monitor",
            }
        return None

    monitor_details = resolve_existing_interface(normalized_base, preferred_mode="monitor")
    monitor_name = None
    if monitor_details and normalize_interface_mode(str(monitor_details.get("mode") or "")) == "monitor":
        monitor_name = str(monitor_details.get("name"))

    run_command(["airmon-ng", "stop", monitor_name or normalized_base], check=False)
    time.sleep(2)
    ensure_networkmanager_manages_interface(normalized_base)

    details = resolve_existing_interface(normalized_base, preferred_mode="managed")
    if details and normalize_interface_mode(str(details.get("mode") or "")) == "managed":
        bounce_interface(str(details.get("name")), settle_seconds=1.0)
        return {
            "requested_interface": normalized_base,
            "resolved_interface": str(details.get("name")),
            "mode": "managed",
        }
    return None


def ensure_interface_mode(base_interface: str, target_mode: str) -> dict[str, str]:
    """
    Ensure that the preferred interface is available in the required mode.

    The frontend can always refer to the logical base interface (for example
    `wlan0`). This helper resolves the real interface present in the system,
    switches it in-place when needed and returns the concrete interface used.
    """
    normalized_base = normalize_base_interface_name(base_interface)

    airmon_result = try_switch_with_airmon(normalized_base, target_mode)
    if airmon_result is not None:
        return airmon_result

    details = resolve_existing_interface(normalized_base, preferred_mode=target_mode)
    if details is None:
        raise RuntimeError(
            f"No wireless interface matching '{normalized_base}' was found."
        )

    interface_name = str(details.get("name"))
    current_mode = normalize_interface_mode(str(details.get("mode") or "unknown"))

    if target_mode == "monitor":
        release_interface_from_networkmanager(interface_name)
    else:
        ensure_networkmanager_manages_interface(interface_name)

    if current_mode != target_mode:
        set_interface_mode(interface_name, target_mode)
        time.sleep(1)
        refreshed_details = get_interface_details(interface_name)
        refreshed_mode = normalize_interface_mode(
            str(refreshed_details.get("mode") if refreshed_details else target_mode)
        )
        if refreshed_mode != target_mode:
            raise RuntimeError(
                f"Could not switch interface '{interface_name}' to mode '{target_mode}'."
            )
        current_mode = refreshed_mode

    bounce_interface(interface_name, settle_seconds=1.0)

    if target_mode == "managed":
        ensure_networkmanager_manages_interface(interface_name)

    return {
        "requested_interface": normalized_base,
        "resolved_interface": interface_name,
        "mode": current_mode,
    }


def parse_iw_link_output(raw_text: str) -> dict[str, Any]:
    """Parse `iw dev <iface> link` output into a small structured snapshot."""
    normalized = raw_text.strip()
    if normalized == "" or "Not connected." in normalized:
        return {
            "connected": False,
            "active_ssid": None,
            "active_bssid": None,
        }

    bssid_match = re.search(r"Connected to\s+([0-9A-Fa-f:]{17})", normalized)
    ssid_match = re.search(r"\n\s*SSID:\s+(.+)", normalized)

    return {
        "connected": bssid_match is not None,
        "active_ssid": ssid_match.group(1).strip() if ssid_match else None,
        "active_bssid": bssid_match.group(1).upper() if bssid_match else None,
    }


def get_ipv4_address(interface: str) -> str | None:
    """Return the primary IPv4 address assigned to one interface."""
    completed = run_command(["ip", "-4", "addr", "show", "dev", interface], check=False)
    match = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", completed.stdout)
    return match.group(1) if match else None


def get_gateway_for_interface(interface: str) -> str | None:
    """Return the IPv4 gateway used by one interface when available."""
    completed = run_command(["ip", "route", "show", "default", "dev", interface], check=False)
    match = re.search(r"default via\s+(\d+\.\d+\.\d+\.\d+)", completed.stdout)
    return match.group(1) if match else None


def get_dns_servers_for_interface(interface: str) -> list[str]:
    """Return the IPv4 DNS servers reported by NetworkManager for one device."""
    completed = run_command(["nmcli", "-g", "IP4.DNS", "device", "show", interface], check=False)
    return [line.strip() for line in completed.stdout.splitlines() if line.strip() != ""]


def get_nmcli_connection_name(interface: str) -> str | None:
    """Return the NetworkManager connection profile name for one interface."""
    completed = run_command(
        ["nmcli", "-t", "-f", "GENERAL.CONNECTION", "device", "show", interface],
        check=False,
    )
    value = completed.stdout.strip()
    if value == "" or value.endswith(":--"):
        return None
    if ":" in value:
        return value.split(":", 1)[1].strip() or None
    return value or None


def ensure_networkmanager_manages_interface(interface: str) -> None:
    """Ensure NetworkManager is running and owns the interface, without reconnecting it."""
    run_command(["systemctl", "start", "NetworkManager"], check=False)
    run_command(["nmcli", "device", "set", interface, "managed", "yes"], check=False)


def reconnect_interface_with_networkmanager(interface: str) -> None:
    """Ask NetworkManager to actively reconnect one managed interface."""
    ensure_networkmanager_manages_interface(interface)
    run_command(["nmcli", "device", "connect", interface], check=False)


def rescan_wifi_networks(interface: str, settle_seconds: float = 3.0) -> str:
    """Trigger a Wi-Fi rescan through NetworkManager and wait briefly."""
    completed = run_command(["nmcli", "device", "wifi", "rescan", "ifname", interface], check=False)
    if settle_seconds > 0:
        time.sleep(settle_seconds)
    return "\n".join(
        part for part in [completed.stdout.strip(), completed.stderr.strip()] if part
    )


def list_visible_wifi_ssids(interface: str) -> list[str]:
    """Return the SSIDs currently visible to NetworkManager on one interface."""
    completed = run_command(
        ["nmcli", "-t", "-f", "SSID", "device", "wifi", "list", "ifname", interface],
        check=False,
    )
    return [line.strip() for line in completed.stdout.splitlines() if line.strip() != ""]


def get_managed_connection_snapshot(interface: str, expected_ssid: str | None = None) -> dict[str, Any]:
    """Read the current managed connection state for one wireless interface."""
    link_output = run_command(["iw", "dev", interface, "link"], check=False).stdout
    parsed_link = parse_iw_link_output(link_output)
    ipv4 = get_ipv4_address(interface)
    gateway = get_gateway_for_interface(interface)
    dns_servers = get_dns_servers_for_interface(interface)
    connection_profile = get_nmcli_connection_name(interface)
    active_ssid = parsed_link["active_ssid"]

    expected_normalized = (expected_ssid or "").strip()
    matches_expected_target = bool(
        expected_normalized and active_ssid and active_ssid == expected_normalized
    )

    return {
        "connected": bool(parsed_link["connected"]),
        "active_ssid": active_ssid,
        "active_bssid": parsed_link["active_bssid"],
        "matches_expected_target": matches_expected_target,
        "expected_ssid": expected_normalized or None,
        "ipv4": ipv4,
        "gateway": gateway,
        "dns_servers": dns_servers,
        "connection_profile": connection_profile,
    }


def capture_managed_restore_context(base_interface: str) -> dict[str, Any]:
    """
    Capture the current managed-mode connection state before switching to monitor.

    This allows monitor-mode tools to restore the interface mode afterwards and,
    when appropriate, ask NetworkManager to reconnect the previous Wi-Fi link.
    """
    details = resolve_existing_interface(base_interface, preferred_mode="managed")
    if details is None:
        return {
            "resolved_interface": None,
            "was_connected": False,
            "active_ssid": None,
            "connection_profile": None,
        }

    resolved_interface = str(details.get("name"))
    snapshot = get_managed_connection_snapshot(resolved_interface)
    return {
        "resolved_interface": resolved_interface,
        "was_connected": bool(snapshot["connected"]),
        "active_ssid": snapshot["active_ssid"],
        "connection_profile": snapshot["connection_profile"],
    }


def restore_managed_connection(base_interface: str, restore_context: dict[str, Any] | None = None) -> dict[str, str]:
    """
    Restore one logical interface to managed mode and reconnect if it was connected before.
    """
    interface_details = ensure_interface_mode(base_interface, "managed")
    resolved_interface = interface_details["resolved_interface"]

    was_connected = bool((restore_context or {}).get("was_connected"))
    if was_connected:
        reconnect_interface_with_networkmanager(resolved_interface)
        time.sleep(2)

    return interface_details
