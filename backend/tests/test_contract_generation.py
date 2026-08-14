from __future__ import annotations

import hashlib
import inspect
import json
from pathlib import Path

import pytest

from contract_compat import (
    IncompatibleContractMajor,
    InvalidContractVersion,
    contract_major,
    is_compatible_contract_major,
    require_compatible_contract_major,
)
from scripts.generate_contracts import (
    MANIFEST_RELATIVE_PATH,
    OPENAPI_RELATIVE_PATH,
    REPOSITORY_ROOT,
    TYPESCRIPT_RELATIVE_PATH,
    ContractGenerationError,
    build_contract_artifacts,
    build_manifest,
    build_websocket_channels,
    canonical_json_bytes,
    contract_drift,
    contract_set_sha256,
    extract_model_hashes,
    extract_operations,
    main,
    render_typescript,
    sha256_bytes,
    write_contract_artifacts,
)


def committed_json(relative_path: Path) -> dict:
    return json.loads((REPOSITORY_ROOT / relative_path).read_text(encoding="utf-8"))


def test_generation_is_stable_and_committed_artifacts_have_no_drift():
    first = build_contract_artifacts()
    second = build_contract_artifacts()
    assert first == second
    assert contract_drift(REPOSITORY_ROOT) == []
    assert (REPOSITORY_ROOT / OPENAPI_RELATIVE_PATH).read_bytes() == first.openapi
    assert (REPOSITORY_ROOT / MANIFEST_RELATIVE_PATH).read_bytes() == first.manifest
    assert (REPOSITORY_ROOT / TYPESCRIPT_RELATIVE_PATH).read_bytes() == first.typescript


def test_openapi_and_manifest_use_the_declared_canonical_serialization():
    for relative_path in (OPENAPI_RELATIVE_PATH, MANIFEST_RELATIVE_PATH):
        payload = (REPOSITORY_ROOT / relative_path).read_bytes()
        assert payload.endswith(b"\n")
        assert b"\r\n" not in payload
        assert payload == canonical_json_bytes(json.loads(payload))


def test_operation_ids_are_present_unique_and_match_the_manifest():
    openapi = committed_json(OPENAPI_RELATIVE_PATH)
    manifest = committed_json(MANIFEST_RELATIVE_PATH)
    operations = extract_operations(openapi)
    assert operations
    assert len(operations) == len(set(operations))
    assert operations == manifest["operations"]
    assert len(operations) == manifest["operation_count"]
    for operation_id, operation in operations.items():
        assert operation_id.strip() == operation_id
        assert operation["method"] in {"DELETE", "GET", "PATCH", "POST", "PUT"}
        assert operation["path"].startswith("/")


def test_duplicate_operation_id_fails_generation_closed():
    malformed = {
        "paths": {
            "/one": {"get": {"operationId": "duplicate"}},
            "/two": {"post": {"operationId": "duplicate"}},
        }
    }
    with pytest.raises(ContractGenerationError, match="Duplicate operationId"):
        extract_operations(malformed)


def test_generator_rejects_api_and_snapshot_schema_major_mismatch():
    synthetic = {
        "openapi": "3.1.0",
        "info": {"title": "Synthetic", "version": "4.0.0"},
        "paths": {},
        "components": {"schemas": {}},
    }
    with pytest.raises(ContractGenerationError, match="Incompatible contract major"):
        build_manifest(
            synthetic,
            canonical_json_bytes(synthetic),
            schema_version="3.9.0",
        )


def test_required_session_state_event_and_command_endpoints_are_committed():
    manifest = committed_json(MANIFEST_RELATIVE_PATH)
    available = {
        (operation["method"], operation["path"])
        for operation in manifest["operations"].values()
    }
    required = {
        ("POST", "/training-sessions"),
        ("GET", "/training-sessions"),
        ("GET", "/training-sessions/{session_id}"),
        ("DELETE", "/training-sessions/{session_id}"),
        ("GET", "/sim/state"),
        ("GET", "/sessions/{session_id}/events"),
        ("GET", "/sessions/{session_id}/replay"),
        ("POST", "/scenario/control"),
        ("POST", "/routes/demo"),
        ("POST", "/clearances/{clearance_id}/accept"),
        ("POST", "/emergencies/activate"),
    }
    assert required <= available


def test_websocket_state_channel_exists_even_though_openapi_excludes_websockets():
    from backend.main import app

    websocket_paths = {
        route.path
        for route in app.routes
        if route.__class__.__name__ in {"APIWebSocketRoute", "WebSocketRoute"}
    }
    assert "/ws/state" in websocket_paths
    openapi = committed_json(OPENAPI_RELATIVE_PATH)
    manifest = committed_json(MANIFEST_RELATIVE_PATH)
    assert "/ws/state" not in openapi["paths"]

    assert manifest["channel_count"] == 1
    channel = manifest["channels"]["state_snapshot_stream"]
    assert channel["path"] == "/ws/state"
    assert channel["protocol"] == "websocket-rfc6455"
    assert channel["subprotocol"] is None
    assert channel["direction"] == "server_to_client"
    assert channel["message"] == {
        "component": "Snapshot",
        "component_sha256": manifest["model_hashes"]["Snapshot"],
        "frame": "text",
        "media_type": "application/json",
        "schema_version": manifest["schema_version"],
    }
    assert channel["delivery"] == {
        "initial_snapshot_on_connect": True,
        "nominal_hz": 5,
        "ordering_sequence_field": "sequence",
        "ordering_session_field": "session_id",
    }
    assert channel["session_selector"] == {
        "header": "X-Session-ID",
        "query": "session_id",
        "precedence": "header_then_query",
        "must_match_if_both": True,
        "default_when_omitted": "default",
        "mismatch_close_code": 4400,
    }
    assert channel["authentication"] == {
        "header": "X-API-Key",
        "transport": "header_only",
        "required_when_configured": True,
        "failure_close_code": 4401,
    }
    assert channel["accept_headers"] == ["X-Session-ID", "X-Runtime-Session-ID"]


