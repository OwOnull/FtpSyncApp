const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("appApi", {
  chooseProject: () => ipcRenderer.invoke("project:choose"),
  listProjectHistory: () => ipcRenderer.invoke("project:list-history"),
  deleteProjectHistoryItem: (payload) => ipcRenderer.invoke("project:delete-history-item", payload),
  setProjectAlias: (payload) => ipcRenderer.invoke("project:set-alias", payload),
  openProjectInExplorer: (payload) => ipcRenderer.invoke("project:open-in-explorer", payload),
  getLastProject: () => ipcRenderer.invoke("project:get-last"),
  saveConfig: (payload) => ipcRenderer.invoke("config:save", payload),
  startSync: (payload) => ipcRenderer.invoke("sync:start", payload),
  stopSync: () => ipcRenderer.invoke("sync:stop"),
  listLocalDir: (payload) => ipcRenderer.invoke("list-local-dir", payload),
  listRemoteDir: (payload) => ipcRenderer.invoke("list-remote-dir", payload),
  syncLocalToRemote: (payload) => ipcRenderer.invoke("sync-local-to-remote", payload),
  syncRemoteToLocal: (payload) => ipcRenderer.invoke("sync-remote-to-local", payload),
  syncServerToLocalByLocal: (payload) =>
    ipcRenderer.invoke("sync-server-to-local-by-local", payload),
  syncLocalToServerByRemote: (payload) =>
    ipcRenderer.invoke("sync-local-to-server-by-remote", payload),
  syncGitUnstaged: (payload) => ipcRenderer.invoke("sync:git-unstaged", payload),
  listGitExtractOptions: (payload) => ipcRenderer.invoke("extract:git-list-options", payload),
  extractGitSinceRef: (payload) => ipcRenderer.invoke("extract:git-since-ref", payload),
  forceDisconnectFtp: () => ipcRenderer.invoke("ftp:force-disconnect"),
  onLog: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("sync:log", listener);
    return () => ipcRenderer.removeListener("sync:log", listener);
  },
});
