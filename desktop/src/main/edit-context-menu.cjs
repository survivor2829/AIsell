"use strict";
// Right-click 剪切/复制/粘贴/全选 in every input of every window (user 2026-11-25: older customers paste with
// the right mouse button and do not know Ctrl+V; Electron shows no menu by default). Covers the embedded
// product-detail page and any later window. Pages that handle the right button themselves (the sprite calls
// preventDefault) never get this event.

function editMenuTemplate(params) {
  const flags = params?.editFlags || {};
  if (params?.isEditable) {
    return [
      { role: "cut", label: "剪切", enabled: Boolean(flags.canCut) },
      { role: "copy", label: "复制", enabled: Boolean(flags.canCopy) },
      { role: "paste", label: "粘贴", enabled: Boolean(flags.canPaste) },
      { type: "separator" },
      { role: "selectAll", label: "全选", enabled: Boolean(flags.canSelectAll) }
    ];
  }
  if (String(params?.selectionText || "").trim()) return [{ role: "copy", label: "复制", enabled: true }];
  return [];
}

function installEditContextMenu({ app, Menu, BrowserWindow }) {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("context-menu", (_menuEvent, params) => {
      const template = editMenuTemplate(params);
      if (!template.length) return;
      const window = BrowserWindow.fromWebContents(contents) || BrowserWindow.fromWebContents(contents.hostWebContents || contents);
      Menu.buildFromTemplate(template).popup(window ? { window } : {});
    });
  });
}

module.exports = { editMenuTemplate, installEditContextMenu };
