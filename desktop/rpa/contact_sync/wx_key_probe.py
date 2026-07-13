#!/usr/bin/env python3
import argparse
import ctypes
import json
import os
import re
import subprocess
import sys
import time


HEX64 = re.compile(r"^[a-fA-F0-9]{64}$")


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
        if len(parts) < 2:
            continue
        try:
            pids.append(int(parts[1]))
        except ValueError:
            pass
    return pids


def load_wx_key(dll_path):
    dll_dir = os.path.dirname(os.path.abspath(dll_path))
    if hasattr(os, "add_dll_directory"):
        os.add_dll_directory(dll_dir)
    dll = ctypes.WinDLL(dll_path)
    dll.InitializeHook.argtypes = [ctypes.c_uint32]
    dll.InitializeHook.restype = ctypes.c_bool
    dll.CleanupHook.argtypes = []
    dll.CleanupHook.restype = ctypes.c_bool
    dll.PollKeyData.argtypes = [ctypes.c_char_p, ctypes.c_int]
    dll.PollKeyData.restype = ctypes.c_bool
    dll.GetStatusMessage.argtypes = [
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.POINTER(ctypes.c_uint32),
    ]
    dll.GetStatusMessage.restype = ctypes.c_bool
    dll.GetLastErrorMsg.argtypes = []
    dll.GetLastErrorMsg.restype = ctypes.c_char_p
    return dll


def text_value(value):
    return (value or b"").decode("utf-8", "ignore")


def last_error(dll):
    try:
        return text_value(dll.GetLastErrorMsg())
    except Exception:
        return ""


def poll_status(dll):
    message = ctypes.create_string_buffer(1024)
    status = ctypes.c_uint32(0)
    if not dll.GetStatusMessage(message, len(message), ctypes.byref(status)):
        return None
    return {"code": status.value, "message": text_value(message.value)}


def poll_key(dll):
    buffer = ctypes.create_string_buffer(256)
    if not dll.PollKeyData(buffer, len(buffer)):
        return ""
    key = text_value(buffer.value).strip()
    return key if HEX64.match(key) else ""


def capture_from_pid(dll, pid, deadline, poll_interval):
    if not dll.InitializeHook(pid):
        return {"ok": False, "key": "", "stage": "init_failed", "error": last_error(dll)}

    stage = "hook_initialized"
    error = ""
    try:
        while time.time() < deadline:
            key = poll_key(dll)
            if key:
                return {"ok": True, "key": key, "stage": "captured"}
            status = poll_status(dll)
            if status:
                stage = "hook_status_%s" % status["code"]
                error = status["message"]
            time.sleep(poll_interval)
        return {"ok": False, "key": "", "stage": stage, "error": error}
    finally:
        try:
            dll.CleanupHook()
        except Exception:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--dll", required=True)
    parser.add_argument("--pid", action="append", type=int, default=[])
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--poll-interval", type=float, default=0.25)
    parser.add_argument("--load-only", action="store_true")
    args = parser.parse_args(argv)

    if sys.platform != "win32" or not os.path.exists(args.dll):
        print(json.dumps({"ok": False, "key": "", "stage": "dll_missing"}))
        return 2

    try:
        dll = load_wx_key(args.dll)
    except Exception:
        print(json.dumps({"ok": False, "key": "", "stage": "dll_load_failed"}))
        return 3

    if args.load_only:
        print(json.dumps({"ok": True, "key": "", "stage": "dll_loaded"}))
        return 0

    deadline = time.time() + max(0.5, args.timeout)
    last_result = {"ok": False, "key": "", "stage": "no_weixin_process"}
    for pid in args.pid or weixin_pids():
        result = capture_from_pid(dll, pid, deadline, max(0.05, args.poll_interval))
        if result.get("ok"):
            print(json.dumps(result))
            return 0
        last_result = result
        if time.time() >= deadline:
            break

    # Do not include the key in failures; errors are stage-only for UI safety.
    print(json.dumps({k: v for k, v in last_result.items() if k != "key"} | {"ok": False, "key": ""}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
