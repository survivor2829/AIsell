# 2026-10-24 网关部署：结构化仿写与原创度检查

## 部署了什么

- PR #75（`bb25632`）中 `server/provider-gateway/service.py` 的写稿改动：有参考爆款时先拆结构再用产品资料重写；连续 8 字以上照抄占比超过 15% 时，在同一操作、同一额度内重写一次，仍超就返回 `script_not_original`；重写调用失败返回 `script_rewrite_failed`。
- 用户在会话中明确授权部署。部署前服务器无 8444 端口的活动连接。

## 重要：服务器代码与 main 不一致

- 服务器上的 `service.py` 在 10-21 由工作区快照部署，带有 `/local-acquisition/catalog`、`/local-acquisition/sync/*` 及其他 `/local-acquisition/*` 路由，依赖服务器上的 `local_acquisition.py`、`acquisition_sync.py`、`precise-public-sources.json`。
- 这些路由在 PR #49（`95df750`，“获客聚焦地图”）已从 main 撤下，但服务器一直未同步，已安装的旧版客户端可能仍在调用。
- 因此本次**没有用 main 的 `service.py` 覆盖**，而是以服务器现行文件为底，只叠加本次写稿补丁（+90/−8，补丁干净应用）。`material_search.py` 与 main、服务器三者一致。
- 后续部署网关前，先比对服务器 `service.py` 与将要部署的版本；撤下 `/local-acquisition/*` 需要用户确认旧客户端已不再依赖。

## 证据

| 项目 | 值 |
|---|---|
| 部署 `service.py` SHA-256 | `37f6172ab05326291ea4b29343700e05008be2a04dc5b86ffeb81dc4256ed145` |
| `material_search.py` SHA-256 | `8e992c0d364be5ab443430b0c97f2d14762d178d2ebac4dd646914ca943625b6` |
| 服务器备份 | `/var/lib/ai-provider-gateway/backups/20261024T084810Z-986637` |
| 部署方式 | 现有 `upgrade.sh`（先备份，健康检查失败自动回滚），退出码 0 |

- 部署前本地用叠加后的文件加服务器上的两个获客模块，跑 `test_narration_script_routes`、`test_service`、`test_digital_human_routes`、`test_voice_clone_routes`、`test_bailian_video_routes`、`test_material_search`，共 40 项通过。
- 部署后：服务 active，`/health` 返回 ok；未认证访问 `narration/script-quota`、`narration/script`、`local-acquisition/catalog`、`local-acquisition/sync/pull` 均为 401（路由存在且受认证保护）。
- 未做：真实写稿调用（会使用写稿额度），留到一键成片真实验收时一起验证。

## 回滚

在服务器上用备份目录中的 `service.py` 覆盖 `/opt/ai-provider-gateway/service.py` 并重启 `ai-provider-gateway`；回执数据库不受影响。
