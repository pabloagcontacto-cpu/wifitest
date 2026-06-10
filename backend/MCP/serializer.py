"""Argument serializers for MCP tools."""

from __future__ import annotations

import os
import re
from typing import Any

from tool_contracts import get_tool_input_contract


def get_contract_default(arg_name: str, arg_contract: dict[str, Any]) -> Any:
    """Return the configured default for an argument."""
    if arg_name == "interface":
        configured_interface = os.getenv("WIFITEST_WIFI_INTERFACE", "").strip()
        if configured_interface != "":
            return configured_interface

    return arg_contract.get("default")


def normalize_arg_with_default(raw_value: Any, arg_name: str, arg_contract: dict[str, Any]) -> Any:
    """
    Aplica el valor por defecto de un argumento cuando el valor recibido viene
    ausente o vacio.

    Esta logica aplica tanto a argumentos `fixed` como `free`.
    """
    default_value = get_contract_default(arg_name, arg_contract)

    if raw_value is None:
        return default_value

    if isinstance(raw_value, str):
        stripped_value = raw_value.strip()
        if stripped_value == "":
            return default_value
        return stripped_value

    return raw_value


def validate_fixed_arg(
    tool_name: str,
    arg_name: str,
    normalized_value: Any,
    arg_contract: dict[str, Any],
) -> None:
    """
    Valida genericamente argumentos declarados como `fixed` en el contrato.
    """
    if arg_contract.get("mode") != "fixed":
        return

    allowed_values = [str(value) for value in arg_contract.get("allowed_values", [])]
    normalized_text = str(normalized_value)

    if normalized_text not in allowed_values:
        allowed_values_text = ", ".join(allowed_values)
        raise ValueError(
            f"Invalid value for '{arg_name}' in tool '{tool_name}'. "
            f"Allowed values are: {allowed_values_text}."
        )


def normalize_and_validate_contract_args(
    tool_name: str,
    raw_args: dict[str, Any],
) -> dict[str, Any]:
    """
    Recorre el contrato de entrada de una tool y aplica la logica comun:
    - usa el valor por defecto cuando el argumento viene vacio
    - valida genericamente los argumentos `fixed`

    Las validaciones especificas de argumentos `free` siguen perteneciendo al
    serializer de cada tool.
    """
    input_contract = get_tool_input_contract(tool_name)
    normalized_args: dict[str, Any] = {}

    for arg_name, arg_contract in input_contract.items():
        normalized_value = normalize_arg_with_default(
            raw_args.get(arg_name),
            arg_name,
            arg_contract,
        )
        validate_fixed_arg(tool_name, arg_name, normalized_value, arg_contract)
        normalized_args[arg_name] = normalized_value

    return normalized_args


def ping_serializer(raw_args: dict[str, Any]) -> dict[str, Any]:
    """Normalize the input for the ping job."""
    normalized_args = normalize_and_validate_contract_args("ping", raw_args)
    return normalized_args


def scan_wifi_networks_serializer(raw_args: dict[str, Any]) -> dict[str, Any]:
    """Normalize and validate the input for the Wi-Fi scan job."""
    normalized_args = normalize_and_validate_contract_args("scan_wifi_networks", raw_args)

    interface = str(normalized_args["interface"]).strip()
    if interface == "":
      raise ValueError("The 'interface' argument cannot be empty.")

    scan_seconds_text = str(normalized_args["scan_seconds"]).strip()
    try:
        scan_seconds_value = int(scan_seconds_text)
    except ValueError as exc:
        raise ValueError("The 'scan_seconds' argument must be a valid integer.") from exc

    if scan_seconds_value <= 0:
        raise ValueError("The 'scan_seconds' argument must be greater than 0.")

    if scan_seconds_value > 60:
        raise ValueError("The 'scan_seconds' argument must be 60 or lower.")

    normalized_args["interface"] = interface
    normalized_args["scan_seconds"] = str(scan_seconds_value)
    normalized_args["band"] = str(normalized_args["band"])
    normalized_args["include_hidden"] = str(normalized_args["include_hidden"])

    return normalized_args


