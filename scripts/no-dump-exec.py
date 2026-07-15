#!/usr/bin/python3
"""Seal process-scoped Linux core-dump defenses, then run a program."""

from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import hmac
import os
import platform
import posixpath
import resource
import stat
import struct
import sys

PR_GET_DUMPABLE = 3
PR_SET_DUMPABLE = 4
ATTESTATION = "prctl-v1"
MANIFEST_NAME = "MANIFEST.sha256"
HOST_HELPER_RELATIVE = "scripts/no-dump-exec.py"
ARCHITECTURES = {
    "amd64": ({"amd64", "x86_64"}, 62),
    "arm64": ({"aarch64", "arm64"}, 183),
}


def fail(message: str, status: int = 70) -> "NoReturn":
    print(f"kassinao-no-dump: {message}", file=sys.stderr)
    raise SystemExit(status)


def prctl(operation: int, value: int = 0) -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    call = libc.prctl
    call.argtypes = [
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
    ]
    call.restype = ctypes.c_int
    result = call(operation, value, 0, 0, 0)
    if result == -1:
        error = ctypes.get_errno()
        fail(f"prctl failed: {os.strerror(error)}")
    return result


def coredump_filter() -> int:
    try:
        return int(open("/proc/self/coredump_filter", encoding="ascii").read().strip(), 16)
    except (OSError, ValueError) as error:
        fail(f"could not read coredump_filter: {error}")


def set_coredump_filter_zero() -> None:
    try:
        with open("/proc/self/coredump_filter", "w", encoding="ascii") as handle:
            handle.write("0\n")
    except OSError as error:
        fail(f"could not set coredump_filter: {error}")
    if coredump_filter() != 0:
        fail("coredump_filter did not remain zero")


def preserved_guard_is_active() -> bool:
    soft, hard = resource.getrlimit(resource.RLIMIT_CORE)
    return soft == 0 and hard == 0 and coredump_filter() == 0


def current_process_is_non_dumpable() -> bool:
    return preserved_guard_is_active() and prctl(PR_GET_DUMPABLE) == 0


def activate_guard() -> None:
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (OSError, ValueError) as error:
        fail(f"setrlimit(RLIMIT_CORE) failed: {error}")
    set_coredump_filter_zero()
    prctl(PR_SET_DUMPABLE, 0)
    if not current_process_is_non_dumpable():
        fail("process guard did not become active")


def safe_preload(path: str) -> str:
    if not os.path.isabs(path) or os.path.realpath(path) != path:
        fail("preload must use an absolute path", 65)
    try:
        metadata = os.lstat(path)
    except OSError as error:
        fail(f"preload is unavailable: {error}", 65)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_mode & 0o022
        or metadata.st_uid not in {0, os.geteuid()}
    ):
        fail("preload must be a protected regular file", 65)
    directory = os.path.dirname(path)
    while True:
        try:
            parent = os.lstat(directory)
        except OSError as error:
            fail(f"preload parent is unavailable: {error}", 65)
        if (
            not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid not in {0, os.geteuid()}
            or parent.st_mode & 0o022
        ):
            fail("preload parent chain is not protected", 65)
        if parent.st_mode & 0o077 == 0 or directory == "/":
            break
        directory = os.path.dirname(directory)
    return path


