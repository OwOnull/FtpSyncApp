const path = require("path");
const fs = require("fs/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { ConfigStore } = require("../store/config-store");
const { ProjectLockManager } = require("./project-lock-manager");
const {
  FtpSyncService,
  listRemoteDirWithConfig,
  syncLocalToRemote,
  syncRemoteToLocal,
  syncServerToLocalByLocalPath,
  syncLocalToServerByRemotePath,
  syncFilesList,
  normalizeRelativeUnixPath,
  buildProjectLocalPath,
  gitOutputToProjectRelative,
} = require("../services/ftp-sync-service");

const execFileAsync = promisify(execFile);

const EXTRACT_CHANGES_FOLDER = "项目变更";

let mainWindow = null;
let syncService = null;
const configStore = new ConfigStore(app.getPath("userData"));
const projectLockManager = new ProjectLockManager(app.getPath("userData"));
let activeSyncProjectPath = "";

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

async function stopSyncWithLog() {
  if (syncService) {
    const previousProjectPath = activeSyncProjectPath;
    syncService.stop();
    syncService = null;
    activeSyncProjectPath = "";
    if (previousProjectPath) {
      await projectLockManager.release(previousProjectPath);
    }
    sendLog("info", "监听已停止。");
  }
}

function parseGitNameList(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function execGit(args, options = {}) {
  const { cwd, gitRoot } = options;
  const resolvedGitRoot = gitRoot ? path.resolve(gitRoot) : "";
  const gitArgs = resolvedGitRoot
    ? ["-C", resolvedGitRoot, ...args]
    : args;
  const execCwd = resolvedGitRoot || cwd;

  try {
    const { stdout } = await execFileAsync("git", gitArgs, {
      cwd: execCwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, stdout: stdout || "" };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        ok: false,
        code: "git_not_installed",
        message: "未检测到 Git，请先安装 Git 并确保已加入系统 PATH。",
      };
    }

    const stderr = error && error.stderr ? String(error.stderr).trim() : "";
    const stdout = error && error.stdout ? String(error.stdout).trim() : "";
    const fallback = error && error.message ? error.message : "Git 命令执行失败";
    return {
      ok: false,
      code: "git_error",
      message: stderr || stdout || fallback,
    };
  }
}

async function collectGitUnstagedFileEntries(projectPath) {
  const resolvedProjectPath = path.resolve(projectPath);

  const repoCheck = await execGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: resolvedProjectPath,
  });
  if (!repoCheck.ok) {
    return repoCheck;
  }
  if (repoCheck.stdout.trim() !== "true") {
    return {
      ok: false,
      code: "not_git_repo",
      message: "当前项目目录不是 Git 仓库。",
    };
  }

  const gitRootResult = await execGit(["rev-parse", "--show-toplevel"], {
    cwd: resolvedProjectPath,
  });
  if (!gitRootResult.ok) {
    return gitRootResult;
  }
  const gitRoot = path.resolve(gitRootResult.stdout.trim());

  const gitRootOptions = { gitRoot };
  const unstagedResult = await execGit(["diff", "--name-only"], gitRootOptions);
  if (!unstagedResult.ok) {
    return unstagedResult;
  }

  const deletedResult = await execGit(
    ["diff", "--name-only", "--diff-filter=D"],
    gitRootOptions
  );
  if (!deletedResult.ok) {
    return deletedResult;
  }

  const untrackedResult = await execGit(
    ["ls-files", "--others", "--exclude-standard"],
    gitRootOptions
  );
  if (!untrackedResult.ok) {
    return untrackedResult;
  }

  const stagedResult = await execGit(
    ["diff", "--cached", "--name-only"],
    gitRootOptions
  );
  if (!stagedResult.ok) {
    return stagedResult;
  }

  const unstagedPaths = parseGitNameList(unstagedResult.stdout);
  const deletedPaths = new Set(parseGitNameList(deletedResult.stdout));
  const untrackedPaths = parseGitNameList(untrackedResult.stdout);
  const stagedPaths = new Set(parseGitNameList(stagedResult.stdout));

  const entries = [];
  const seen = new Set();
  const skippedOutsideProject = [];

  function appendEntry(gitRelativePath, action) {
    const gitNormalized = normalizeRelativeUnixPath(gitRelativePath);
    if (!gitNormalized) {
      return;
    }

    const projectRelativePath = gitOutputToProjectRelative(
      gitRoot,
      resolvedProjectPath,
      gitNormalized
    );
    if (!projectRelativePath) {
      skippedOutsideProject.push(gitNormalized);
      return;
    }
    if (seen.has(projectRelativePath)) {
      return;
    }

    seen.add(projectRelativePath);
    entries.push({
      relativePath: projectRelativePath,
      action,
    });
  }

  for (const relPath of unstagedPaths) {
    const gitNormalized = normalizeRelativeUnixPath(relPath);
    const action =
      deletedPaths.has(relPath) ||
      deletedPaths.has(gitNormalized) ||
      deletedPaths.has(relPath.replace(/\//g, "\\"))
        ? "delete"
        : "upload";
    appendEntry(relPath, action);
  }

  for (const relPath of untrackedPaths) {
    const gitNormalized = normalizeRelativeUnixPath(relPath);
    if (stagedPaths.has(relPath) || stagedPaths.has(gitNormalized)) {
      continue;
    }
    appendEntry(relPath, "upload");
  }

  return {
    ok: true,
    entries,
    gitRoot,
    skippedOutsideProject,
  };
}

function isPathInsideRoot(rootPath, targetPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function shouldSkipExtractPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  return (
    normalized === EXTRACT_CHANGES_FOLDER ||
    normalized.startsWith(`${EXTRACT_CHANGES_FOLDER}/`)
  );
}

async function extractGitUnstagedFiles(projectPath) {
  const resolvedProjectPath = path.resolve(projectPath);
  const extractRoot = path.join(resolvedProjectPath, EXTRACT_CHANGES_FOLDER);

  const collectResult = await collectGitUnstagedFileEntries(resolvedProjectPath);
  if (!collectResult.ok) {
    return collectResult;
  }

  const entries = collectResult.entries.filter(
    (entry) => !shouldSkipExtractPath(entry.relativePath)
  );

  if (collectResult.skippedOutsideProject && collectResult.skippedOutsideProject.length) {
    sendLog(
      "info",
      `已跳过 ${collectResult.skippedOutsideProject.length} 个位于 Git 仓库内、但不在当前项目目录下的变更。`
    );
  }

  if (!entries.length) {
    return {
      ok: true,
      total: 0,
      success: [],
      failed: [],
      removed: [],
      message: "没有需要提取的文件（Git 无未暂存变更）。",
    };
  }

  await fs.mkdir(extractRoot, { recursive: true });

  sendLog(
    "info",
    `找到 ${entries.length} 个未暂存变更项，开始提取到「${EXTRACT_CHANGES_FOLDER}」…`
  );

  const success = [];
  const failed = [];
  const removed = [];

  for (const entry of entries) {
    const { relativePath, action } = entry;
    const destPath = path.join(extractRoot, ...relativePath.split("/"));

    if (!isPathInsideRoot(resolvedProjectPath, destPath)) {
      const message = "目标路径超出项目目录。";
      failed.push({ relativePath, action, message });
      sendLog("error", `提取失败: ${relativePath} - ${message}`);
      continue;
    }

    if (action === "delete") {
      try {
        await fs.unlink(destPath);
        removed.push(relativePath);
        sendLog("info", `已移除（源文件已删除）: ${relativePath}`);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          continue;
        }
        const message = error && error.message ? error.message : "删除目标文件失败";
        failed.push({ relativePath, action: "delete", message });
        sendLog("error", `移除失败: ${relativePath} - ${message}`);
      }
      continue;
    }

    const sourcePath = buildProjectLocalPath(resolvedProjectPath, relativePath);
    if (!isPathInsideRoot(resolvedProjectPath, sourcePath)) {
      const message = "源路径超出项目目录。";
      failed.push({ relativePath, action, message });
      sendLog("error", `提取失败: ${relativePath} - ${message}`);
      continue;
    }

    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        continue;
      }
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(sourcePath, destPath);
      success.push(relativePath);
      sendLog("info", `已提取: ${relativePath}`);
    } catch (error) {
      const message =
        error && error.code === "ENOENT"
          ? `路径解析错误，本地文件不存在: ${sourcePath}`
          : error && error.message
            ? error.message
            : "复制文件失败";
      failed.push({ relativePath, action: "copy", message });
      sendLog("error", `提取失败: ${relativePath} - ${message}`);
    }
  }

  const copiedCount = success.length;
  const removedCount = removed.length;
  const failedCount = failed.length;

  let message = `提取完成，成功 ${copiedCount} 个`;
  if (removedCount) {
    message += `，移除 ${removedCount} 个`;
  }
  if (failedCount) {
    message += `，失败 ${failedCount} 个`;
  }
  message += "。";

  return {
    ok: failedCount === 0,
    total: entries.length,
    success,
    failed,
    removed,
    message,
  };
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
  stopSyncWithLog()
    .catch(() => {})
    .finally(() => {
      projectLockManager
        .releaseAll()
        .catch(() => {})
        .finally(() => {
          if (process.platform !== "darwin") {
            app.quit();
          }
        });
    });
});

