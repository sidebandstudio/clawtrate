"""Inspect final artifact structure without extracting files or running a binary."""
import os
import plistlib
import stat
import struct
import sys
from zipfile import ZipFile


def mac_app(path, cpu):
    with ZipFile(path) as archive:
        entries = archive.infolist()
        names = {entry.filename for entry in entries}
        if len(names) != len(entries) or sum(e.file_size for e in entries) > 2 * 1024**3:
            return False
        # Electron has nested helper apps, all inside the single outer bundle.
        for name in names:
            parts = name.rstrip("/").split("/")
            if parts[0] != "Clawtrate.app" or any(part in ("", ".", "..") for part in parts) or "\\" in name:
                return False
        def regular(name):
            entry = archive.getinfo(name)
            return stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG)
        contents = "Clawtrate.app/Contents/"
        plist = contents + "Info.plist"
        if not regular(plist) or archive.getinfo(plist).file_size > 1024**2:
            return False
        executable = plistlib.loads(archive.read(plist)).get("CFBundleExecutable")
        if not isinstance(executable, str) or "/" in executable or executable in ("", ".", ".."):
            return False
        main = contents + "MacOS/" + executable
        if not regular(main):
            return False
        for prefix in ("Clawtrate.app", "Clawtrate.app/Contents", contents + "MacOS"):
            if prefix in names:
                return False
        with archive.open(main) as binary:
            magic, machine, _, kind, commands, command_bytes = struct.unpack("<6I", binary.read(24))
        return (magic == 0xFEEDFACF and machine == cpu and kind == 2 and
                commands > 0 and 8 * commands <= command_bytes <= archive.getinfo(main).file_size - 32 and
                archive.testzip() is None)


def windows_exe(path):
    with open(path, "rb") as binary:
        size = os.fstat(binary.fileno()).st_size
        dos = binary.read(64)
        if dos[:2] != b"MZ":
            return False
        offset, = struct.unpack_from("<I", dos, 60)
        if not 64 <= offset <= size - 24:
            return False
        binary.seek(offset)
        signature, machine, sections, _, _, _, length, flags = struct.unpack("<4sHHIIIHH", binary.read(24))
        if signature != b"PE\0\0" or machine != 0x8664 or not flags & 2 or flags & 0x2000:
            return False
        if not 1 <= sections <= 96 or length < 112 or offset + 24 + length + 40 * sections > size:
            return False
        optional = binary.read(length)
        if optional[:2] != b"\x0b\x02":
            return False
        start, = struct.unpack_from("<I", optional, 16)
        has_entry = False
        for _ in range(sections):
            section = binary.read(40)
            address, count, raw = struct.unpack_from("<III", section, 12)
            attributes, = struct.unpack_from("<I", section, 36)
            if count and (raw < offset + 24 + length + 40 * sections or raw + count > size):
                return False
            if attributes & 0x20000000 and address <= start < address + count:
                has_entry = True
        return has_entry


if __name__ == "__main__":
    key, path = sys.argv[1:]
    try:
        valid = (windows_exe(path) if key == "win-x64" else
                 mac_app(path, {"mac-arm64": 0x0100000C, "mac-x64": 0x01000007}[key]))
    except Exception:
        valid = False
    sys.exit(0 if valid else 1)