def inspect_target_network_profile_serializer(raw_args: dict[str, Any]) -> dict[str, Any]:
    """Normalize and validate the input for the target network profile job."""
    normalized_args = normalize_and_validate_contract_args("inspect_target_network_profile", raw_args)

    interface = str(normalized_args["interface"]).strip()
    if interface == "":
        raise ValueError("The 'interface' argument cannot be empty.")

    target_ssid = str(normalized_args["target_ssid"]).strip()
    if target_ssid == "":
        raise ValueError("The 'target_ssid' argument cannot be empty.")

    scan_seconds_text = str(normalized_args["scan_seconds"]).strip()
    try:
        scan_seconds_value = int(scan_seconds_text)
    except ValueError as exc:
        raise ValueError("The 'scan_seconds' argument must be a valid integer.") from exc

    if scan_seconds_value <= 0:
        raise ValueError("The 'scan_seconds' argument must be greater than 0.")

    if scan_seconds_value > 120:
        raise ValueError("The 'scan_seconds' argument must be 120 or lower.")

    normalized_args["interface"] = interface
    normalized_args["target_ssid"] = target_ssid
    normalized_args["scan_seconds"] = str(scan_seconds_value)

    return normalized_args


def detect_wps_exposure_serializer(raw_args: dict[str, Any]) -> dict[str, Any]:
    """Normalize and validate the input for the WPS exposure detection job."""
    normalized_args = normalize_and_validate_contract_args("detect_wps_exposure", raw_args)

    interface = str(normalized_args["interface"]).strip()
    if interface == "":
        raise ValueError("The 'interface' argument cannot be empty.")

    target_bssids_text = str(normalized_args["target_bssids"]).strip().upper()
    target_bssid_candidates = [
        candidate.strip()
        for candidate in target_bssids_text.split(",")
        if candidate.strip() != ""
    ]

    if not target_bssid_candidates:
        raise ValueError("The 'target_bssids' argument must contain at least one MAC address.")

    mac_pattern = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
    for target_bssid in target_bssid_candidates:
        if not mac_pattern.match(target_bssid):
            raise ValueError("The 'target_bssids' argument must contain valid MAC addresses.")

    scan_seconds_text = str(normalized_args["scan_seconds"]).strip()
    try:
        scan_seconds_value = int(scan_seconds_text)
    except ValueError as exc:
        raise ValueError("The 'scan_seconds' argument must be a valid integer.") from exc

    if scan_seconds_value <= 0:
        raise ValueError("The 'scan_seconds' argument must be greater than 0.")

    if scan_seconds_value > 60:
        raise ValueError("The 'scan_seconds' argument must be 60 or lower.")

    normalized_args["interface"] = interface
    normalized_args["target_bssids"] = ",".join(target_bssid_candidates)
    normalized_args["scan_seconds"] = str(scan_seconds_value)

    return normalized_args


def detect_upnp_exposure_serializer(raw_args: dict[str, Any]) -> dict[str, Any]:
    """Normalize and validate the input for the UPnP exposure job."""
    normalized_args = normalize_and_validate_contract_args("detect_upnp_exposure", raw_args)

    interface = str(normalized_args["interface"]).strip()
    if interface == "":
        raise ValueError("The 'interface' argument cannot be empty.")

    gateway_ip = str(normalized_args["gateway_ip"]).strip()
    if gateway_ip != "":
        ip_pattern = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
        if not ip_pattern.match(gateway_ip):
            raise ValueError("The 'gateway_ip' argument must be a valid IPv4 address.")

    timeout_seconds_text = str(normalized_args["timeout_seconds"]).strip()
    try:
        timeout_seconds_value = int(timeout_seconds_text)
    except ValueError as exc:
        raise ValueError("The 'timeout_seconds' argument must be a valid integer.") from exc

    if timeout_seconds_value <= 0:
        raise ValueError("The 'timeout_seconds' argument must be greater than 0.")

    if timeout_seconds_value > 15:
        raise ValueError("The 'timeout_seconds' argument must be 15 or lower.")

    normalized_args["interface"] = interface
    normalized_args["gateway_ip"] = gateway_ip
    normalized_args["timeout_seconds"] = str(timeout_seconds_value)
    return normalized_args