app.on("before-quit", () => {
  projectLockManager.releaseAll().catch(() => {});
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

ipcMain.handle("project:list-history", async () => {
  const lastProjectPath = configStore.getLastProjectPath();
  const projectPaths = configStore
    .listProjectPaths()
    .filter(Boolean)
    .map((item) => path.resolve(item));
  const unique = new Set();
  const ordered = [];

  if (lastProjectPath) {
    const normalizedLast = path.resolve(lastProjectPath);
    unique.add(normalizedLast);
    ordered.push(normalizedLast);
  }
  for (const projectPath of projectPaths) {
    if (!unique.has(projectPath)) {
      unique.add(projectPath);
      ordered.push(projectPath);
    }
  }

  return ordered.map((projectPath) => ({
    projectPath,
    config: configStore.getProjectConfig(projectPath),
  }));
});

ipcMain.handle("project:delete-history-item", async (_event, payload) => {
  const rawProjectPath = payload && payload.projectPath ? String(payload.projectPath).trim() : "";
  if (!rawProjectPath) {
    return { ok: false, message: "未指定要删除的历史项目。" };
  }
  const projectPath = path.resolve(rawProjectPath);
  const removed = configStore.removeProject(projectPath);
  if (!removed) {
    return { ok: false, message: "历史项目不存在或已被删除。" };
  }
  await configStore.flush();
  return { ok: true };
});

ipcMain.handle("config:save", async (_event, payload) => {
  const { projectPath, config } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }
  configStore.setProjectConfig(projectPath, config || {});
  configStore.setLastProjectPath(projectPath);
  await configStore.flush();

  if (syncService && path.resolve(syncService.projectPath) === path.resolve(projectPath)) {
    const savedConfig = configStore.getProjectConfig(projectPath);
    syncService.updateIgnorePaths(savedConfig.ignorePaths);
  }

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

  await stopSyncWithLog();

  const lockResult = await projectLockManager.tryAcquire(projectPath);
  if (!lockResult.ok) {
    return {
      ok: false,
      message: lockResult.message || "该项目已在其他窗口/实例同步中。",
      code: "project_locked",
    };
  }

  const mergedConfig = {
    ...configStore.getProjectConfig(projectPath),
    ...(config || {}),
  };

  syncService = new FtpSyncService({
    projectPath,
    config: mergedConfig,
    ignorePaths: mergedConfig.ignorePaths,
    onLog: sendLog,
  });

  try {
    await syncService.start();
    activeSyncProjectPath = path.resolve(projectPath);
    return { ok: true };
  } catch (error) {
    await projectLockManager.release(projectPath);
    syncService = null;
    activeSyncProjectPath = "";
    return {
      ok: false,
      message: error && error.message ? error.message : "启动失败",
    };
  }
});

ipcMain.handle("sync:stop", async () => {
  await stopSyncWithLog();
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

ipcMain.handle("sync:git-unstaged", async (_event, payload) => {
  const { projectPath, config } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }

  if (!config || !config.host || !config.username) {
    return { ok: false, message: "请完善 FTP 配置后再同步。" };
  }

  const collectResult = await collectGitUnstagedFileEntries(projectPath);
  if (!collectResult.ok) {
    return {
      ok: false,
      message: collectResult.message || "获取 Git 变更失败。",
      code: collectResult.code,
    };
  }

  if (collectResult.skippedOutsideProject && collectResult.skippedOutsideProject.length) {
    sendLog(
      "info",
      `已跳过 ${collectResult.skippedOutsideProject.length} 个位于 Git 仓库内、但不在当前项目目录下的变更。`
    );
  }

  if (!collectResult.entries.length) {
    sendLog("info", "没有需要同步的文件（Git 无未暂存变更）。");
    return {
      ok: true,
      message: "没有需要同步的文件。",
      total: 0,
      success: [],
      failed: [],
      skipped: 0,
    };
  }

  if (collectResult.gitRoot && path.resolve(collectResult.gitRoot) !== path.resolve(projectPath)) {
    sendLog(
      "info",
      `Git 仓库根目录为 ${collectResult.gitRoot}，已按项目目录 ${path.resolve(projectPath)} 解析相对路径。`
    );
  }

  try {
    const result = await syncFilesList({
      projectPath,
      config,
      fileEntries: collectResult.entries,
      onLog: sendLog,
    });

    return {
      ok: result.ok,
      message: result.failed.length
        ? `同步完成，${result.failed.length} 个文件失败。`
        : "Git 未暂存变更已全部同步。",
      total: result.total,
      success: result.success,
      failed: result.failed,
      skipped: result.skipped,
    };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "Git 变更同步失败",
    };
  }
});

ipcMain.handle("extract:git-unstaged", async (_event, payload) => {
  const { projectPath } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }

  try {
    const result = await extractGitUnstagedFiles(projectPath);
    if (!result.ok && result.code) {
      return {
        ok: false,
        message: result.message || "获取 Git 变更失败。",
        code: result.code,
      };
    }

    if (result.total === 0) {
      sendLog("info", result.message || "没有需要提取的文件（Git 无未暂存变更）。");
    }

    return result;
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "提取未暂存变更失败",
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

ipcMain.handle("sync-server-to-local-by-local", async (_event, payload) => {
  const { projectPath, config, localPath } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }
  if (!localPath) {
    return { ok: false, message: "未指定本地路径。" };
  }

  try {
    await syncServerToLocalByLocalPath({
      projectPath,
      config: config || {},
      localPath,
      onLog: sendLog,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "与服务器同步失败",
    };
  }
});

ipcMain.handle("sync-local-to-server-by-remote", async (_event, payload) => {
  const { projectPath, config, remotePath, itemType } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }
  if (!remotePath) {
    return { ok: false, message: "未指定远程路径。" };
  }

  try {
    await syncLocalToServerByRemotePath({
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
      message: error && error.message ? error.message : "与本地同步失败",
    };
  }
});
