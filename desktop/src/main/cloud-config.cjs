const fs = require("node:fs");
const path = require("node:path");

function cloudConfig({ developmentEdition }) {
  // Test channel only until the production domain and release are approved.
  if (!developmentEdition) return { enabled: false };
  return {
    enabled: true, origin: "https://115.159.88.100", channel: "test",
    appId: "com.aihuoke.desktop.test",
    caPem: fs.readFileSync(path.join(__dirname, "cloud-test-ca.crt"), "utf8"),
    signingPublicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAABmbBe5UEjA9gNGTstlnk/kzNsHPAunbCg2VftSynhE=\n-----END PUBLIC KEY-----\n"
  };
}
module.exports = { cloudConfig };

