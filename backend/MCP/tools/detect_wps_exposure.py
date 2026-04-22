"""Execution logic for detecting WPS exposure on a target Wi-Fi network."""

from __future__ import annotations

import re
import shutil
import signal
import subprocess
from typing import Any

from tools.helpers import ensure_interface_mode, utc_now_iso


def parse_bool_from_lock_value(value: str) -> bool | None:
    """Normalize wash lock values to booleans when possible."""
    normalized_value = value.strip().lower()

    if normalized_value in {"yes", "true", "1"}:
        return True
    if normalized_value in {"no", "false", "0"}:
        return False
    return None


def parse_int_or_none(value: str) -> int | None:
    """Parse a numeric string when possible."""
    try:
        return int(value.strip())
    except ValueError:
        return None


def stop_process_group(process: subprocess.Popen[str]) -> None:
    """Stop wash cleanly and escalate only when needed."""
    if process.poll() is not None:
        return

    try:
        process.send_signal(signal.SIGINT)
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            process.terminate()
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def parse_wash_output(raw_text: str, target_bssids: list[str]) -> dict[str, Any]:
    """Parse wash output and extract the first row matching any target BSSID."""
    target_bssid_set = {bssid.upper() for bssid in target_bssids}
    header_seen = False

    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if line.startswith("BSSID"):
            header_seen = True
            continue

        if not header_seen:
            continue

        if not re.match(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", line):
            continue

        parts = re.split(r"\s{2,}", line)
        if len(parts) < 5:
            continue

        bssid = parts[0].strip().upper()
        if bssid not in target_bssid_set:
            continue

        channel = parse_int_or_none(parts[1]) if len(parts) > 1 else None
        signal = parse_int_or_none(parts[2]) if len(parts) > 2 else None
        wps_version = parts[3].strip() if len(parts) > 3 and parts[3].strip() else None
        locked_value = parts[4].strip() if len(parts) > 4 else ""
        vendor = parts[5].strip() if len(parts) > 5 and parts[5].strip() else None
        essid = parts[6].strip() if len(parts) > 6 and parts[6].strip() else None

        return {
            "target_bssids": sorted(target_bssid_set),
            "matched_bssid": bssid,
            "target_ssid": essid,
            "channel": channel,
            "signal": signal,
            "wps_detected": True,
            "wps_version": wps_version,
            "wps_locked": parse_bool_from_lock_value(locked_value),
            "vendor": vendor,
            "confidence": "high",
            "evidence": [f"WPS row detected in wash output for {bssid}."],
        }

    return {
        "target_bssids": sorted(target_bssid_set),
        "matched_bssid": None,
        "target_ssid": None,
        "channel": None,
        "signal": None,
        "wps_detected": False,
        "wps_version": None,
        "wps_locked": None,
        "vendor": None,
        "confidence": "low",
        "evidence": [
            "No WPS evidence detected for any of the candidate BSSIDs in wash output."
        ],
    }


def detect_wps_exposure_execute(input: dict[str, Any]) -> dict[str, Any]:
    """Execute wash for a few seconds and inspect whether the target BSSID exposes WPS."""
    requested_interface = str(input["interface"])
    target_bssids = [
        candidate.strip().upper()
        for candidate in str(input["target_bssids"]).split(",")
        if candidate.strip() != ""
    ]
    scan_seconds = int(str(input["scan_seconds"]))

    if shutil.which("wash") is None:
        raise RuntimeError(
            "The 'wash' binary is not available in PATH. "
            "Install reaver-wps-fork-t6x or an equivalent package before using this tool."
        )

    interface_details = ensure_interface_mode(requested_interface, "monitor")
    interface = interface_details["resolved_interface"]

    command = ["wash", "-i", interface]
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
        stop_process_group(process)
        stdout_text, stderr_text = process.communicate()

    raw_text = "\n".join(filter(None, [stdout_text.strip(), stderr_text.strip()]))

    if process.returncode not in {0, None} and stdout_text.strip() == "":
        raise RuntimeError(
            "wash did not complete successfully. "
            f"Command: {' '.join(command)} | returncode={process.returncode} | "
            f"stderr={stderr_text.strip() or '<empty>'}"
        )

    parsed_output = parse_wash_output(stdout_text, target_bssids)
    parsed_output["interface"] = interface
    parsed_output["requested_interface"] = requested_interface
    parsed_output["required_mode"] = "monitor"
    parsed_output["scan_seconds"] = scan_seconds
    parsed_output["completed_at"] = utc_now_iso()

    return {
        "raw_text": raw_text,
        "normalized": parsed_output,
    }
