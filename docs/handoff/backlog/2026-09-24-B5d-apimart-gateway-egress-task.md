# B5d 网关 APIMart 出站：用长期出站取代开发机 SSH 回环通道

> **状态：暂缓（用户 2026-09-24 决定）**。过渡期继续用开发电脑中转，也就是 `启动内部开发版.cmd` 或 `npm.cmd run desktop` 自动建立的 SSH 回环隧道，视频和数字人只在开发电脑上做内部测试。等产品效果视频、数字人跑通后再选长期方案，届时 Claude 按所选方案重写本卡。Codex 现在不要开工。
> - Claude 的倾向：方案 D（改用火山方舟官方 Seedance，国内直连）。价格基本一致（方舟 480p 0.67 元/秒，APIMart 约 0.68 元/秒），没有跨境链路，人脸不出境，还能用 Draft 模式。网关已有方舟凭据和生图路由。
> - 用户确认过的事实：9-22 那条 12 秒数字人样片是经开发电脑中转生成的（任务 `dh_d0500063…`，20:27–21:18；中转在 20:13 接通）。

分支：`codex/apimart-long-term-egress`

## 顺序与依赖

- 与其他卡没有代码依赖，可以随时开工。
- **文件重叠**：
  - `server/provider-gateway/README.md`：B4a 也改，但改的是路由列表和凭证两节，本卡只改"APIMart 专用出站"一节；
  - `desktop/scripts/run-self-checks.cjs`：T2 等卡也在这里注册自检。
  - 后合并的一方 rebase。
- **不改 `service.py`**：B4a 卡以为出站卡会改 `service.py`，其实按推荐方案 A 不需要。只有方案 E 需要改。
- 服务器部署由用户授权后执行。建议在用户完成服务器切换并验收通过后再合并本卡，原因见第 3 步。

## 背景

- **影响面**：网关服务器（测试网关 `115.159.88.100`，见 `desktop/src/main/cloud-config.cjs:8`）无法直连 `api.apimart.ai`。报告记录的现象：
  - 域名解析到错误地址，连接超时；
  - 用正确的 Cloudflare 地址连接，在 TLS 阶段被重置（`docs/reports/2026-09-22-digital-human-gateway.md:20-22`）。

  目前全部 APIMart 路由都受影响：数字人、产品视频，以及 `028a847` 之后改走网关的产品详情图（同报告 :32）。
- **现在的通道**：
  - 开发机把本机代理 `127.0.0.1:7890` 通过 `ssh -R` 转发到服务器回环 `127.0.0.1:47891`（`desktop/scripts/apimart-test-relay.cjs:8,41-50`）；
  - 服务器环境文件设置了 `XIAOXI_GATEWAY_APIMART_PROXY_URL=http://127.0.0.1:47891`（报告 :53-54）；
  - 这条通道在 `npm.cmd run desktop` 和内部开发版启动时自动建立（`scripts/dev-electron.cjs:26`、`scripts/launch-internal-development.cjs:5`），开发机下线就中断（报告 :40、:56）。
- **网关已具备 APIMart 专用出站能力**，不需要改转发逻辑（`server/provider-gateway/service.py:149-183`、:294、:659-660）：
  - 只接受 `http://` 形式的 CONNECT 代理；
  - 不走系统代理，也不回退到直连；
  - 禁止重定向；
  - 与 APIMart 之间仍是端到端 TLS，并校验证书。

  README 明确禁止把工作站转发当作长期依赖（`server/provider-gateway/README.md:38-50`）。
- **出站中断的后果**：网关返回 503（`service.py:680-684`）。桌面端收到 503 时，POST 会进入 `outcome_unknown`（`desktop/src/main/digital-human-provider.cjs:143`），不会重发，这是安全的；但任务会卡住等人工处理。所以出站必须稳定。

## 方案（先由用户拍板）

