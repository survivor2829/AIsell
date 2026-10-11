const fs = require("node:fs");
const path = require("node:path");
const profiles = require("./cloud-release-config.json");
function cloudConfig({ developmentEdition = false, channel } = {}) {
  const selected = channel || (developmentEdition ? "test" : "production");
  const profile = profiles[selected];
  if (!profile || profile.enabled !== true) return { enabled: false, channel: selected, appId: profile?.appId };
  if (!/^https:\/\//.test(profile.origin) || !profile.signingPublicKey || !profile.appId) throw Error("cloud_release_config_invalid");
  return { ...profile, channel: selected, caPem: profile.caFile ? fs.readFileSync(path.join(__dirname, profile.caFile), "utf8") : undefined };
}
module.exports = { cloudConfig };
