"""Generate and verify Smart ATC's committed HTTP contract artifacts.

Usage from the repository root:

    python scripts/generate_contracts.py
    python scripts/generate_contracts.py --check

The generator imports the FastAPI application but never starts its lifespan,
opens a socket, or advances simulation state.  All outputs are derived from a
single in-memory OpenAPI document and serialized with canonical JSON rules.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

GENERATOR_VERSION = "1.0.0"
MANIFEST_VERSION = "1.0.0"
CANONICALIZATION = "utf8-json-sort-keys-indent-2-lf-v1"
HTTP_METHODS = frozenset({"delete", "get", "head", "options", "patch", "post", "put", "trace"})
OPENAPI_RELATIVE_PATH = Path("contracts/openapi.json")
MANIFEST_RELATIVE_PATH = Path("contracts/manifest.json")
TYPESCRIPT_RELATIVE_PATH = Path("frontend/src/generated/contractMetadata.ts")
STATE_WEBSOCKET_PATH = "/ws/state"


class ContractGenerationError(RuntimeError):
    """Raised when the live OpenAPI surface cannot form a safe contract."""


@dataclass(frozen=True)
class GeneratedContractArtifacts:
    openapi: bytes
    manifest: bytes
    typescript: bytes

    def files(self) -> dict[Path, bytes]:
        return {
            OPENAPI_RELATIVE_PATH: self.openapi,
            MANIFEST_RELATIVE_PATH: self.manifest,
            TYPESCRIPT_RELATIVE_PATH: self.typescript,
        }


def canonical_json_bytes(value: Any) -> bytes:
    """Serialize JSON deterministically for commits and content hashes."""

    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            indent=2,
            sort_keys=True,
            separators=(",", ": "),
        )
        + "\n"
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _load_application_contract() -> tuple[dict[str, Any], str]:
    # Keep imports lazy so compatibility helpers and pure serialization tests do
    # not instantiate the application unless contract generation is requested.
    from backend.main import app
    from backend.schemas import SCHEMA_VERSION

    schema = copy.deepcopy(app.openapi())
    if not isinstance(schema, dict):
        raise ContractGenerationError("FastAPI returned a non-object OpenAPI document.")
    websocket_paths = {
        route.path
        for route in app.routes
        if route.__class__.__name__ in {"APIWebSocketRoute", "WebSocketRoute"}
    }
    if STATE_WEBSOCKET_PATH not in websocket_paths:
        raise ContractGenerationError(
            f"Required WebSocket channel {STATE_WEBSOCKET_PATH!r} is not registered."
        )
    return schema, SCHEMA_VERSION


def extract_operations(openapi: Mapping[str, Any]) -> dict[str, dict[str, str]]:
    """Return a unique operation-id map sorted independently of route order."""

    paths = openapi.get("paths")
    if not isinstance(paths, Mapping):
        raise ContractGenerationError("OpenAPI paths must be an object.")
    operations: dict[str, dict[str, str]] = {}
    for path in sorted(paths):
        path_item = paths[path]
        if not isinstance(path_item, Mapping):
            continue
        for method in sorted(HTTP_METHODS.intersection(str(item).lower() for item in path_item)):
            operation = path_item.get(method)
            if not isinstance(operation, Mapping):
                continue
            operation_id = operation.get("operationId")
            if not isinstance(operation_id, str) or not operation_id.strip():
                raise ContractGenerationError(f"{method.upper()} {path} has no operationId.")
            if operation_id in operations:
                previous = operations[operation_id]
                raise ContractGenerationError(
                    "Duplicate operationId "
                    f"{operation_id!r}: {previous['method']} {previous['path']} and {method.upper()} {path}."
                )
            operations[operation_id] = {"method": method.upper(), "path": str(path)}
    return dict(sorted(operations.items()))


def extract_model_hashes(openapi: Mapping[str, Any]) -> dict[str, str]:
    components = openapi.get("components", {})
    if not isinstance(components, Mapping):
        raise ContractGenerationError("OpenAPI components must be an object.")
    schemas = components.get("schemas", {})
    if not isinstance(schemas, Mapping):
        raise ContractGenerationError("OpenAPI component schemas must be an object.")
    return {
        str(name): sha256_bytes(canonical_json_bytes(schema))
        for name, schema in sorted(schemas.items())
    }


def build_websocket_channels(
    *,
    schema_version: str,
    model_hashes: Mapping[str, str],
) -> dict[str, dict[str, Any]]:
    """Describe the core non-OpenAPI stream from committed protocol rules."""

    snapshot_hash = model_hashes.get("Snapshot")
    if not snapshot_hash:
        raise ContractGenerationError("Snapshot component hash is required for /ws/state.")
    return {
        "state_snapshot_stream": {
            "path": STATE_WEBSOCKET_PATH,
            "protocol": "websocket-rfc6455",
            "subprotocol": None,
            "direction": "server_to_client",
            "message": {
                "frame": "text",
                "media_type": "application/json",
                "component": "Snapshot",
                "component_sha256": snapshot_hash,
                "schema_version": schema_version,
            },
            "delivery": {
                "initial_snapshot_on_connect": True,
                "nominal_hz": 5,
                "ordering_session_field": "session_id",
                "ordering_sequence_field": "sequence",
            },
            "session_selector": {
                "header": "X-Session-ID",
                "query": "session_id",
                "precedence": "header_then_query",
                "must_match_if_both": True,
                "default_when_omitted": "default",
                "mismatch_close_code": 4400,
            },
            "authentication": {
                "header": "X-API-Key",
                "transport": "header_only",
                "required_when_configured": True,
                "failure_close_code": 4401,
            },
            "accept_headers": ["X-Session-ID", "X-Runtime-Session-ID"],
            "close_codes": {
                "4400": "invalid selector or selector mismatch",
                "4401": "authentication required",
                "4404": "training session not found",
                "4429": "session connection quota exceeded",
            },
        }
    }


_INTEGRITY_FIELDS = (
    "api_version",
    "canonicalization",
    "channel_count",
    "channels",
    "generator_version",
    "manifest_version",
    "model_count",
    "model_hashes",
    "openapi_sha256",
    "openapi_version",
    "operation_count",
    "operations",
    "schema_version",
)


def contract_set_sha256(manifest: Mapping[str, Any]) -> str:
    """Hash the non-circular manifest payload that identifies a contract set."""

    try:
        payload = {key: manifest[key] for key in _INTEGRITY_FIELDS}
    except KeyError as exc:
        raise ContractGenerationError(f"Manifest is missing integrity field {exc.args[0]!r}.") from None
    return sha256_bytes(canonical_json_bytes(payload))


def build_manifest(
    openapi: Mapping[str, Any],
    openapi_bytes: bytes,
    *,
    schema_version: str,
) -> dict[str, Any]:
    info = openapi.get("info")
    if not isinstance(info, Mapping) or not isinstance(info.get("version"), str):
        raise ContractGenerationError("OpenAPI info.version must be a string.")
    openapi_version = openapi.get("openapi")
    if not isinstance(openapi_version, str):
        raise ContractGenerationError("OpenAPI version must be a string.")

    from backend.contract_compat import (
        IncompatibleContractMajor,
        InvalidContractVersion,
        require_compatible_contract_major,
    )

    try:
        require_compatible_contract_major(str(info["version"]), schema_version)
    except (IncompatibleContractMajor, InvalidContractVersion) as exc:
        raise ContractGenerationError(str(exc)) from None

    operations = extract_operations(openapi)
    model_hashes = extract_model_hashes(openapi)
    channels = build_websocket_channels(
        schema_version=schema_version,
        model_hashes=model_hashes,
    )
    manifest: dict[str, Any] = {
        "manifest_version": MANIFEST_VERSION,
        "generator_version": GENERATOR_VERSION,
        "canonicalization": CANONICALIZATION,
        "api_version": info["version"],
        "schema_version": schema_version,
        "openapi_version": openapi_version,
        "openapi_sha256": sha256_bytes(openapi_bytes),
        "operation_count": len(operations),
        "model_count": len(model_hashes),
        "channel_count": len(channels),
        "operations": operations,
        "model_hashes": model_hashes,
        "channels": channels,
    }
    manifest["contract_set_sha256"] = contract_set_sha256(manifest)
    return manifest


def _typescript_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_typescript(manifest: Mapping[str, Any]) -> bytes:
    operations = manifest["operations"]
    if not isinstance(operations, Mapping):
        raise ContractGenerationError("Manifest operations must be an object.")
    methods = sorted({str(operation["method"]) for operation in operations.values()})
    method_union = " | ".join(_typescript_string(method) for method in methods) or "never"
    channels = manifest["channels"]
    if not isinstance(channels, Mapping):
        raise ContractGenerationError("Manifest channels must be an object.")
    rendered_channels = json.dumps(
        channels,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ).splitlines()
    lines = [
        "// Generated by scripts/generate_contracts.py. DO NOT EDIT.",
        "// Canonical source: contracts/openapi.json and contracts/manifest.json.",
        "",
        f"export const CONTRACT_MANIFEST_VERSION = {_typescript_string(str(manifest['manifest_version']))} as const;",
        f"export const CONTRACT_GENERATOR_VERSION = {_typescript_string(str(manifest['generator_version']))} as const;",
        f"export const API_VERSION = {_typescript_string(str(manifest['api_version']))} as const;",
        f"export const SNAPSHOT_SCHEMA_VERSION = {_typescript_string(str(manifest['schema_version']))} as const;",
        f"export const OPENAPI_VERSION = {_typescript_string(str(manifest['openapi_version']))} as const;",
        f"export const OPENAPI_SHA256 = {_typescript_string(str(manifest['openapi_sha256']))} as const;",
        f"export const CONTRACT_SET_SHA256 = {_typescript_string(str(manifest['contract_set_sha256']))} as const;",
        f"export const CONTRACT_OPERATION_COUNT = {int(manifest['operation_count'])} as const;",
        f"export const CONTRACT_MODEL_COUNT = {int(manifest['model_count'])} as const;",
        f"export const CONTRACT_CHANNEL_COUNT = {int(manifest['channel_count'])} as const;",
        "",
        f"export type ContractHttpMethod = {method_union};",
        "",
        "export const CONTRACT_CHANNELS = " + rendered_channels[0],
        *rendered_channels[1:-1],
        rendered_channels[-1] + " as const;",
        "",
        "export type ContractChannelId = keyof typeof CONTRACT_CHANNELS;",
        "export type ContractChannel = (typeof CONTRACT_CHANNELS)[ContractChannelId];",
        "",
        "export function contractChannel(channelId: ContractChannelId): ContractChannel {",
        "  return CONTRACT_CHANNELS[channelId];",
        "}",
        "",
        "export const CONTRACT_OPERATIONS = {",
    ]
    for operation_id, operation in operations.items():
        lines.append(
            "  "
            f"{_typescript_string(str(operation_id))}: {{ "
            f"method: {_typescript_string(str(operation['method']))}, "
            f"path: {_typescript_string(str(operation['path']))} "
            "},"
        )
    lines.extend([
        "} as const satisfies Readonly<Record<string, Readonly<{ method: ContractHttpMethod; path: string }>>>;",
        "",
        "export type ContractOperationId = keyof typeof CONTRACT_OPERATIONS;",
        "export type ContractOperation = (typeof CONTRACT_OPERATIONS)[ContractOperationId];",
        "",
        "export function contractOperation(operationId: ContractOperationId): ContractOperation {",
        "  return CONTRACT_OPERATIONS[operationId];",
        "}",
        "",
    ])
    return "\n".join(lines).encode("utf-8")


def build_contract_artifacts() -> GeneratedContractArtifacts:
    openapi, schema_version = _load_application_contract()
    openapi_bytes = canonical_json_bytes(openapi)
    manifest = build_manifest(openapi, openapi_bytes, schema_version=schema_version)
    return GeneratedContractArtifacts(
        openapi=openapi_bytes,
        manifest=canonical_json_bytes(manifest),
        typescript=render_typescript(manifest),
    )


def write_contract_artifacts(root: Path = REPOSITORY_ROOT) -> GeneratedContractArtifacts:
    artifacts = build_contract_artifacts()
    for relative_path, content in artifacts.files().items():
        destination = root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.tmp")
        temporary.write_bytes(content)
        os.replace(temporary, destination)
    return artifacts


def contract_drift(root: Path = REPOSITORY_ROOT) -> list[Path]:
    expected = build_contract_artifacts()
    drifted: list[Path] = []
    for relative_path, expected_content in expected.files().items():
        destination = root / relative_path
        if not destination.is_file() or destination.read_bytes() != expected_content:
            drifted.append(relative_path)
    return drifted


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate or verify Smart ATC API contract artifacts.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail without writing when committed artifacts differ from the current FastAPI schema.",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=REPOSITORY_ROOT,
        help=argparse.SUPPRESS,
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = _build_parser().parse_args(argv)
    root = arguments.root.resolve()
    if arguments.check:
        drifted = contract_drift(root)
        if drifted:
            print("Contract drift detected:", file=sys.stderr)
            for relative_path in drifted:
                print(f"  - {relative_path.as_posix()}", file=sys.stderr)
            print("Run: python scripts/generate_contracts.py", file=sys.stderr)
            return 1
        manifest = json.loads((root / MANIFEST_RELATIVE_PATH).read_text(encoding="utf-8"))
        print(
            "Contract check passed: "
            f"{manifest['operation_count']} operations, {manifest['model_count']} models, "
            f"set {manifest['contract_set_sha256']}"
        )
        return 0

    artifacts = write_contract_artifacts(root)
    manifest = json.loads(artifacts.manifest)
    for relative_path, content in artifacts.files().items():
        print(f"Wrote {relative_path.as_posix()} ({len(content)} bytes, sha256={sha256_bytes(content)})")
    print(
        f"Contract set {manifest['contract_set_sha256']}: "
        f"{manifest['operation_count']} operations, {manifest['model_count']} models"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