def protected_metadata(path: str, *, kind: str, expected_mode: set[int] | None = None) -> os.stat_result:
    """Require a root-owned, single-linked object that another user cannot replace."""
    try:
        metadata = os.lstat(path)
    except OSError as error:
        fail(f"bundle object is unavailable: {error}", 65)
    expected_type = stat.S_ISDIR if kind == "directory" else stat.S_ISREG
    if (
        not expected_type(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or (kind != "directory" and metadata.st_nlink != 1)
        or metadata.st_mode & 0o022
    ):
        fail(f"bundle {kind} is not protected: {path}", 65)
    mode = stat.S_IMODE(metadata.st_mode)
    if expected_mode is not None and mode not in expected_mode:
        fail(f"bundle {kind} has an invalid mode: {path}", 65)
    return metadata


def validate_bundle_root(root: str) -> str:
    if os.geteuid() != 0:
        fail("bundle mode requires root", 77)
    if not os.path.isabs(root) or os.path.realpath(root) != root:
        fail("bundle root must use an absolute canonical path", 65)
    protected_metadata(root, kind="directory", expected_mode={0o500, 0o700})
    if os.path.lexists(os.path.join(root, ".git")):
        fail("privileged bundle cannot be a Git checkout", 65)

    cursor = os.path.dirname(root)
    while True:
        protected_metadata(cursor, kind="directory")
        if os.path.lexists(os.path.join(cursor, ".git")):
            fail("privileged bundle cannot be below a Git checkout", 65)
        parent = os.path.dirname(cursor)
        if parent == cursor:
            break
        cursor = parent
    return root


def canonical_manifest_path(raw_path: str) -> str:
    if (
        not raw_path.startswith("./")
        or "\\" in raw_path
        or raw_path == f"./{MANIFEST_NAME}"
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in raw_path)
    ):
        fail("bundle manifest contains an unsafe path", 65)
    relative = raw_path[2:]
    if not relative or relative.startswith("/") or posixpath.normpath(relative) != relative:
        fail("bundle manifest contains a non-canonical path", 65)
    return relative


def read_manifest(root: str) -> dict[str, str]:
    manifest_path = os.path.join(root, MANIFEST_NAME)
    metadata = protected_metadata(manifest_path, kind="file")
    if metadata.st_size <= 0 or metadata.st_size > 1024 * 1024:
        fail("bundle manifest has an invalid size", 65)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(manifest_path, flags)
        with os.fdopen(descriptor, "r", encoding="ascii", newline="") as source:
            contents = source.read(1024 * 1024 + 1)
    except (OSError, UnicodeError) as error:
        fail(f"bundle manifest could not be read: {error}", 65)
    if len(contents) > 1024 * 1024 or not contents.endswith("\n") or "\r" in contents:
        fail("bundle manifest has invalid framing", 65)

    entries: dict[str, str] = {}
    for line in contents.splitlines():
        if (
            len(line) < 69
            or line[64:66] != "  "
            or any(character not in "0123456789abcdef" for character in line[:64])
        ):
            fail("bundle manifest contains an invalid entry", 65)
        relative = canonical_manifest_path(line[66:])
        if relative in entries:
            fail("bundle manifest contains a duplicate path", 65)
        entries[relative] = line[:64]
    if not entries:
        fail("bundle manifest is empty", 65)
    return entries


def protected_bundle_file(root: str, relative: str) -> str:
    path = os.path.join(root, *relative.split("/"))
    directory = root
    for component in relative.split("/")[:-1]:
        directory = os.path.join(directory, component)
        protected_metadata(directory, kind="directory")
    protected_metadata(path, kind="file")
    if os.path.realpath(path) != path:
        fail(f"bundle file is not canonical: {relative}", 65)
    return path


def hash_protected_file(path: str) -> str:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    digest = hashlib.sha256()
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as source:
            metadata = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != 0
                or metadata.st_gid != 0
                or metadata.st_nlink != 1
                or metadata.st_mode & 0o022
            ):
                fail(f"bundle file changed while being verified: {path}", 65)
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError as error:
        fail(f"bundle file could not be hashed: {error}", 65)
    return digest.hexdigest()


def verify_elf(path: str, architecture: str, *, preload: bool) -> None:
    try:
        with open(path, "rb") as source:
            data = source.read()
    except OSError as error:
        fail(f"native bundle artifact could not be read: {error}", 65)
    if len(data) < 64 or data[:7] != b"\x7fELF\x02\x01\x01":
        fail("native bundle artifact is not ELF64 little-endian", 65)
    elf_type, machine = struct.unpack_from("<HH", data, 16)
    expected_machine = ARCHITECTURES[architecture][1]
    if machine != expected_machine:
        fail("native bundle artifact has the wrong architecture", 65)
    if preload:
        if elf_type != 3:
            fail("no-dump preload is not an ELF shared object", 65)
        return
    if elf_type not in {2, 3}:
        fail("no-dump launcher is not executable ELF", 65)
    program_offset = struct.unpack_from("<Q", data, 32)[0]
    program_entry_size, program_count = struct.unpack_from("<HH", data, 54)
    if program_count and (
        program_entry_size < 56 or program_offset + program_entry_size * program_count > len(data)
    ):
        fail("no-dump launcher has invalid ELF program headers", 65)
    for index in range(program_count):
        program_type = struct.unpack_from("<I", data, program_offset + index * program_entry_size)[0]
        if program_type == 3:
            fail("no-dump launcher must be static", 65)


