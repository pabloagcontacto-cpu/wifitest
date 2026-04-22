"""Execution logic for enriching the profile of a target Wi-Fi network by SSID."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from tools.helpers import ensure_interface_mode, utc_now_iso
from tools.scan_wifi_networks import (
    AIRODUMP_CSV_SUFFIX,
    build_airodump_command,
    parse_airodump_csv,
    stop_capture_process,
)


def inspect_target_network_profile_execute(input: dict[str, Any]) -> dict[str, Any]:
    """Run a longer targeted scan and aggregate all observed radios for one SSID."""
    requested_interface = str(input["interface"])
    target_ssid = str(input["target_ssid"])
    scan_seconds = int(str(input["scan_seconds"]))

    if shutil.which("airodump-ng") is None:
        raise RuntimeError(
            "The 'airodump-ng' binary is not available in PATH. "
            "Install aircrack-ng before using this tool."
        )

    interface_details = ensure_interface_mode(requested_interface, "monitor")
    interface = interface_details["resolved_interface"]

    with tempfile.TemporaryDirectory(prefix="wifitest_profile_") as temp_dir:
        output_prefix = Path(temp_dir) / "profile"
        csv_path = Path(f"{output_prefix}{AIRODUMP_CSV_SUFFIX}")
        command = build_airodump_command(interface, "all", output_prefix)

        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )

        stdout_text = ""
        stderr_text = ""

        try:
            stdout_text, stderr_text = process.communicate(timeout=scan_seconds)
        except subprocess.TimeoutExpired:
            stop_capture_process(process)
            stdout_text, stderr_text = process.communicate()

        if not csv_path.exists():
            raise RuntimeError(
                "airodump-ng did not generate the expected CSV output file while profiling the target network. "
                f"Command: {' '.join(command)} | returncode={process.returncode} | "
                f"stderr={stderr_text.strip() or '<empty>'}"
            )

        raw_csv = csv_path.read_text(encoding="utf-8")
        networks, _clients = parse_airodump_csv(csv_path, include_hidden=True)

    target_networks = [
        network
        for network in networks
        if str(network.get("ssid", "")) == target_ssid
    ]

    known_bssids = sorted(
        {
            str(network.get("bssid"))
            for network in target_networks
            if network.get("bssid")
        }
    )
    bands_seen = sorted(
        {
            str(network.get("frequency_band"))
            for network in target_networks
            if network.get("frequency_band")
        }
    )
    channels_seen = sorted(
        {
            int(network.get("channel"))
            for network in target_networks
            if network.get("channel") is not None
        }
    )

    valid_signals = [
        int(network["signal"])
        for network in target_networks
        if isinstance(network.get("signal"), int) and int(network["signal"]) != -1
    ]
    best_signal = max(valid_signals) if valid_signals else None

    if len(target_networks) >= 2:
        profile_confidence = "high"
    elif len(target_networks) == 1:
        profile_confidence = "medium"
    else:
        profile_confidence = "low"

    return {
        "raw_text": raw_csv,
        "normalized": {
            "interface": interface,
            "requested_interface": requested_interface,
            "required_mode": "monitor",
            "target_ssid": target_ssid,
            "scan_seconds": scan_seconds,
            "target_present": len(target_networks) > 0,
            "known_bssids": known_bssids,
            "networks": target_networks,
            "bands_seen": bands_seen,
            "channels_seen": channels_seen,
            "best_signal": best_signal,
            "profile_confidence": profile_confidence,
            "completed_at": utc_now_iso(),
        },
    }
