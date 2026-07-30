---
name: deploy
description: Push current branch to git, then SSH into Tencent Cloud and restart docker-compose. Confirms with user before any push or SSH.
argument-hint: "[commit-message]"
model: sonnet
allowed-tools:
  - Bash
  - Read
---

# Deploy to Tencent Prod

Deploys the current branch to the Tencent Cloud Ubuntu host running this app under docker-compose.

## ⚠️ Confirmation required

This skill PUSHES code AND restarts production. Confirm with user before each network step.

## Step 1 — Check git state

```bash
git status --short
git log -1 --oneline
```

If working tree is dirty:
- If user provided `$1` (commit message): `git add -A && git commit -m "$1"`
- Otherwise: STOP and ask user how to handle uncommitted changes.

## Step 2 — Push (ASK FIRST)

Ask: "Push current branch to origin? (y/n)"

On confirm:
```bash
git push
```

## Step 3 — SSH and 智能 deploy (ASK FIRST)

Ask: "SSH to tencent-prod and deploy? (y/n)"

⚠️ **2026-05-09 OOM 事故教训**: prod 直接 `docker compose up -d --build` 会撑死 4G VPS
(build 进程逃出 mem_limit 约束, chromium 解压峰值 1-2GB → OOM thrashing → 强制重启).

⚠️ **2026-05-12 deploy 不生效教训** (本人踩过的坑):
docker-compose web service **没 bind mount 代码目录** (除 `./instance`), 所以 .py / templates /
static 改动**全部走镜像 COPY**. `docker compose restart` 不重建镜像 → 跑的还是旧代码.
旧 deploy 逻辑判 "纯 Python → restart" 是**错的**, 等于空操作.

**新流程: 默认 hot-patch (0 OOM 风险, 立即生效), 标记需要后续 build 固化进镜像**:

- **Hot-patch 路径** (默认):
  `docker cp` 改动文件进 container + `restart` → 立即生效, 0 build, 0 OOM.
  缺点: 不持久, 重建 container 会丢, 必须后续 `--build` 固化.

- **Full build 路径** (仅 Dockerfile / requirements 改动时强制走):
  `docker compose up -d --build` 改动写镜像. 有 OOM 风险, 4G VPS 慎用.

On confirm:
```bash
ssh tencent-prod << 'REMOTE'
  set -e
  cd /root/clean-industry-ai-assistant
  git pull
  CHANGED=$(git diff HEAD@{1} HEAD --name-only)
  if echo "$CHANGED" | grep -qE '^(Dockerfile|requirements.*\.txt|playwright|docker-compose)'; then
    echo '[deploy] Dockerfile/requirements/compose 改动 → 必须 --build (注意 OOM 风险)'
    echo '[deploy] 建议: 低负载时段执行; 4G VPS 升硬件 / PR-B 镜像仓库 pull 是中期路径'
    docker compose up -d --build
  else
    echo '[deploy] 代码/template/static 改动 → hot-patch (docker cp + restart, 0 OOM)'
    CONTAINER=clean-industry-ai-assistant-web-1
    for f in $CHANGED; do
      if [ -f "$f" ] && echo "$f" | grep -qE '\.(py|html|css|js|json|txt|yml|svg|md)$'; then
        docker cp "$f" "$CONTAINER:/app/$f" 2>/dev/null && echo "  ✓ cp $f"
      fi
    done
    echo '[deploy] ⚠ hot-patch 临时生效, 重建 container 会丢. 低负载时段跑 `docker compose up -d --build` 固化.'
    docker compose restart web
  fi
  sleep 5
  docker compose ps
REMOTE
```

Expected: container shows `Up X (healthy)`. `Restarting` / `Exit` / `(unhealthy)` = fail.

After hot-patch deploy, verify code reached container (sanity check):
```bash
ssh tencent-prod "docker exec clean-industry-ai-assistant-web-1 grep -c '<changed-keyword>' /app/<changed-file>"
# 期望 count > 0; = 0 说明 cp 失败需排查
```

## Step 4 — Health check

```bash
ssh tencent-prod "curl -s http://localhost:5000/ -o /dev/null -w '%{http_code}'"
ssh tencent-prod "docker compose logs --tail=30 web"
```

Expected: HTTP 200 + no traceback in logs.

## Step 5 — Report

```
[deploy] OK
- branch: main
- commit: <sha> <message>
- container: up
- health: 200
- logs: clean
```

Any failure → report the failed step + relevant log excerpt + STOP.
