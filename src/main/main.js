const path = require("path");
const fs = require("fs/promises");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { ConfigStore } = require("../store/config-store");
const {
  FtpSyncService,
  listRemoteDirWithConfig,
  syncLocalToRemote,
  syncRemoteToLocal,
} = require("../services/ftp-sync-service");

let mainWindow = null;
let syncService = null;
const configStore = new ConfigStore(app.getPath("userData"));

function sendLog(level, message) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("sync:log", {
    time: new Date().toLocaleString(),
    level,
    message,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

async function initAppState() {
  await configStore.init();
}

function getProjectConfigPayload(projectPath) {
  if (!projectPath) {
    return null;
  }

  const projectConfig = configStore.getProjectConfig(projectPath);
  return {
    projectPath,
    config: projectConfig,
  };
}

function stopSyncWithLog() {
  if (syncService) {
    syncService.stop();
    syncService = null;
    sendLog("info", "监听已停止。");
  }
}

app.whenReady().then(async () => {
  await initAppState();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopSyncWithLog();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("project:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });

  if (result.canceled || !result.filePaths.length) {
    return { cancelled: true };
  }

  const projectPath = result.filePaths[0];
  configStore.setLastProjectPath(projectPath);
  await configStore.flush();

  const payload = getProjectConfigPayload(projectPath);
  return {
    cancelled: false,
    ...payload,
  };
});

ipcMain.handle("project:get-last", async () => {
  const projectPath = configStore.getLastProjectPath();
  if (!projectPath) {
    return null;
  }
  return getProjectConfigPayload(projectPath);
});

ipcMain.handle("config:save", async (_event, payload) => {
  const { projectPath, config } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }
  configStore.setProjectConfig(projectPath, config || {});
  configStore.setLastProjectPath(projectPath);
  await configStore.flush();
  return { ok: true };
});

ipcMain.handle("sync:start", async (_event, payload) => {
  const { projectPath, config } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }

  if (!config || !config.host || !config.username) {
    return { ok: false, message: "请完善 FTP 配置后再启动。" };
  }

  stopSyncWithLog();

  syncService = new FtpSyncService({
    projectPath,
    config,
    onLog: sendLog,
  });

  try {
    await syncService.start();
    return { ok: true };
  } catch (error) {
    syncService = null;
    return {
      ok: false,
      message: error && error.message ? error.message : "启动失败",
    };
  }
});

ipcMain.handle("sync:stop", async () => {
  stopSyncWithLog();
  return { ok: true };
});

ipcMain.handle("list-local-dir", async (_event, payload) => {
  const { projectPath, targetPath } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const resolvedTargetPath = path.resolve(targetPath || resolvedProjectPath);
  const relativePath = path.relative(resolvedProjectPath, resolvedTargetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { ok: false, message: "目录超出当前项目范围。" };
  }

  try {
    const dirents = await fs.readdir(resolvedTargetPath, { withFileTypes: true });
    const items = dirents
      .map((dirent) => ({
        name: dirent.name,
        type: dirent.isDirectory() ? "dir" : "file",
        path: path.join(resolvedTargetPath, dirent.name),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "dir" ? -1 : 1;
        }
        return a.name.localeCompare(b.name, "zh-CN");
      });

    const parentPath =
      resolvedTargetPath === resolvedProjectPath
        ? null
        : path.dirname(resolvedTargetPath);

    return {
      ok: true,
      path: resolvedTargetPath,
      parentPath,
      items,
    };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "读取本地目录失败",
    };
  }
});

ipcMain.handle("list-remote-dir", async (_event, payload) => {
  const { config, targetPath } = payload || {};
  try {
    const result = await listRemoteDirWithConfig(config || {}, targetPath);
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "读取远程目录失败",
    };
  }
});

ipcMain.handle("sync-local-to-remote", async (_event, payload) => {
  const { projectPath, config, localPath } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }
  if (!localPath) {
    return { ok: false, message: "未指定本地路径。" };
  }

  try {
    await syncLocalToRemote({
      projectPath,
      config: config || {},
      localPath,
      onLog: sendLog,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "同步到服务器失败",
    };
  }
});

ipcMain.handle("sync-remote-to-local", async (_event, payload) => {
  const { projectPath, config, remotePath, itemType } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }
  if (!remotePath) {
    return { ok: false, message: "未指定远程路径。" };
  }

  try {
    await syncRemoteToLocal({
      projectPath,
      config: config || {},
      remotePath,
      itemType,
      onLog: sendLog,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "同步到本地失败",
    };
  }
});
