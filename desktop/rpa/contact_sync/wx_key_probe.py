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
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
LIST_MODULES_ALL = 0x03


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


def module_loaded(pid, module_name):
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    psapi.EnumProcessModulesEx.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.c_uint32,
    ]
    psapi.GetModuleBaseNameW.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_wchar_p,
        ctypes.c_uint32,
    ]

    process = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not process:
        return False
    try:
        modules = (ctypes.c_void_p * 1024)()
        needed = ctypes.c_uint32(0)
        if not psapi.EnumProcessModulesEx(process, modules, ctypes.sizeof(modules), ctypes.byref(needed), LIST_MODULES_ALL):
            return False
        count = min(len(modules), needed.value // ctypes.sizeof(ctypes.c_void_p))
        for index in range(count):
            name = ctypes.create_unicode_buffer(260)
            if psapi.GetModuleBaseNameW(process, modules[index], name, len(name)) and name.value.lower() == module_name.lower():
                return True
        return False
    finally:
        kernel32.CloseHandle(process)


def wait_for_module(pid, module_name, deadline):
    # ponytail: poll tightly only during startup; widening this window recreates the login race.
    while time.time() < deadline:
        if module_loaded(pid, module_name):
            return True
        time.sleep(0.001)
    return False


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


def capture_from_pid(dll, pid, deadline, poll_interval, resume=None):
    if not dll.InitializeHook(pid):
        return {"ok": False, "key": "", "stage": "init_failed", "error": last_error(dll)}

    stage = "hook_initialized"
    error = ""
    try:
        if resume and not resume():
            return {"ok": False, "key": "", "stage": "resume_failed", "error": ""}
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


def lifecycle_self_check():
    events = []

    class FakeDll:
        def InitializeHook(self, pid):
            events.append("hook")
            return pid == 123

        def PollKeyData(self, buffer, size):
            events.append("poll")
            buffer.value = b"a" * 64
            return True

        def CleanupHook(self):
            events.append("cleanup")
            return True

    result = capture_from_pid(
        FakeDll(),
        123,
        time.time() + 1,
        0.01,
        lambda: events.append("resume") or True,
    )
    return result.get("ok") is True and events == ["hook", "resume", "poll", "cleanup"]


def launch_wechat(exe_path):
    return subprocess.Popen([exe_path])


def suspend_process(process):
    return ctypes.windll.ntdll.NtSuspendProcess(ctypes.c_void_p(int(process._handle))) == 0


def resume_process(process):
    return ctypes.windll.ntdll.NtResumeProcess(ctypes.c_void_p(int(process._handle))) == 0


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--dll", required=True)
    parser.add_argument("--pid", action="append", type=int, default=[])
    parser.add_argument("--exe")
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
    launched = None
    suspended = False
    if args.exe:
        if not os.path.isfile(args.exe):
            print(json.dumps({"ok": False, "key": "", "stage": "wechat_exe_missing"}))
            return 4
        try:
            launched = launch_wechat(args.exe)
        except Exception:
            print(json.dumps({"ok": False, "key": "", "stage": "wechat_launch_failed"}))
            return 5

    def resume_launched():
        nonlocal suspended
        if not launched or not suspended:
            return True
        if not resume_process(launched):
            return False
        suspended = False
        return True

    try:
        pids = [launched.pid] if launched else (args.pid or weixin_pids())
        if launched:
            module_deadline = min(deadline, time.time() + 15)
            if not wait_for_module(launched.pid, "Weixin.dll", module_deadline):
                last_result = {"ok": False, "key": "", "stage": "weixin_dll_timeout", "error": "Weixin.dll did not load before hook setup"}
                pids = []
            elif not suspend_process(launched):
                last_result = {"ok": False, "key": "", "stage": "suspend_failed", "error": ""}
                pids = []
            else:
                suspended = True

        for pid in pids:
            result = capture_from_pid(
                dll,
                pid,
                deadline,
                max(0.05, args.poll_interval),
                resume_launched if launched else None,
            )
            if result.get("ok"):
                print(json.dumps(result))
                return 0
            last_result = result
            if time.time() >= deadline:
                break
    finally:
        resume_launched()

    # Do not include the key in failures; errors are stage-only for UI safety.
    print(json.dumps({k: v for k, v in last_result.items() if k != "key"} | {"ok": False, "key": ""}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
