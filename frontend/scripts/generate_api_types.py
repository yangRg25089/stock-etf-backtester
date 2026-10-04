#!/usr/bin/env python3
"""Generate frontend aliases from FastAPI's served OpenAPI schema."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"
OUTPUT = FRONTEND / "src" / "api" / "generated.ts"
SCHEMA_OUTPUT = FRONTEND / "src" / "api" / "generated.schema.json"
EXPORT_OUTPUT = FRONTEND / "src" / "api" / "generated.exports.json"


def _python_candidates() -> list[str]:
    candidates: list[str] = []
    override = os.environ.get("BACKEND_PYTHON")
    if override:
        candidates.append(override)
    if os.name == "nt":
        candidates.append(str(ROOT / "backend" / ".venv" / "Scripts" / "python.exe"))
    else:
        candidates.append(str(ROOT / "backend" / ".venv" / "bin" / "python"))
    candidates.append(sys.executable)
    for name in ("python3", "python"):
        executable = shutil.which(name)
        if executable:
            candidates.append(executable)
    return list(dict.fromkeys(candidates))


def _load_schemas() -> dict[str, Any]:
    program = (
        "import json; from app.main import app; "
        "from app.export.csv import csv_field_groups; "
        "print(json.dumps({'schemas': app.openapi()['components']['schemas'], "
        "'csvFields': csv_field_groups()}))"
    )
    env = os.environ.copy()
    backend_path = str(ROOT / "backend")
    env["PYTHONPATH"] = os.pathsep.join(
        part for part in (backend_path, env.get("PYTHONPATH", "")) if part
    )
    errors: list[str] = []
    for executable in _python_candidates():
        result = subprocess.run(
            [executable, "-c", program],
            cwd=ROOT / "backend",
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            generated = json.loads(result.stdout)
            openapi_schemas = generated["schemas"]
            if not isinstance(openapi_schemas, dict):
                raise RuntimeError("OpenAPI components.schemas is not an object")
            EXPORT_OUTPUT.write_text(json.dumps(generated["csvFields"], indent=2) + "\n", encoding="utf-8")
            return openapi_schemas
        errors.append(f"{executable}: {result.stderr.strip().splitlines()[-1:]}")
    raise RuntimeError(
        "Could not import the backend OpenAPI app. Install backend dependencies "
        "or set BACKEND_PYTHON. Tried: " + "; ".join(errors)
    )


def _quote_key(value: str) -> str:
    if value.isidentifier() and not value[0].isdigit():
        return value
    return json.dumps(value)


def _schema_type(schema: Any) -> str:
    if isinstance(schema, bool):
        return "unknown"
    if not isinstance(schema, dict):
        return "unknown"
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if "const" in schema:
        return json.dumps(schema["const"], ensure_ascii=False)
    if "enum" in schema:
        return " | ".join(json.dumps(value, ensure_ascii=False) for value in schema["enum"])
    for combinator in ("anyOf", "oneOf"):
        if combinator in schema:
            members = [_schema_type(member) for member in schema[combinator]]
            return " | ".join(dict.fromkeys(members)) or "unknown"
    if "allOf" in schema:
        return " & ".join(_schema_type(member) for member in schema["allOf"])

    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        return " | ".join(_primitive_type(item, schema) for item in schema_type)
    if schema_type == "array":
        item_type = _schema_type(schema.get("items", {}))
        return f"Array<{item_type}>"
    if schema_type == "object" or "properties" in schema:
        properties = schema.get("properties", {})
        required = set(schema.get("required", []))
        members = [
            f"  {_quote_key(name)}{'?' if name not in required else ''}: {_schema_type(value)};"
            for name, value in properties.items()
        ]
        additional = schema.get("additionalProperties")
        if additional not in (None, False):
            value_type = "unknown" if additional is True else _schema_type(additional)
            members.append(f"  [key: string]: {value_type};")
        if not members:
            return "Record<string, never>"
        return "{\n" + "\n".join(members) + "\n}"
    return _primitive_type(schema_type, schema)


def _primitive_type(schema_type: Any, schema: dict[str, Any]) -> str:
    if schema_type == "string":
        return "string"
    if schema_type in {"integer", "number"}:
        return "number"
    if schema_type == "boolean":
        return "boolean"
    if schema_type == "null":
        return "null"
    if schema_type == "array":
        return f"Array<{_schema_type(schema.get('items', {}))}>"
    if schema_type == "object":
        return _schema_type(schema)
    return "unknown"


def main() -> None:
    schemas = _load_schemas()
    lines = [
        "// Generated from FastAPI OpenAPI components/schemas. Do not edit by hand.",
        "// Regenerate with: python scripts/generate_api_types.py",
        "",
    ]
    for name, schema in schemas.items():
        lines.append(f"export type {name} = {_schema_type(schema)};")
        lines.append("")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(lines), encoding="utf-8")
    SCHEMA_OUTPUT.write_text(
        json.dumps(schemas, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Generated {OUTPUT.relative_to(ROOT)} from {len(schemas)} OpenAPI schemas")


if __name__ == "__main__":
    main()
