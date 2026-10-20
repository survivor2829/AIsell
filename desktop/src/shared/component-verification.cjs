// Classification is part of the fixed, verified bootstrap. Unknown paths remain
// startup-critical; a manifest cannot label arbitrary executable code as media.
const { treeHash, HEX } = require("./component-contract.cjs");
const GROUPS = ["startup", "content", "detail", "media"];
function groupForPath(relative) {
  if (relative.startsWith("resources/content-engine/") || relative.startsWith("remotion-packaging/")) return "content";
  if (relative.startsWith("resources/product-detail/")) return "detail";
  if (/^resources\/app\/dist(?:-delivery)?\/(?:video-examples|product-detail-examples)\/.+\.(?:mp4|webm|png|jpe?g|webp)$/i.test(relative)) return "media";
  return "startup";
}
function verificationPolicy(files) {
  return { schema: 1, groups: Object.fromEntries(GROUPS.map(group =>
    [group, treeHash(files.filter(file => groupForPath(file.path) === group))])) };
}
function validatePolicy(policy, files) {
  if (!policy || policy.schema !== 1 || Object.keys(policy.groups || {}).sort().join() !== [...GROUPS].sort().join()
      || GROUPS.some(group => !HEX.test(policy.groups[group]))) throw Error("component_verification_policy_invalid");
  if (files) {
    const actual = verificationPolicy(files).groups;
    if (GROUPS.some(group => actual[group] !== policy.groups[group])) throw Error("component_verification_policy_invalid");
  }
  return policy;
}
module.exports = { GROUPS, groupForPath, verificationPolicy, validatePolicy };
