# Remotion 运行时许可证与交付门禁

本目录只记录本机已安装依赖的事实和构建门槛，不代表法律意见，也不自动确认任何主体具备免费或商业使用资格。

## 本地许可证来源

- Remotion `4.0.512` 的实际许可文本来自 `node_modules/remotion/LICENSE.md`；`@remotion/renderer` 与 `@remotion/bundler` 包内也携带同名文本。
- React、React DOM 及其他 npm 依赖的许可标识和包内许可证文件由 `build-remotion-runtime.cjs` 从当前 lockfile 与实际安装目录生成到确定性的 SBOM/第三方许可证清单中。
- Windows x64 compositor 包当前没有可由脚本确认的独立 `license` 字段或包内许可证文件，因此清单会保留 `NOASSERTION`，不能据此推断额外权利。
- 浏览器不来自 npm 闭包。任何携带浏览器的制品都必须提供真实来源、版本、SHA-256、适用条款以及内部再分发依据；商业交付还必须提供商业再分发依据。

## 三类制品

- `development`：不复制浏览器，只能使用调用者显式提供的本机 Edge/Chrome 路径；不构成可再分发制品。
- `internal-evaluation`：可用于非商业内部评估，但只有在浏览器来源和内部再分发依据已由真实确认人记录后才允许携带浏览器。
- `delivery`：必须同时具备适用于当前主体和 Remotion `4.0.512` 的书面许可依据、浏览器商业再分发依据、干净提交和完整性校验；installer 只接受此类型。

`runtime-license-record.template.json` 是空模板，不是许可确认。填写后通过 `--license-record` 或 `XIAOXI_REMOTION_LICENSE_RECORD` 传入；浏览器文件通过 `--browser` 或 `XIAOXI_REMOTION_BROWSER_SOURCE_PATH` 传入。记录不得包含 license key、API key、token 或其他秘密。

当前仓库没有安装程序代码签名基础，`signed` 字段继续为 `false`。installer 必须在 delivery 便携包生成后、安装程序生成前，在 `release/` 之外取得独立签名的信任记录，并通过 `XIAOXI_RELEASE_TRUST_RECORD`、`XIAOXI_RELEASE_TRUST_PUBLIC_KEY` 和 `XIAOXI_RELEASE_TRUST_PUBLIC_KEY_SHA256` 指定记录、公钥和受信公钥摘要。记录同时约束便携包清单、完整目录树、Remotion runtime descriptor 和 runtime manifest 摘要；所以 `release:installer` 只消费已经签名确认的 delivery 便携包，不会在验签前重新构建它。构建脚本只验签，不生成签名，也不接触私钥；该信任记录不能描述成安装程序代码签名。


## 本地 Noto Emoji 图像

Copyright Google LLC. Source: https://github.com/googlefonts/noto-emoji

本项目只内嵌 `svg/` 图像，不包含字体。固定源版本及各图 SHA-256 见 `narration-emoji.json`。图像以 Apache License 2.0 分发，图像数据未修改。

Copyright 2013 Google, Inc. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
