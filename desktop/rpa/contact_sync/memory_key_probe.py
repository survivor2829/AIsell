#!/usr/bin/env python3
import argparse
import ctypes
import ctypes.wintypes as wt
import hashlib
import hmac
import json
import os
import re
import struct
import subprocess
import sys


PAGE_SIZE = 4096
SALT_SIZE = 16
KEY_SIZE = 32
RESERVE_SIZE = 80
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80}
HEX_KEY_PATTERN = re.compile(rb"x'([0-9a-fA-F]{64,192})'")


kernel32 = ctypes.windll.kernel32


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_uint64),
        ("AllocationBase", ctypes.c_uint64),
        ("AllocationProtect", wt.DWORD),
        ("_pad1", wt.DWORD),
        ("RegionSize", ctypes.c_uint64),
        ("State", wt.DWORD),
        ("Protect", wt.DWORD),
        ("Type", wt.DWORD),
        ("_pad2", wt.DWORD),
    ]


def weixin_pids():
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq Weixin.exe", "/FO", "CSV", "/NH"],
        capture_output=True,
        text=True,
    )
    pids = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.strip('"').split('","')
        if len(parts) >= 2:
            try:
                pids.append(int(parts[1]))
            except ValueError:
                pass
    return pids


def read_memory(handle, address, size):
    buffer = ctypes.create_string_buffer(size)
    read = ctypes.c_size_t(0)
    if kernel32.ReadProcessMemory(handle, ctypes.c_uint64(address), buffer, size, ctypes.byref(read)):
        return buffer.raw[: read.value]
    return b""


def regions(handle):
    address = 0
    mbi = MBI()
    while address < 0x7FFFFFFFFFFF:
        if kernel32.VirtualQueryEx(handle, ctypes.c_uint64(address), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
            break
        readable = mbi.State == MEM_COMMIT and mbi.Protect in READABLE and 0 < mbi.RegionSize < 500 * 1024 * 1024
        if readable:
            yield mbi.BaseAddress, mbi.RegionSize
        next_address = mbi.BaseAddress + mbi.RegionSize
        if next_address <= address:
            break
        address = next_address


def verify_key(key_bytes, page1):
    salt = page1[:SALT_SIZE]
    mac_salt = bytes(byte ^ 0x3A for byte in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", key_bytes, mac_salt, 2, dklen=KEY_SIZE)
    hmac_data = page1[SALT_SIZE : PAGE_SIZE - RESERVE_SIZE + 16]
    stored = page1[PAGE_SIZE - 64 : PAGE_SIZE]
    digest = hmac.new(mac_key, hmac_data, hashlib.sha512)
    digest.update(struct.pack("<I", 1))
    return hmac.compare_digest(digest.digest(), stored)


def find_key_near_raw_salt(block, salt_raw, page1):
    start = 0
    while True:
        pos = block.find(salt_raw, start)
        if pos == -1:
            return ""
        window = block[max(0, pos - 512) : min(len(block), pos + 512)]
        for offset in range(0, max(0, len(window) - KEY_SIZE + 1)):
            candidate = window[offset : offset + KEY_SIZE]
            if candidate == b"\x00" * KEY_SIZE:
                continue
            if verify_key(candidate, page1):
                return candidate.hex()
        start = pos + 1


def matching_key_candidates(block, salt_hex):
    for match in HEX_KEY_PATTERN.finditer(block):
        value = match.group(1).decode("ascii").lower()
        if len(value) == 64:
            yield value
        elif len(value) >= 96 and value[-32:] == salt_hex:
            yield value[:64]


def scan_process(pid, salt_hex, page1):
    handle = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not handle:
        return ""
    salt_raw = bytes.fromhex(salt_hex)
    try:
        for base, size in regions(handle):
            offset = 0
            carry = b""
            while offset < size:
                chunk_size = min(8 * 1024 * 1024, size - offset)
                data = read_memory(handle, base + offset, chunk_size)
                if data:
                    block = carry + data
                    for key_hex in matching_key_candidates(block, salt_hex):
                        if verify_key(bytes.fromhex(key_hex), page1):
                            return key_hex
                    key_near_salt = find_key_near_raw_salt(block, salt_raw, page1)
                    if key_near_salt:
                        return key_near_salt
                    carry = block[-1024:]
                offset += chunk_size
    finally:
        kernel32.CloseHandle(handle)
    return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--contact-db", required=True)
    parser.add_argument("--pid", action="append", type=int, default=[])
    args = parser.parse_args()

    if sys.platform != "win32" or not os.path.exists(args.contact_db):
        print(json.dumps({"ok": False, "key": ""}))
        return 2

    with open(args.contact_db, "rb") as file:
        page1 = file.read(PAGE_SIZE)
    if len(page1) < PAGE_SIZE:
        print(json.dumps({"ok": False, "key": ""}))
        return 3

    salt_hex = page1[:SALT_SIZE].hex()
    for pid in args.pid or weixin_pids():
        key = scan_process(pid, salt_hex, page1)
        if key:
            print(json.dumps({"ok": True, "key": key}))
            return 0

    print(json.dumps({"ok": False, "key": ""}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
