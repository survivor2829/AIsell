# T2 实施结果

分支：`codex/register-missing-self-checks`（基于 `codex/fix-apimart-gateway-transport`）。

## 改动

- 在 `desktop/scripts/run-self-checks.cjs` 的主进程自检条目中注册产品视频、数字人和关键词获客三项已有自检。未修改业务代码或自检内容。

## 验证

在 `desktop/` 下执行：

| 命令 | 实际输出 |
|---|---|
| `node src/main/product-video.self_check.cjs` | `product-video self-check passed` |
| `node src/main/digital-human.self_check.cjs` | `digital-human self-check passed: slow-save click, preview gate, approved assets, native voice, packaging resume, unknown guard, restart receipts, protected paths` |
| `node src/main/keyword-acquisition.self_check.cjs` | `keyword acquisition self-check passed (no platform login, sends or paid AI calls)` |
| `npm.cmd run check:self` | 输出中依次包含上述三个自检及对应通过消息；最终 `all source self-checks passed`。|

## 未验证

- 未执行真实产品视频、数字人生成、平台操作、付费调用或安装包验证；本卡仅将已有自检纳入统一检查。

## 对任务卡的异议

无。三项自检在注册前均可独立通过，`run-self-checks.self_check.cjs` 无需修改。
