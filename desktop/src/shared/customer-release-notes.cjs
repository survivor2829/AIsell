const catalog = require("./customer-release-notes.json");
const { VERSION } = require("./cloud-contract.cjs");

function releaseNotes(version, entries = catalog) {
  const entry = entries[version];
  if (!VERSION.test(version) || !entry || !Array.isArray(entry.changes) || !entry.changes.length
      || !entry.changes.every(line => typeof line === "string" && line.trim().length >= 12)
      || (entry.limitations !== undefined && (!Array.isArray(entry.limitations)
        || !entry.limitations.every(line => typeof line === "string" && line.trim())))) {
    throw Error(`版本 ${version} 缺少具体更新公告，请填写 src/shared/customer-release-notes.json。`);
  }
  const notes = [`${version} 更新内容`, ...entry.changes.map(line => `• ${line.trim()}`),
    ...(entry.limitations?.length ? ["验证范围与注意事项", ...entry.limitations.map(line => `• ${line.trim()}`)] : [])].join("\n");
  if (notes.length > 2000) throw Error(`版本 ${version} 更新公告超过 2000 字。`);
  return notes;
}

function matchingReleaseNotes(version, supplied) {
  const notes = releaseNotes(version);
  if (supplied && supplied.trim().replace(/\r\n/g, "\n") !== notes) {
    throw Error(`版本 ${version} 发布公告与安装包内公告不一致，请先更新版本公告并重新构建。`);
  }
  return notes;
}
module.exports = { releaseNotes, matchingReleaseNotes };
