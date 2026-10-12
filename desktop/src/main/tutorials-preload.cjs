function createTutorialsApi(ipcRenderer) {
  return {
    list: options => ipcRenderer.invoke('tutorials:list', options),
    play: id => ipcRenderer.invoke('tutorials:play', id),
    cancel: id => ipcRenderer.invoke('tutorials:cancel', id),
    onProgress(callback) {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('tutorials:progress', listener);
      return () => ipcRenderer.removeListener('tutorials:progress', listener);
    }
  };
}
module.exports = { createTutorialsApi };
