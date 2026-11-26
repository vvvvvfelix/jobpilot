const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke(channel, payload) {
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, handler) {
    const listener = (_e, data) => handler(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
