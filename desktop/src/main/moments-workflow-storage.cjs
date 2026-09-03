const fs = require("node:fs");
const path = require("node:path");

function workflowDirectory(root, taskId) {
  const id = String(taskId || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id)) {
    throw Object.assign(new Error("Invalid workflow task"), { code: "workflow_task_id_invalid" });
  }
  const resolvedRoot = path.resolve(root);
  const directory = path.resolve(resolvedRoot, id);
  if (path.dirname(directory) !== resolvedRoot) {
    throw Object.assign(new Error("Invalid workflow task"), { code: "workflow_task_id_invalid" });
  }
  return directory;
}

function readWorkflowJson(file, fallback = null) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw Object.assign(new Error("Workflow state unavailable"), { code: "moments_workflow_state_unavailable" });
  }
}

module.exports = { readWorkflowJson, workflowDirectory };
