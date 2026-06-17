const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("appApi", {
  chooseProject: () => ipcRenderer.invoke("project:choose"),
  getLastProject: () => ipcRenderer.invoke("project:get-last"),
  saveConfig: (payload) => ipcRenderer.invoke("config:save", payload),
  startSync: (payload) => ipcRenderer.invoke("sync:start", payload),
  stopSync: () => ipcRenderer.invoke("sync:stop"),
  listLocalDir: (payload) => ipcRenderer.invoke("list-local-dir", payload),
  listRemoteDir: (payload) => ipcRenderer.invoke("list-remote-dir", payload),
  syncLocalToRemote: (payload) => ipcRenderer.invoke("sync-local-to-remote", payload),
  syncRemoteToLocal: (payload) => ipcRenderer.invoke("sync-remote-to-local", payload),
  onLog: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("sync:log", listener);
    return () => ipcRenderer.removeListener("sync:log", listener);
  },
});
