"""Vendored BaseTool from Vibe-Trading (src/agent/tools.py) — class contract only.

The vendored *_tool.py modules subclass this; `coworker.tools.trading` adapts instances
into plain callables for the coworker ToolRegistry. The Vibe-Trading ToolRegistry is NOT
vendored: coworker's registry + PermissionEngine own registration and authorization.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict


class BaseTool(ABC):
    """Tool base class (vendored, API-compatible with Vibe-Trading src.agent.tools).

    Attributes:
        name: Unique tool identifier.
        description: Tool description shown to the LLM.
        parameters: Parameter definition in JSON Schema format.
        repeatable: Whether the tool may be called more than once.
        is_readonly: Whether the tool is side-effect free.
        side_effecting: Conservative gateway classification (see upstream docstring).
    """

    name: str = ""
    description: str = ""
    parameters: Dict[str, Any] = {}
    repeatable: bool = False
    is_readonly: bool = True
    side_effecting: bool = True

    @classmethod
    def check_available(cls) -> bool:
        """Check if this tool's dependencies are met (API keys, packages). Tools that
        return False are excluded from the registry."""
        return True

    @abstractmethod
    def execute(self, **kwargs: Any) -> str:
        """Execute the tool and return a JSON string."""

    def to_openai_schema(self) -> Dict[str, Any]:
        """Convert to OpenAI function calling format."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters
                or {"type": "object", "properties": {}, "required": []},
            },
        }


def tool_classes(module) -> list[type[BaseTool]]:
    """Concrete BaseTool subclasses defined in a vendored tool module."""
    out = []
    for attr in vars(module).values():
        if (
            isinstance(attr, type)
            and issubclass(attr, BaseTool)
            and attr is not BaseTool
            and attr.__module__ == module.__name__
            and attr.name
        ):
            out.append(attr)
    return out
