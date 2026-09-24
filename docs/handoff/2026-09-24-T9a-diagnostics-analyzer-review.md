# T9a 审查结论：通过，可合并；遗留项并入 T9b

审查对象：`codex/diagnostics-analyzer`（ec13c8c，基线 db328d3）

## 结论

**可以合并，没有阻断级缺陷。** 3 处测试缺口和 2 处低危代码问题交给 T9b 顺手处理（见 T9b 卡顶部"T9a 遗留"）。

## 验证结果

- 独立工作树 `check:self` 全部 87 项通过，新自检约 1 秒（含两次 PowerShell 5.1 采集）。
- 变异 17 个，抓到 14 个。漏掉的 3 个都是测试缺口（T1–T3），代码本身正确。
- 隐私：构造包里放了 API key、手机号、wxid、中文联系人名、聊天文字，分析输出里都没有出现。只有白名单里的枚举字段（`build.buildId`、`code`/`rule_id`/`outcome`）会原样输出，符合设计。
- 分析器不解压，没有路径穿越风险。坏 JSON、BOM、坏 `summary.json` 都会跳过；传入非 zip 时退出码 1。
- 采集工具：
  - PS 5.1 解析 0 错误；中文 APPDATA/OutputRoot 实测能出包，environment 里不含路径；不上传任何东西。
  - zip 内容与 git 中的 .ps1/.cmd 逐字节一致。
  - .cmd 删掉 `Script folder: %~dp0` 是为了不暴露用户名路径，超出卡面"只改提示"的范围，但做法正确。
- 实数据数字：审查代理没有读 D 盘真实包（涉及隐私，被拦截）。result 里贴出的数字与卡片期望值逐项一致。

## 遗留（并入 T9b）

- **T1** 连续失败"遇到成功就断开"没测到：夹具最长串只有 1。改成遇到成功不断开，自检照样通过。
- **T2** "OutputRoot 下没有中间目录"只数了 `.zip` 个数。留下暂存目录的变异，自检照样通过。
- **T3** 查临时路径时用原样字符串 `all.includes(temp)`，但 JSON 里是转义后的 `\`，这条检查永远不会命中。dataRoot 的变异只是靠 USERNAME 检查碰巧抓到。
- **C1** `analyze-diagnostics.cjs:151,:199`：`event` 缺失或不是字符串时 `startsWith` 抛 TypeError，整个分析中断。应改为跳过该行。
- **C4** `Collect-Diagnostics.ps1:150`：`[IO.File]::OpenRead` 不允许与写入者共享。
  - 应用正在追加日志时，采集直接失败，留下残缺 zip，失败日志里还带完整用户路径。
  - 修法：`[IO.File]::Open(src,'Open','Read','ReadWrite,Delete')`；失败时删除残缺 zip；错误信息只写相对名。
- 可选：`Math.max(...values)` 在超过约 13 万个值时溢出（C2）；空包显示 "-Infinity 小时"（C3）；局部变量 `$profile` 遮住了自动变量 `$PROFILE`。