| 方案 | 做法 | 优点 | 代价与风险 | 代码改动 |
|---|---|---|---|---|
| **A 自建境外出口，走常驻加密隧道（推荐，见下）** | 我们自己的香港或新加坡小型云主机只运行 CONNECT 代理，只放行 `api.apimart.ai:443`，只监听本机回环。网关服务器用 systemd 常驻 `ssh -N -L 127.0.0.1:47892:127.0.0.1:3128` 连过去，环境变量指向 `http://127.0.0.1:47892` | 网关代码不用改；密钥仍只在网关；代理不暴露到公网，也没有明文代理口令 | 主机月费；跨境链路可能限速或中断；**境内服务器自建跨境通道的合规性需要用户确认** | 只加运维模板和检查脚本 |
| B 境外再部署一个只含 APIMart 路由的网关 | 桌面端按能力选择网关地址 | 不需要隧道 | 桌面网关客户端要支持多个地址；授权和回执库要跨实例；维护两套 | 大，需另开卡 |
| C 持牌运营商跨境专线或企业加速 | 为网关服务器提供合规出口 | 合规性最好 | 费用高，开通周期长 | 与 A 相同，只改环境变量 |
| D 改走火山方舟官方 Seedance（国内直连） | 网关已有方舟路由和凭据（`service.py:615-616`）；据调研，方舟上有 2.5 和真人私有素材库 | 没有跨境问题；可以用 Draft 模式 | 属于换供应商：请求格式、素材库、价格、回执都要重做 | 大，需另开卡评估 |
| E 向 APIMart 询问境内可达的官方接入域名 | 如果有，只需放行这个域名 | 最省事 | 不一定有；`_official_origin` 把主机固定为 `api.apimart.ai`（`service.py:119-133`、:286），需要小改并加测试 | 小 |

排除项：只改 DNS 或 hosts 不可行，因为用正确的地址连接仍会被 TLS 重置（报告 :21）。

**建议**：先按 A 恢复可用，同时开卡评估 D（它能同时消除跨境通道和人脸、产品图出境两个合规问题）。

以下"要做"按 A 编写：
- 如果用户选 C，只做第 2、3 步；
- 如果用户选 E，另写一张小卡；
- 如果用户选 B 或 D，本卡作废，另开卡。

## 要做（Codex 只写代码和模板，不部署）

1. **新增 `server/provider-gateway/apimart-egress/` 运维模板**。模板里不含任何主机地址、密钥或口令，这些只放在 `/etc/ai-maintenance/`。
   - `apimart-egress-tunnel.service`：
     - 使用独立的低权限用户；
     - 命令为 `ssh -N -L 127.0.0.1:47892:127.0.0.1:3128`；
     - 选项：`ExitOnForwardFailure=yes`、`ServerAliveInterval=15`、`ServerAliveCountMax=3`、`StrictHostKeyChecking=yes`，并固定 known_hosts；
     - `Restart=always`、`RestartSec=5`；
     - 密钥路径指向 `/etc/ai-maintenance/`。
     - **端口用 47892，不要复用 47891**，避免切换期间和开发机通道冲突。
   - 境外节点的代理配置（squid 或 tinyproxy，你选一种）：
     - 只监听 `127.0.0.1:3128`；
     - 只允许 CONNECT 到 `api.apimart.ai:443`，其余全部拒绝；
     - 日志不记录请求内容。
   - `authorized_keys` 示例：使用 `restrict`，只开 `port-forwarding` 并限定 `permitopen="127.0.0.1:3128"`，不给 shell。
   - 可选：一个 systemd timer 模板，每 10 分钟运行一次第 2 步的无密钥检查。
   - `README.md`，写明以下步骤：
     1. 部署；
     2. 把环境变量切换为 `http://127.0.0.1:47892`；
     3. 回滚：把该环境变量清空，并重启网关；
     4. 验收。
2. **新增 `server/provider-gateway/check_apimart_egress.py`**：
   - 使用 `GatewayConfig.from_environment()` 的 `apimart_open`，保证与线上请求走同一条出站路径。
   - 支持 `--env-file /etc/ai-maintenance/provider-gateway.env`：
     - 在进程内只读解析这个文件，不经过命令行或 shell 展开，不回显任何值；
     - 无密钥模式只取 `XIAOXI_GATEWAY_APIMART_PROXY_URL`。
   - 默认只发一个不带密钥的 GET，目标固定为 `https://api.apimart.ai/v1/seedance2/private-avatar/assets`，也就是报告 :33、:55 中用过的免费素材列表。收到 401 即判定"已到达供应商认证层"。
   - `--with-key` 时，用内存中的现有密钥对素材列表发一次 GET，期望 200。只打印状态码和耗时，不打印响应正文，也不打印密钥。
   - 任何情况下都不发 POST。
   - 失败时分类输出：dns / connect / tls / timeout / http。
   - 新增 `test_apimart_egress.py`，使用假的 opener，不访问网络。
