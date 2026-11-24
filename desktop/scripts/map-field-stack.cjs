// 把压缩后的“文件:行:列”翻回源码位置（安全加固①之后发布包去掉了注释和空白）。
// 用法：node scripts/map-field-stack.cjs <版本号> < stack.txt   （或把堆栈作为第二个参数传入）
// 对照表在发布工作区的 desktop/.build/source-maps/<版本号>/（release:sop 记在 .build/release-sop.json；也可用
// XIAOXI_SOURCE_MAP_ROOT 指定）。现场诊断上传时会去掉堆栈，这个工具用于本机日志、错误弹窗截图等拿得到原始堆栈的情况。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { SourceMap } = require("node:module");

function mapStack(text, { version, mapsRoot }) {
  const cache = new Map();
  let mapped = 0;
  const load = (relative) => {
    if (!cache.has(relative)) {
      const file = path.join(mapsRoot, version, `${relative}.map`);
      cache.set(relative, fs.existsSync(file) ? new SourceMap(JSON.parse(fs.readFileSync(file, "utf8"))) : null);
    }
    return cache.get(relative);
  };
  // Matches ...\resources\app\src\main\x.cjs:1:2345 and similar paths inside the packaged app.
  const result = String(text).replace(/(?:[A-Za-z]:)?[^\s()]*?[\\/]app[\\/]((?:src|rpa|remotion-packaging)[\\/][^\s():]+\.(?:cjs|mjs|js)):(\d+):(\d+)/g, (whole, relative, line, column) => {
    const map = load(relative.replaceAll("\\", "/"));
    const entry = map?.findEntry(Number(line) - 1, Number(column) - 1);
    if (!entry || !entry.originalSource) return whole;
    mapped += 1;
    return `${entry.originalSource}:${entry.originalLine + 1}:${entry.originalColumn + 1}`;
  });
  return { text: result, mapped };
}

// The release worktree that release:sop builds in, else this checkout.
function defaultMapsRoot() {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".build", "release-sop.json"), "utf8"));
    if (record.worktree) return path.join(record.worktree, "desktop", ".build", "source-maps");
  } catch { /* no release record on this computer */ }
  return path.join(__dirname, "..", ".build", "source-maps");
}

if (require.main === module) {
  const [version, inline] = process.argv.slice(2);
  if (!version) { console.error("用法：node scripts/map-field-stack.cjs <版本号> [堆栈文本]"); process.exit(2); }
  const mapsRoot = process.env.XIAOXI_SOURCE_MAP_ROOT || defaultMapsRoot();
  if (!fs.existsSync(path.join(mapsRoot, version))) {
    console.error(`找不到 ${version} 的对照表：${path.join(mapsRoot, version)}。请确认版本号，或用 XIAOXI_SOURCE_MAP_ROOT 指向发布工作区的 desktop/.build/source-maps。`);
    process.exit(1);
  }
  const { text, mapped } = mapStack(inline || fs.readFileSync(0, "utf8"), { version, mapsRoot });
  process.stdout.write(`${text}\n`);
  if (!mapped) { console.error("没有可还原的位置：堆栈里没有安装目录 resources/app 下的脚本行列。"); process.exit(1); }
}

module.exports = { mapStack, defaultMapsRoot };
