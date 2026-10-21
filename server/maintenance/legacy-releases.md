# 旧协议固定过渡路由

此能力默认不启用，也不会打开正式客户频道。它只解决签名清单的协议分流，不证明旧安装器、资料保护或失败回退已验收。

## 能力与限制

- 未配置 `releases/<channel>/legacy-routing.json` 时，原 v1/v2 latest 行为保持不变。
- 请求含有效 `X-Xiaoxi-Update-Protocol: 3` 或 `5` 和 `X-Xiaoxi-Version` 时，继续读通常的 `latest.json` / `latest-components.json`。底座头可省略；提供时版本与指纹须完整成对。部分、重复或非法能力头返回 400。普通latest为协议5六组件时，协议3即使带Bridge-Update=1也得到空组件清单，先读取兼容格式完整包；无头且未配置固定路由时同样隐藏六组件。
- 完全没有四个能力头的请求，配置后得到固定 `legacyFull` / `legacyComponents`。返回原 payload 和原签名，不在请求中重签或改写。配置损坏返回 503，不悄悄切回普通清单。错误响应不暴露路径。
- 请求头只用于功能路由，不构成身份或权限证明；不按 IP、安装账号或随机轮换猜版本。单份 v2 只匹配一个底座指纹。
- `sourceVersion` 仅声明桥接起点用于发布核验，**不是服务端能执行的客户筛选条件**。包括其他业务版本在内，所有无头、同底座且满足客户端版本条件的程序都会接受这份桥。启用前须检查这整个范围。其他底座只能得到固定 v1，不能因此宣称 1.1.75、1.1.77 或全部历史版本自动升级通过。

## SSH 管理步骤

1. 使用客户端内置公钥的相同内容，单独配置 `/var/lib/ai-maintenance/releases/<channel>/signing-public.pem`。仅保存公钥，**私钥不上传**。候选配置不能自带、覆盖或指定其他可信密钥。频道值沿用 `test`、`delivery`、`smoke`；本轮只使用 test。
2. 按既有发布流程上传并验证完整包及组件归档，保存到同一个内容摘要寻址的 `artifacts/` 与 `components/`。最终完整包须已正常发布，清单与 latest 或对应历史序号清单完全一致。准备候选 JSON：

   ```json
   {
     "schema": 1,
     "channel": "test",
     "sourceVersion": "1.1.64",
     "legacyFull": {"payload": "原 v1 JSON 字符串", "signature": "原 Base64 签名"},
     "legacyComponents": {"payload": "过渡 v2 JSON 字符串", "signature": "原 Base64 签名"},
     "finalFull": {"payload": "固定最终 v1 JSON 字符串", "signature": "原 Base64 签名"}
   }
   ```

   需要 `legacyFull.version <= legacyComponents.version < finalFull.version`，且 bridge 高于 sourceVersion。例如 79/80/81 是合法顺序，不能把最终 81 直接放到 legacyFull，否则原64会先选完整更新并重现旧助手问题。这些版本仅为协议示例，不表示已发布。

3. 先检查：`python3 /opt/ai-maintenance/legacy_releases.py /受控上传目录/candidate.json --check`。脚本使用系统 OpenSSL 验同一 Ed25519 签名协议，核对频道、应用、版本顺序、序号、完整文件及四个组件的大小和摘要，并检查 application 归档里的 `files/resources/app/src/main/legacy-update-target.json` 与 finalFull 完全一致。组件路径以安装目录为根；缺失、重复或无效目标统一拒绝为 `legacy_embedded_target_mismatch`。
4. 完成同底座兼容、原版两段升级及回退验收后，去掉 `--check` 才启用。脚本使用现有共享 `publish.lock`，在同目录写入并同步临时文件，然后一次性替换包含两个清单的配置。不更新普通 latest，不重新签名，不调用客户数据接口。已有配置不允许版本/序号倒退或同版本重写。原子替换避免部署出现半份配置；不同时间的两个 HTTP 请求仍可能分别发生在一次有意切换前后，因此不要在进行中的桥接验收中反复更换固定路由。
5. 分别读回无头 v1/v2 与协议3 v1/v2，比对 payload 和 signature；核对其他频道仍为空/未变。配置、公钥或制品缺失须修复发布资料，不能通过删除固定配置来隐式放行未验收的完整升级。

`install.sh` / `upgrade.sh` 已包含 `legacy_releases.py`；升级服务本身不会创建路由配置。正常后续发布只推进普通 latest，既有 legacy pair 保持固定；客户端完成桥后使用包内固定最终清单，再由新版本协议3取得后续版本。首次路由加载按签名、文件摘要校验，随后缓存由配置/公钥文件信息识别；已发布的摘要寻址制品必须按既有契约保持不可变。

## 验证记录

`py -m unittest test_legacy_releases test_components -v` 使用临时密钥、临时制品和回环 HTTP，通过固定路由/常规路由/频道隔离、非法头、坏配置拒绝、真实签名校验、版本倒挂、嵌入目标不符、制品损坏和保留旧指针，以及既有组件发布/Range 回归。测试 EXE 是字节夹具，不执行安装器，也不构成客户真实升级成功证据。

另设 `XIAOXI_LEGACY_BRIDGE_ARCHIVE` 为 `desktop/scripts/legacy-update-bridge.self_check.cjs` 输出的 application ZIP 的绝对路径，再运行上述测试，会验证真实归档的 descriptor、目标文件路径/摘要与服务端读取边界。不提供该归档时此项明确跳过。2026-10-12 使用 `desktop/.build/legacy-bridge-protocol/run-qKbKOX/f79746b22c624fdaae546d3db448638ea92d79d5550970e9c89436d737068e2a.zip` 验证；这是源码重建的协议制品，仍不代替原版安装程序与真实升级验收。