3. **开发机通道改为显式开启**：
   - `apimart-test-relay.cjs` 只在 `XIAOXI_APIMART_DEV_RELAY=1` 时启动；
   - 未开启时，只输出一行"开发机 APIMart 通道未启用"，不连接 SSH；
   - `startApimartTestRelay` 增加可注入的 `spawn` 参数，默认用 `node:child_process` 的 `spawn`。这样自检能断言"没有启动子进程"；
   - 新增 `desktop/scripts/apimart-test-relay.self_check.cjs`：
     - 注入临时的 `SystemRoot`（内含空文件 `System32/OpenSSH/ssh.exe`）、临时密钥文件和假 `spawn`；
     - 不读取真实的 `~/.ssh` 密钥，不发起真实 SSH；
     - 先断言 `relaySettings`，再调用 `startApimartTestRelay`；每次调用后都执行 `stop()`，不留重连定时器；
   - 在 `run-self-checks.cjs` 注册。

## 允许改动

- `server/provider-gateway/apimart-egress/`（新增）
- `server/provider-gateway/check_apimart_egress.py`、`test_apimart_egress.py`（新增）
- `server/provider-gateway/README.md`：只改"APIMart 专用出站"一节
- `desktop/scripts/apimart-test-relay.cjs`、新增的 `apimart-test-relay.self_check.cjs`、`desktop/scripts/run-self-checks.cjs`

## 禁止

- 不改 `service.py` 的转发、回执和结果不明规则。503 仍按结果不明处理，不重发，也不换线路重发。
- 不关闭 TLS 校验，不允许 `https://` 代理降级，不改系统 DNS 或系统代理。
- 不把任何主机地址、密钥或代理口令写进仓库。
- 不登录服务器，不部署，不发起任何网络请求（包括免费 GET）。
- 不运行 `npm.cmd run desktop`、`启动内部开发版.cmd`，也不直接运行 `apimart-test-relay.cjs`。在本卡合并前，这些都会用本机密钥建立到测试服务器的 SSH 通道。

## 验收（新增断言在当前 HEAD 258e37a 上必须失败）

1. `apimart-test-relay.self_check.cjs`：
   - 没有设置 `XIAOXI_APIMART_DEV_RELAY` 时：
     - `relaySettings` 返回 null（在 HEAD 上，同样的临时环境会返回配置）；
     - 假 `spawn` 调用次数为 0。
   - 设置为 1 时，`relaySettings` 返回的配置与 HEAD 一致，假 `spawn` 收到的参数含 `-R`，其后是以 `127.0.0.1:47891:` 开头的转发。
2. `test_apimart_egress.py`：
   - 请求走的是注入的 `apimart_open`，而不是 `upstream_open`；
   - 全程没有 POST；
   - 输出中不含密钥和代理地址；
   - 401、200、URLError（dns/connect/tls）、超时、其他 HTTP 状态分别得到对应的分类；
   - `--env-file` 的解析用临时文件测试，不读 `/etc`。
3. 以下命令通过：
   - 在 `server/provider-gateway` 下运行 `python -m unittest test_apimart_egress test_service test_digital_human_routes`；
   - `npm.cmd run check:self`。

## 需用户本人授权 / 验收

1. 在 A–E 中选定方案，并确认对应的合规事项：
   - 跨境通道本身；
   - 客户人脸和产品图经 APIMart 出境，这一点与走哪条线路无关。
2. 购买或提供境外主机，在两台服务器上按模板部署。
3. 修改 `/etc/ai-maintenance/provider-gateway.env` 中的 `XIAOXI_GATEWAY_APIMART_PROXY_URL`，然后重启网关。按现有做法先备份，失败时自动恢复。
4. 在服务器上运行验收，全程不发付费请求：
   - 无密钥检查返回 401；
   - `--with-key` 返回 200（这一步需要读取密钥，须授权）；
   - 关闭开发机后，桌面端的"数字人预检"依然通过；
   - 手动停掉隧道时，检查脚本报 connect，桌面"数字人预检"得到 503 并停在"需要处理"，全程没有任何 POST；
   - 连续 24 小时，每 10 分钟做一次无密钥检查，成功率 ≥99%。
5. 以上都通过后再合并本卡；此后开发机默认不再建立 SSH 通道。
