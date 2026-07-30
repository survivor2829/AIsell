#!/usr/bin/env python3
"""
Stop hook：每轮对话结束前校验 `import app` 是否成功。

触发流程：
  1. Claude 完成一轮回复 → Claude Code 触发 Stop hook
  2. 本脚本从 stdin 读取 JSON（含 stop_hook_active / cwd 等）
  3. 子进程跑 `sys.executable -c "import app"`，cwd=项目根
  4. 成功 → 静默退出 0，本轮正常结束
  5. 失败 → 输出 {"decision":"block","reason":"<stderr尾部>"}，
           Claude Code 把 reason 作为新消息塞给模型，让它继续修复

防护机制：
  - stop_hook_active=true 时直接退出（上一次已 block 过，避免无限循环）
  - 超时 30s、hook 本身异常时一律静默退出，绝不卡 Claude
  - 清空 HTTP/HTTPS/ALL_PROXY，避免 Clash 干扰 import 时的网络初始化

仅在 .claude/settings.local.json 启用（本机 Windows），不进 git，不影响团队。
"""
import json
import os
import subprocess
import sys


def _emit_block(reason: str) -> None:
    """发 decision=block，让模型接着修复；hook 正常退出 0 即可"""
    sys.stdout.write(json.dumps(
        {"decision": "block", "reason": reason},
        ensure_ascii=False,
    ))
    sys.stdout.flush()
    sys.exit(0)


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        # 无法解析的输入：放行，不因 hook 本身的 bug 让 Claude 卡住
        sys.exit(0)

    # 防无限循环：这次停止已经是我们强制唤醒的，第二次就放过
    if data.get("stop_hook_active"):
        sys.exit(0)

    cwd = data.get("cwd") or os.getcwd()

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    # P3 砍刀流后 app.py 启动校验 platform key, hook 跑开发模式绕过校验
    # (生产部署在 .env 配齐 key, 不依赖 FLASK_ENV)
    env.setdefault("FLASK_ENV", "development")
    # import app 不需要代理，清掉避免 Clash 对 DashScope SDK 初始化造成影响
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
              "http_proxy", "https_proxy", "all_proxy"):
        env.pop(k, None)

    try:
        proc = subprocess.run(
            [sys.executable, "-c", "import app"],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        _emit_block(
            "[Stop hook] `python -c \"import app\"` 超过 30 秒未完成，"
            "请检查是否有模块导入死锁、网络阻塞或循环导入。"
        )
        return
    except Exception:
        # hook 本身出错：静默，绝不阻塞用户
        sys.exit(0)

    if proc.returncode == 0:
        sys.exit(0)

    stderr = (proc.stderr or proc.stdout or "").strip()
    if len(stderr) > 1800:
        stderr = "...(前面省略)...\n" + stderr[-1800:]
    if not stderr:
        stderr = f"(subprocess exit={proc.returncode}，stderr 为空)"

    _emit_block(
        "[Stop hook] `python -c \"import app\"` 失败，请先修复再结束本轮：\n\n"
        + stderr
    )


if __name__ == "__main__":
    main()