def test_websocket_contract_fails_closed_without_snapshot_component():
    with pytest.raises(ContractGenerationError, match="Snapshot component hash"):
        build_websocket_channels(schema_version="3.0.0", model_hashes={})


def test_websocket_selector_manifest_matches_committed_endpoint_rules():
    from backend.main import ws_state

    channel = committed_json(MANIFEST_RELATIVE_PATH)["channels"]["state_snapshot_stream"]
    source = inspect.getsource(ws_state)
    selector = channel["session_selector"]
    authentication = channel["authentication"]
    selector_header = selector["header"]
    selector_query = selector["query"]
    auth_header = authentication["header"]
    assert f'websocket.headers.get("{selector_header}")' in source
    assert f'websocket.query_params.get("{selector_query}")' in source
    assert "header_session_id or query_session_id" in source
    assert "header_session_id.strip() != query_session_id.strip()" in source
    assert f'websocket.close(code={selector["mismatch_close_code"]}' in source
    assert f'websocket.headers.get("{auth_header}", "")' in source
    assert 'websocket.query_params.get("api_key"' not in source
    assert f'websocket.close(code={authentication["failure_close_code"]}' in source
    assert "send_text(selected_runtime.current_json)" in source
    assert "send_text(await queue.get())" in source


def test_manifest_hashes_every_model_and_the_exact_openapi_file():
    openapi_bytes = (REPOSITORY_ROOT / OPENAPI_RELATIVE_PATH).read_bytes()
    openapi = json.loads(openapi_bytes)
    manifest = committed_json(MANIFEST_RELATIVE_PATH)
    expected_model_hashes = extract_model_hashes(openapi)
    assert manifest["openapi_sha256"] == hashlib.sha256(openapi_bytes).hexdigest()
    assert manifest["model_hashes"] == expected_model_hashes
    assert manifest["model_count"] == len(expected_model_hashes)
    assert all(len(value) == 64 for value in manifest["model_hashes"].values())


def test_manifest_contract_set_integrity_and_version_fields():
    manifest_bytes = (REPOSITORY_ROOT / MANIFEST_RELATIVE_PATH).read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest["manifest_version"] == "1.0.0"
    assert manifest["generator_version"] == "1.0.0"
    assert manifest["api_version"] == "3.0.0"
    assert manifest["schema_version"] == "3.0.0"
    assert manifest["openapi_version"] == "3.1.0"
    assert manifest["contract_set_sha256"] == contract_set_sha256(manifest)
    assert sha256_bytes(manifest_bytes) == hashlib.sha256(manifest_bytes).hexdigest()


def test_generated_typescript_is_exactly_derived_from_manifest():
    manifest = committed_json(MANIFEST_RELATIVE_PATH)
    generated = (REPOSITORY_ROOT / TYPESCRIPT_RELATIVE_PATH).read_bytes()
    assert generated == render_typescript(manifest)
    text = generated.decode("utf-8")
    assert "DO NOT EDIT" in text
    assert f'export const API_VERSION = "{manifest["api_version"]}" as const;' in text
    assert f'export const CONTRACT_SET_SHA256 = "{manifest["contract_set_sha256"]}" as const;' in text
    assert "export type ContractOperationId = keyof typeof CONTRACT_OPERATIONS;" in text
    assert "export type ContractChannelId = keyof typeof CONTRACT_CHANNELS;" in text
    assert '"path": "/ws/state"' in text
    assert manifest["model_hashes"]["Snapshot"] in text
    assert "interface Snapshot" not in text
    assert "interface Route" not in text


def test_check_mode_returns_nonzero_on_missing_or_changed_artifact(tmp_path, capsys):
    write_contract_artifacts(tmp_path)
    assert main(["--check", "--root", str(tmp_path)]) == 0
    assert "Contract check passed" in capsys.readouterr().out

    openapi_path = tmp_path / OPENAPI_RELATIVE_PATH
    openapi_path.write_bytes(openapi_path.read_bytes() + b" ")
    assert main(["--check", "--root", str(tmp_path)]) == 1
    captured = capsys.readouterr()
    assert "Contract drift detected" in captured.err
    assert OPENAPI_RELATIVE_PATH.as_posix() in captured.err


@pytest.mark.parametrize(
    "client,server",
    [
        ("3.0.0", "3.0.0"),
        ("3.99.0", "3.1.7"),
        ("0.8.0-alpha.1", "0.9.2+build.4"),
    ],
)
def test_same_major_contract_versions_are_compatible(client, server):
    assert is_compatible_contract_major(client, server)
    assert require_compatible_contract_major(client, server) is None


@pytest.mark.parametrize(
    "client,server",
    [("2.9.9", "3.0.0"), ("3.9.9", "4.0.0"), ("0.9.0", "1.0.0")],
)
def test_incompatible_major_contract_is_rejected_before_decode(client, server):
    assert not is_compatible_contract_major(client, server)
    with pytest.raises(IncompatibleContractMajor) as captured:
        require_compatible_contract_major(client, server)
    assert captured.value.client_version == client
    assert captured.value.server_version == server


@pytest.mark.parametrize("version", ["3", "3.0", "v3.0.0", "03.0.0", "3.x.0", "", " 3.0.0"])
def test_malformed_contract_versions_fail_closed(version):
    with pytest.raises(InvalidContractVersion):
        contract_major(version)