def detect_management_services_serializer(raw_args: dict[str, Any]) -> dict[str, Any]:
    """Normalize and validate the input for the management services job."""
    normalized_args = normalize_and_validate_contract_args("detect_management_services", raw_args)

    interface = str(normalized_args["interface"]).strip()
    if interface == "":
        raise ValueError("The 'interface' argument cannot be empty.")

    gateway_ip = str(normalized_args["gateway_ip"]).strip()
    if gateway_ip != "":
        ip_pattern = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
        if not ip_pattern.match(gateway_ip):
            raise ValueError("The 'gateway_ip' argument must be a valid IPv4 address.")

    timeout_seconds_text = str(normalized_args["timeout_seconds"]).strip()
    try:
        timeout_seconds_value = int(timeout_seconds_text)
    except ValueError as exc:
        raise ValueError("The 'timeout_seconds' argument must be a valid integer.") from exc

    if timeout_seconds_value <= 0:
        raise ValueError("The 'timeout_seconds' argument must be greater than 0.")

    if timeout_seconds_value > 10:
        raise ValueError("The 'timeout_seconds' argument must be 10 or lower.")

    normalized_args["interface"] = interface
    normalized_args["gateway_ip"] = gateway_ip
    normalized_args["timeout_seconds"] = str(timeout_seconds_value)
    return normalized_args


def connect_to_target_network_serializer(raw_args: dict[str, Any]) -> dict[str, Any]:
    """Normalize and validate the input for the Wi-Fi connection job."""
    normalized_args = normalize_and_validate_contract_args("connect_to_target_network", raw_args)

    interface = str(normalized_args["interface"]).strip()
    if interface == "":
        raise ValueError("The 'interface' argument cannot be empty.")

    ssid = str(normalized_args["ssid"]).strip()
    if ssid == "":
        raise ValueError("The 'ssid' argument cannot be empty.")

    normalized_args["interface"] = interface
    normalized_args["ssid"] = ssid
    normalized_args["password"] = str(normalized_args["password"])

    return normalized_args


def get_connection_status_serializer(raw_args: dict[str, Any]) -> dict[str, Any]:
    """Normalize and validate the input for the connection status job."""
    normalized_args = normalize_and_validate_contract_args("get_connection_status", raw_args)

    interface = str(normalized_args["interface"]).strip()
    if interface == "":
        raise ValueError("The 'interface' argument cannot be empty.")

    normalized_args["interface"] = interface
    normalized_args["expected_ssid"] = str(normalized_args["expected_ssid"]).strip()

    return normalized_args


def disconnect_from_network_serializer(raw_args: dict[str, Any]) -> dict[str, Any]:
    """Normalize and validate the input for the disconnect job."""
    normalized_args = normalize_and_validate_contract_args("disconnect_from_network", raw_args)

    interface = str(normalized_args["interface"]).strip()
    if interface == "":
        raise ValueError("The 'interface' argument cannot be empty.")

    normalized_args["interface"] = interface
    return normalized_args


def discover_gateway_and_router_profile_serializer(raw_args: dict[str, Any]) -> dict[str, Any]:
    """Normalize and validate the input for the router discovery job."""
    normalized_args = normalize_and_validate_contract_args(
        "discover_gateway_and_router_profile",
        raw_args,
    )

    interface = str(normalized_args["interface"]).strip()
    if interface == "":
        raise ValueError("The 'interface' argument cannot be empty.")

    normalized_args["interface"] = interface
    normalized_args["expected_ssid"] = str(normalized_args["expected_ssid"]).strip()
    return normalized_args


def serializer(tool_name: str, raw_args: dict[str, Any]) -> dict[str, Any]:
    """Dispatch to the tool-specific serializer following the naming convention."""
    serializer_name = f"{tool_name}_serializer"
    serializer_fn = globals().get(serializer_name)
    if serializer_fn is None or not callable(serializer_fn):
        raise ValueError(f"No serializer registered for tool '{tool_name}'.")

    return serializer_fn(raw_args)