def verify_bundle(root: str, script_relative: str, architecture: str, program: list[str]) -> str:
    root = validate_bundle_root(root)
    if architecture not in ARCHITECTURES or platform.machine().lower() not in ARCHITECTURES[architecture][0]:
        fail("bundle architecture does not match this host", 65)
    if (
        not script_relative.startswith("scripts/")
        or posixpath.normpath(script_relative) != script_relative
        or not script_relative.endswith(".sh")
    ):
        fail("script-relative must name a canonical bundle shell script", 65)

    runtime = f"runtime/linux-{architecture}"
    launcher_relative = f"{runtime}/kassinao-no-dump"
    preload_relative = f"{runtime}/libkassinao-no-dump.so"
    required = {HOST_HELPER_RELATIVE, script_relative, launcher_relative, preload_relative}
    manifest = read_manifest(root)
    if any(relative not in manifest for relative in required):
        fail("bundle manifest does not seal every no-dump control", 65)

    resolved: dict[str, str] = {}
    for relative, expected_digest in manifest.items():
        path = protected_bundle_file(root, relative)
        actual_digest = hash_protected_file(path)
        if not hmac.compare_digest(actual_digest, expected_digest):
            fail(f"bundle file diverges from manifest: {relative}", 65)
        if relative in required:
            resolved[relative] = path

    helper_path = resolved[HOST_HELPER_RELATIVE]
    script_path = resolved[script_relative]
    if os.path.abspath(__file__) != helper_path or os.path.realpath(__file__) != helper_path:
        fail("bundle helper is not executing from the sealed path", 65)
    if not program or program[0] != script_path or os.path.realpath(program[0]) != script_path:
        fail("target script is not the sealed bundle control", 65)

    launcher_path = resolved[launcher_relative]
    preload_path = resolved[preload_relative]
    verify_elf(launcher_path, architecture, preload=False)
    verify_elf(preload_path, architecture, preload=True)
    return safe_preload(preload_path)


def main(arguments: list[str]) -> int:
    if sys.platform != "linux":
        fail("Linux is required", 69)
    if arguments == ["--check-preserved"]:
        return 0 if preserved_guard_is_active() else 1
    if arguments == ["--check-current"]:
        return 0 if current_process_is_non_dumpable() else 1

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--preload")
    parser.add_argument("--bundle-root")
    parser.add_argument("--script-relative")
    parser.add_argument("--arch", choices=tuple(ARCHITECTURES))
    parser.add_argument("program", nargs=argparse.REMAINDER)
    options = parser.parse_args(arguments)
    program = options.program[1:] if options.program[:1] == ["--"] else options.program
    if not program:
        fail(
            "usage: no-dump-exec.py [--preload ABSOLUTE_SO | "
            "--bundle-root ROOT --script-relative scripts/NAME.sh --arch amd64|arm64] "
            "[--] PROGRAM [ARG ...]",
            64,
        )

    bundle_values = (options.bundle_root, options.script_relative, options.arch)
    if any(bundle_values) and not all(bundle_values):
        fail("bundle mode requires --bundle-root, --script-relative and --arch", 64)
    if options.preload and all(bundle_values):
        fail("--preload and bundle mode are mutually exclusive", 64)

    activate_guard()
    preload = options.preload
    if all(bundle_values):
        preload = verify_bundle(
            options.bundle_root,
            options.script_relative,
            options.arch,
            program,
        )
    environment = os.environ.copy()
    environment.pop("KASSINAO_NO_DUMP_ACTIVE", None)
    for name in tuple(environment):
        if name.startswith("LD_"):
            environment.pop(name, None)
    if preload:
        environment["LD_PRELOAD"] = safe_preload(preload)
    try:
        os.execvpe(program[0], program, environment)
    except OSError as error:
        print(f"kassinao-no-dump: exec failed: {error.strerror}", file=sys.stderr)
        return 127 if error.errno == errno.ENOENT else 126


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
