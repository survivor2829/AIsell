// 安全加固①（用户 2026-11-24）：发布包里的主程序、共享代码和微信自动化脚本去掉注释、压掉空白。
// 源码里的设计说明（为什么这样写、试拍结论、提示词考量）不再随安装包发到客户电脑。
// 不改标识符：有几处把函数 toString() 后注入网页执行（抖音、高德、文案抓取），重命名或 keepNames 的辅助函数
// 会让注入的代码在页面里找不到名字。对照表（source map）只写到构建机，不进安装包，用来把现场报错还原到源码行。
// 只处理“应用程序”组件的文件：底座（启动、加载组件）和更新器的文件按指纹校验，改动会被当成损坏或要求整包升级。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SCRIPT = /\.(?:cjs|mjs|js)$/i;

function* scripts(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* scripts(full);
    else if (entry.isFile() && SCRIPT.test(entry.name)) yield full;
  }
}

// The esbuild that ships with vite (no separate dependency to drift); its version is recorded with the maps.
function viteEsbuild() {
  const vite = path.dirname(require.resolve("vite/package.json"));
  return require(require.resolve("esbuild", { paths: [vite] }));
}
// Windows paths: compare resolved, case-folded, with a trailing separator.
const inside = (child, parent) => (path.resolve(child) + path.sep).toLowerCase().startsWith((path.resolve(parent) + path.sep).toLowerCase());

function minifyAppSource(appDir, { version, mapsRoot, directories = ["rpa", "src/main", "src/shared", "remotion-packaging"], include = () => true, esbuild = viteEsbuild() } = {}) {
  if (!version) throw new Error("minifyAppSource needs the release version for its source maps");
  const mapDir = path.join(mapsRoot, version);
  // Maps carry the original comments: never anywhere in the packaged target (resources/app sits two levels down).
  const appRoot = path.resolve(appDir);
  const target = path.basename(appRoot).toLowerCase() === "app" && path.basename(path.dirname(appRoot)).toLowerCase() === "resources"
    ? path.resolve(appRoot, "..", "..") : appRoot;
  if (inside(mapDir, target)) throw new Error("Source maps must stay outside the packaged application");
  const summary = { files: 0, skipped: 0, before: 0, after: 0, mapDir };
  for (const directory of directories) {
    for (const file of scripts(path.join(appDir, directory))) {
      const relative = path.relative(appDir, file).replaceAll("\\", "/");
      if (!include(relative)) { summary.skipped += 1; continue; }
      const source = fs.readFileSync(file, "utf8");
      const result = esbuild.transformSync(source, {
        loader: "js", sourcefile: relative, sourcemap: "external",
        minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false,
        legalComments: "inline", charset: "utf8"
      });
      fs.writeFileSync(file, result.code, "utf8");
      const map = path.join(mapDir, `${relative}.map`);
      fs.mkdirSync(path.dirname(map), { recursive: true });
      fs.writeFileSync(map, result.map, "utf8");
      summary.files += 1;
      summary.before += Buffer.byteLength(source);
      summary.after += Buffer.byteLength(result.code);
    }
  }
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(path.join(mapDir, "minifier.json"), JSON.stringify({ esbuild: esbuild.version, files: summary.files }, null, 2));
  return summary;
}

module.exports = { minifyAppSource };
