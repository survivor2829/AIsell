// 把现场报错里压缩后的“文件:行:列”翻回源码位置（安全加固①之后发布包去掉了注释和空白）。
// 用法：node scripts/map-field-stack.cjs <版本号> < stack.txt   （或把堆栈作为第二个参数传入）
// 对照表在构建机的 .build/source-maps/<版本号>/（可用 XIAOXI_SOURCE_MAP_ROOT 指到发布工作区）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { SourceMap } = require("node:module");

function mapStack(text, { version, mapsRoot }) {
  const cache = new Map();
  const load = (relative) => {
    if (!cache.has(relative)) {
      const file = path.join(mapsRoot, version, `${relative}.map`);
      cache.set(relative, fs.existsSync(file) ? new SourceMap(JSON.parse(fs.readFileSync(file, "utf8"))) : null);
    }
    return cache.get(relative);
  };
  // Matches ...\resources\app\src\main\x.cjs:1:2345 and similar paths inside the packaged app.
  return String(text).replace(/(?:[A-Za-z]:)?[^\s()]*?[\\/]app[\\/]((?:src|rpa|remotion-packaging)[\\/][^\s():]+\.(?:cjs|mjs|js)):(\d+):(\d+)/g, (whole, relative, line, column) => {
    const map = load(relative.replaceAll("\\", "/"));
    const entry = map?.findEntry(Number(line) - 1, Number(column) - 1);
    return entry && entry.originalSource ? `${entry.originalSource}:${entry.originalLine + 1}:${entry.originalColumn + 1}` : whole;
  });
}

if (require.main === module) {
  const [version, inline] = process.argv.slice(2);
  if (!version) { console.error("用法：node scripts/map-field-stack.cjs <版本号> [堆栈文本]"); process.exit(2); }
  const mapsRoot = process.env.XIAOXI_SOURCE_MAP_ROOT || path.join(__dirname, "..", ".build", "source-maps");
  const text = inline || fs.readFileSync(0, "utf8");
  process.stdout.write(mapStack(text, { version, mapsRoot }) + "\n");
}

module.exports = { mapStack };
