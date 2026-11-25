// Right-click paste for customers who do not know Ctrl+V (2026-11-25).
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { editMenuTemplate, installEditContextMenu } = require("./edit-context-menu.cjs");

const labels = (items) => items.filter((item) => item.label).map((item) => `${item.label}:${item.enabled ? "on" : "off"}`);
assert.deepEqual(labels(editMenuTemplate({ isEditable: true, editFlags: { canPaste: true, canSelectAll: true } })),
  ["剪切:off", "复制:off", "粘贴:on", "全选:on"], "an empty input offers paste; nothing to cut or copy");
assert.deepEqual(labels(editMenuTemplate({ isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } })),
  ["剪切:on", "复制:on", "粘贴:on", "全选:on"]);
assert.deepEqual(labels(editMenuTemplate({ isEditable: false, selectionText: "  客户名单 " })), ["复制:on"], "selected page text can be copied");
assert.deepEqual(editMenuTemplate({ isEditable: false, selectionText: "  " }), [], "no menu on plain page areas");
assert.deepEqual(editMenuTemplate(undefined), []);
assert.deepEqual(editMenuTemplate({ isEditable: true }).filter((item) => item.role).map((item) => item.role), ["cut", "copy", "paste", "selectAll"],
  "Electron's own roles do the editing, so it works in every input and the embedded page");

// Every web contents created later (windows, the product-detail page) gets the menu.
const app = new EventEmitter(), contents = new EventEmitter(), popped = [];
const window = { id: 1 };
installEditContextMenu({ app, BrowserWindow: { fromWebContents: (value) => (value === contents ? window : null) },
  Menu: { buildFromTemplate: (template) => ({ popup: (options) => popped.push({ template, options }) }) } });
app.emit("web-contents-created", {}, contents);
contents.emit("context-menu", {}, { isEditable: true, editFlags: { canPaste: true } });
contents.emit("context-menu", {}, { isEditable: false, selectionText: "" });
assert.equal(popped.length, 1, "one menu for the input, none for the plain area");
assert.equal(popped[0].options.window, window);

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
assert.match(main, /installEditContextMenu\(\{ app, Menu, BrowserWindow \}\)/u, "main installs it");
console.log("edit context menu self-check passed: input menu states, copy for selected text, every new window, installed in main");
