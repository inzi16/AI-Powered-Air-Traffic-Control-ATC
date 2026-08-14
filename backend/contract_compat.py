"""Small, dependency-free helpers for API contract version negotiation."""

from __future__ import annotations

import re


_SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


class InvalidContractVersion(ValueError):
    """Raised when a client or server contract version is not valid semver."""


class IncompatibleContractMajor(ValueError):
    """Raised before data exchange when contract major versions differ."""

    def __init__(self, client_version: str, server_version: str) -> None:
        super().__init__(
            f"Incompatible contract major versions: client={client_version}, server={server_version}."
        )
        self.client_version = client_version
        self.server_version = server_version


def contract_major(version: str) -> int:
    """Return the semver major or fail closed for malformed versions."""

    if not isinstance(version, str) or _SEMVER.fullmatch(version) is None:
        raise InvalidContractVersion(f"Invalid semantic contract version: {version!r}.")
    return int(version.split(".", 1)[0])


def is_compatible_contract_major(client_version: str, server_version: str) -> bool:
    """Return whether both valid versions share a major compatibility line."""

    return contract_major(client_version) == contract_major(server_version)


def require_compatible_contract_major(client_version: str, server_version: str) -> None:
    """Reject incompatible contracts before snapshots or commands are decoded."""

    if not is_compatible_contract_major(client_version, server_version):
        raise IncompatibleContractMajor(client_version, server_version)


__all__ = [
    "IncompatibleContractMajor",
    "InvalidContractVersion",
    "contract_major",
    "is_compatible_contract_major",
    "require_compatible_contract_major",
]
