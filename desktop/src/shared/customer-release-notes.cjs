const catalog = require("./customer-release-notes.json");
const dates = require("./customer-release-dates.json");
const { VERSION, compareVersions } = require("./cloud-contract.cjs");

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
function bundledAnnouncements(version) {
  if (!VERSION.test(version)) return [];
  // Versions before 1.1.0 were written up later for the history; they were never news to anyone.
  return Object.keys(catalog).filter(candidate => VERSION.test(candidate) && compareVersions(candidate, version) <= 0 && compareVersions(candidate, "1.1.0") >= 0)
    .sort((left, right) => compareVersions(right, left)).slice(0, 20)
    .map(candidate => ({ version: candidate, notes: releaseNotes(candidate) }));
}
// Every version up to this one, oldest included, for the history in the announcements panel. Only what changed:
// the notes of a long-superseded version about what had not been verified then no longer say anything useful.
function releaseHistory(version) {
  if (!VERSION.test(version)) return [];
  return Object.keys(catalog).filter(candidate => VERSION.test(candidate) && compareVersions(candidate, version) <= 0)
    .sort((left, right) => compareVersions(right, left))
    .map(candidate => ({ version: candidate, date: dates[candidate] || "", notes: catalog[candidate].changes.map(line => `• ${String(line).trim()}`).join("\n") }));
}
module.exports = { releaseNotes, matchingReleaseNotes, bundledAnnouncements, releaseHistory };
