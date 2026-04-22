"""Helpers para cargar y consultar el contrato compartido de tools."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TOOLS_CONTRACT_PATH = PROJECT_ROOT / "contracts" / "tools.json"


@lru_cache(maxsize=1)
def load_tools_contract() -> dict[str, Any]:
    """Carga y cachea el fichero compartido con el contrato de tools."""
    with TOOLS_CONTRACT_PATH.open("r", encoding="utf-8") as contract_file:
        return json.load(contract_file)


def get_tool_contract(tool_name: str) -> dict[str, Any]:
    """Devuelve el contrato definido para una tool concreta."""
    contract = load_tools_contract()
    tools = contract.get("tools", {})
    tool_contract = tools.get(tool_name)
    if tool_contract is None:
        raise ValueError(f"No contract registered for tool '{tool_name}'.")
    return tool_contract


def get_input_arg_contract(tool_name: str, arg_name: str) -> dict[str, Any]:
    """Devuelve el contrato de un argumento de entrada concreto."""
    tool_contract = get_tool_contract(tool_name)
    input_contract = tool_contract.get("input", {})
    arg_contract = input_contract.get(arg_name)
    if arg_contract is None:
        raise ValueError(
            f"No input contract registered for argument '{arg_name}' in tool '{tool_name}'."
        )
    return arg_contract


def get_tool_input_contract(tool_name: str) -> dict[str, Any]:
    """Devuelve el contrato completo de entrada de una tool."""
    tool_contract = get_tool_contract(tool_name)
    input_contract = tool_contract.get("input", {})
    if not isinstance(input_contract, dict):
        raise ValueError(f"Invalid input contract for tool '{tool_name}'.")
    return input_contract
