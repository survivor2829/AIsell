// This alias is an application component. The installed base helper stays intact.
const fs = require("node:fs");
const path = require("node:path");
const helper = require("./legacy-recovery/src/main/update-helper.cjs");
async function createUpdateJob(options) {
  const result = await helper.createUpdateJob(options);
  try {
    // Only the owned, newly created copy can load the contemporary recovery stack.
    const entry = path.join(path.dirname(result.job.helperExecutable), "resources/app/src/main/update-helper.cjs");
    await fs.promises.writeFile(entry, 'module.exports = require("./legacy-recovery/src/main/update-helper.cjs");\n');
    return result;
  } catch (error) {
    helper.revokeUpdateJob(result.file);
    throw error;
  }
}
module.exports = { ...helper, createUpdateJob };
