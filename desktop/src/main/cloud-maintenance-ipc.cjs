function registerCloudMaintenanceIpc({ ipcMain, controller, getMainWindow, restart }) {
  function trusted(event) {
    const window = getMainWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("cloud_sender_invalid");
  }
  for (const [name, action] of Object.entries({
    status: () => controller.status(), check: () => controller.check(),
    announcements: () => controller.refreshAnnouncements(), readAnnouncement: (sequence) => controller.markAnnouncementRead(sequence),
    consent: (value) => controller.setConsent(value === true),
    upload: () => controller.flush(), restart: () => restart()
  })) {
    ipcMain.handle(`cloud:${name}`, async (event, value) => { trusted(event); return action(value); });
  }
  return controller.onUpdate((state) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send("cloud:update", state);
  });
}
module.exports = { registerCloudMaintenanceIpc };
