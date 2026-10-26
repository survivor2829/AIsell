const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const Module = require("node:module");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function source(name) { return fs.readFileSync(path.join(__dirname, name), "utf8"); }
const page = source("BatchCreativePage.tsx"), sound = source("BatchSoundSettings.tsx");
const previous = require.extensions[".tsx"];
const previousTs = require.extensions[".ts"];
require.extensions[".tsx"] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, file);
require.extensions[".ts"] = require.extensions[".tsx"];
try {
  const { BatchSoundSettings } = require("./BatchSoundSettings.tsx");
  for (const mode of ["auto", "none"]) {
    const html = renderToStaticMarkup(React.createElement(BatchSoundSettings, { settings: { music_mode: mode }, locked: false, onChange() {} }));
    assert.match(html, /role="switch"/u);
    assert.match(html, /不加配乐/u);
    assert.match(html, /自动选择/u);
    assert.equal((html.match(/<select/g) || []).length, 1);
    assert.doesNotMatch(html, /试听|曲目|导入|批准|更多设置/u);
  }
  assert.doesNotMatch(page, /<VideoTemplatePicker|batch-strict-review|<BatchVoiceRecovery/u);
  assert.match(page, /video_template: "topic_fixed", strict_visual_review: false/u);
  assert.match(page, /c.music_status === "none" && <p>本条未配乐/u);
  assert.doesNotMatch(sound, /previewAutoMixVoicePersona|approveAutoMixVoicePersona|music-preview/u);
  console.log("Simple video sound settings and legacy recovery boundary self-check passed");
} finally { if (previousTs) require.extensions[".ts"] = previousTs; else delete require.extensions[".ts"]; if (previous) require.extensions[".tsx"] = previous; else delete require.extensions[".tsx"]; }
