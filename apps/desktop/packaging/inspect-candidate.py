"""Inspect final artifact structure without extracting files or running a binary."""
import json
import os
import plistlib
import stat
import struct
import sys
import unicodedata
from pathlib import Path
from zipfile import ZipFile


def valid_bundle_paths(entries):
    tree = {}
    for entry in entries:
        name = entry.filename
        directory = entry.is_dir()
        parts = (name[:-1] if directory else name).split("/")
        if parts[0] != "Clawtrate.app" or any(part in ("", ".", "..") for part in parts) or "\\" in name:
            return False
        kind = stat.S_IFMT(entry.external_attr >> 16)
        if (directory and kind not in (0, stat.S_IFDIR)) or (not directory and kind == stat.S_IFDIR):
            return False
        for depth in range(1, len(parts) + 1):
            spelling = "/".join(parts[:depth])
            key = unicodedata.normalize("NFD", spelling).casefold()
            explicit = depth == len(parts)
            is_directory = not explicit or directory
            if key in tree:
                previous, was_explicit, was_directory = tree[key]
                if previous != spelling or (was_explicit and explicit) or was_directory != is_directory:
                    return False
                explicit = explicit or was_explicit
            tree[key] = spelling, explicit, is_directory
    return True


def mac_executable(binary, size, cpu):
    magic, machine, _, kind, commands, length, _, _ = struct.unpack("<8I", binary.read(32))
    if magic != 0xFEEDFACF or machine != cpu or kind != 2:
        return False
    if not commands or not 8 * commands <= length <= min(size - 32, 1024**2):
        return False
    table = binary.read(length)
    if len(table) != length:
        return False
    text_range = None
    entry = None
    offset = 0
    for _ in range(commands):
        if offset + 8 > length:
            return False
        cmd, cmdsize = struct.unpack_from("<II", table, offset)
        if cmdsize < 8 or cmdsize % 8 or offset + cmdsize > length:
            return False
        if cmd == 0x19:  # LC_SEGMENT_64
            if cmdsize < 72:
                return False
            nsects, = struct.unpack_from("<I", table, offset + 64)
            fileoff, filesize = struct.unpack_from("<QQ", table, offset + 40)
            initprot, = struct.unpack_from("<I", table, offset + 60)
            if cmdsize != 72 + 80 * nsects or fileoff + filesize > size:
                return False
            if table[offset + 8:offset + 24].rstrip(b"\0") == b"__TEXT" and initprot & 4 and filesize:
                if text_range is not None:
                    return False
                text_range = (fileoff, fileoff + filesize)
        elif cmd == 0x80000028:  # LC_MAIN
            if cmdsize != 24 or entry is not None:
                return False
            entry, = struct.unpack_from("<Q", table, offset + 8)
        offset += cmdsize
    return (offset == length and entry is not None and text_range is not None and
            max(text_range[0], 32 + length) <= entry < text_range[1])


def mac_app(path, cpu):
    with ZipFile(path) as archive:
        entries = archive.infolist()
        if sum(e.file_size for e in entries) > 2 * 1024**3 or not valid_bundle_paths(entries):
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
        with archive.open(main) as binary:
            return mac_executable(binary, archive.getinfo(main).file_size, cpu) and archive.testzip() is None



def windows_exe(path, require_amd64=False):
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
        if signature != b"PE\0\0" or machine == 0 or not flags & 2 or flags & 0x2000:
            return False
        headers_end = offset + 24 + length + 40 * sections
        if not 1 <= sections <= 96 or length < 96 or headers_end > size:
            return False
        optional = binary.read(length)
        magic, = struct.unpack_from("<H", optional)
        if magic not in (0x10b, 0x20b) or (magic == 0x20b and length < 112):
            return False
        section_align, file_align = struct.unpack_from("<II", optional, 32)
        image_size, headers_size = struct.unpack_from("<II", optional, 56)
        if not file_align or file_align & (file_align - 1) or section_align < file_align or section_align & (section_align - 1):
            return False
        if not headers_end <= headers_size <= size or headers_size % file_align:
            return False
        if image_size <= headers_size or image_size % section_align:
            return False
        if (machine == 0x014c and magic != 0x10b) or (machine in (0x8664, 0xaa64) and magic != 0x20b):
            return False
        if require_amd64 and (machine != 0x8664 or magic != 0x20b):
            return False
        start, = struct.unpack_from("<I", optional, 16)
        has_entry = False
        for _ in range(sections):
            section = binary.read(40)
            virtual_size, address, count, raw = struct.unpack_from("<4I", section, 8)
            attributes, = struct.unpack_from("<I", section, 36)
            mapped_size = max(virtual_size, count)
            if mapped_size and address + mapped_size > image_size:
                return False
            if count and (raw < headers_size or raw + count > size):
                return False
            if attributes & 0x20000000 and address <= start < address + count:
                has_entry = True
        return has_entry


if __name__ == "__main__":
    key, path = sys.argv[1:3]
    try:
        if key == "unpacked-amd64":
            valid = windows_exe(path, require_amd64=True)
            if valid:
                receipt = Path(sys.argv[3])
                record = json.loads(receipt.read_text(encoding="utf-8"))
                record["unpackedAppMachine"] = "AMD64"
                receipt.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        elif key == "win-x64":
            valid = windows_exe(path)
        else:
            valid = mac_app(path, {"mac-arm64": 0x0100000C, "mac-x64": 0x01000007}[key])
    except Exception:
        valid = False
    if key == "unpacked-amd64" and not valid:
        print("Could not verify and record the unpacked AMD64 app executable.", file=sys.stderr)
    sys.exit(0 if valid else 1)
