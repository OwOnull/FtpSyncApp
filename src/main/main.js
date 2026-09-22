const path = require("path");
const fs = require("fs/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
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
  previewSyncExtras,
  applySyncExtrasDeletion,
  deleteLocalPathItem,
  deleteRemotePathItem,
  normalizeRelativeUnixPath,
  resolveLocalSyncRoot,
  buildProjectLocalPath,
  gitOutputToProjectRelative,
  setActiveSyncService,
  clearActiveSyncService,
  forceDisconnectAll,
} = require("../services/ftp-sync-service");

const execFileAsync = promisify(execFile);

const EXTRACT_CHANGES_FOLDER = "项目变更";
const GIT_EXTRACT_REF_UNSTAGED = "__unstaged__";
const GIT_EXTRACT_REF_STAGED = "__staged__";
const GIT_EXTRACT_COMMIT_LIMIT = 40;

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

function resolveProjectLocalSyncRoot(projectPath, config) {
  const localBasePath =
    config && Object.prototype.hasOwnProperty.call(config, "localBasePath")
      ? config.localBasePath
      : configStore.getProjectConfig(projectPath).localBasePath;
  return resolveLocalSyncRoot(projectPath, localBasePath);
}

async function assertLocalSyncRootExists(localSyncRoot) {
  try {
    const stat = await fs.stat(localSyncRoot);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        message: `本地同步目录不是文件夹: ${localSyncRoot}`,
      };
    }
    return { ok: true, localSyncRoot };
  } catch (error) {
    return {
      ok: false,
      message:
        error && error.code === "ENOENT"
          ? `本地同步目录不存在: ${localSyncRoot}`
          : error && error.message
            ? error.message
            : `无法访问本地同步目录: ${localSyncRoot}`,
    };
  }
}

async function stopSyncWithLog() {
  if (syncService) {
    const previousProjectPath = activeSyncProjectPath;
    const stoppingService = syncService;
    clearActiveSyncService(stoppingService);
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

async function resolveGitRepo(projectPath) {
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

  return {
    ok: true,
    projectPath: resolvedProjectPath,
    gitRoot: path.resolve(gitRootResult.stdout.trim()),
  };
}

function createGitPathMapper(gitRoot, projectPath) {
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
      projectPath,
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

  return { entries, seen, skippedOutsideProject, appendEntry };
}

function isGitNoCommitsYetError(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("does not have any commits yet") ||
    text.includes("bad default revision") ||
    (text.includes("current branch") && text.includes("does not have any commits"))
  );
}

function isGitInvalidRefError(message) {
  const text = String(message || "").toLowerCase();
  return (
    isGitNoCommitsYetError(message) ||
    text.includes("unknown revision") ||
    text.includes("bad revision") ||
    text.includes("ambiguous argument") ||
    text.includes("needed a single revision")
  );
}

function buildGitExtractOptionLabel(option) {
  if (!option) {
    return "";
  }
  if (option.type === "pseudo" || option.kind === "pseudo") {
    return option.title || option.ref;
  }
  const shortHash = option.shortHash || "";
  const date = option.date || "";
  const author = option.author || "";
  const subject = option.subject || option.message || "";
  return [shortHash, date, author, subject].filter(Boolean).join("  ");
}

async function listGitExtractOptions(projectPath, limit = GIT_EXTRACT_COMMIT_LIMIT) {
  const repo = await resolveGitRepo(projectPath);
  if (!repo.ok) {
    return repo;
  }

  const commitLimit = Math.max(1, Math.min(100, Number(limit) || GIT_EXTRACT_COMMIT_LIMIT));
  const options = [
    {
      ref: GIT_EXTRACT_REF_UNSTAGED,
      type: "pseudo",
      kind: "pseudo",
      title: "未暂存变更",
      subtitle: "工作区未暂存的修改与未跟踪文件",
      message: "工作区未暂存的修改与未跟踪文件",
      label: "未暂存变更",
    },
    {
      ref: GIT_EXTRACT_REF_STAGED,
      type: "pseudo",
      kind: "pseudo",
      title: "已暂存未提交",
      subtitle: "已暂存但尚未提交的变更",
      message: "已暂存但尚未提交的变更",
      label: "已暂存未提交",
    },
  ];

  const logResult = await execGit(
    [
      "log",
      `-n${commitLimit}`,
      "--pretty=format:%H\t%h\t%an\t%ad\t%s",
      "--date=format:%Y-%m-%d %H:%M",
    ],
    { gitRoot: repo.gitRoot }
  );

  if (!logResult.ok) {
    if (isGitNoCommitsYetError(logResult.message)) {
      return {
        ok: true,
        options,
        gitRoot: repo.gitRoot,
        commitCount: 0,
      };
    }
    return logResult;
  }

  const lines = String(logResult.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 4) {
      continue;
    }
    const hash = String(parts[0] || "").trim();
    const shortHash = String(parts[1] || "").trim();
    const author = String(parts[2] || "").trim();
    const date = String(parts[3] || "").trim();
    const subject = parts.slice(4).join("\t").trim();
    if (!hash) {
      continue;
    }
    const option = {
      ref: hash,
      type: "commit",
      kind: "commit",
      hash,
      shortHash: shortHash || hash.slice(0, 7),
      author,
      date,
      subject,
      message: subject,
    };
    option.label = buildGitExtractOptionLabel(option);
    options.push(option);
  }

  return {
    ok: true,
    options,
    gitRoot: repo.gitRoot,
    commitCount: Math.max(0, options.length - 2),
  };
}

async function collectGitUnstagedFileEntries(projectPath, options = {}) {
  const repo = await resolveGitRepo(projectPath);
  if (!repo.ok) {
    return repo;
  }

  const mapRoot = options.mapRoot
    ? path.resolve(options.mapRoot)
    : repo.projectPath;
  const { projectPath: resolvedProjectPath, gitRoot } = repo;
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

  const { entries, skippedOutsideProject, appendEntry } = createGitPathMapper(
    gitRoot,
    mapRoot
  );

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
    mapRoot,
    projectPath: resolvedProjectPath,
    skippedOutsideProject,
  };
}

async function collectGitChangesSinceRef(projectPath, ref, options = {}) {
  const normalizedRef = String(ref || "").trim();
  if (!normalizedRef) {
    return {
      ok: false,
      code: "invalid_ref",
      message: "请选择要提取的 Git 选项。",
    };
  }

  const mapRoot = options.mapRoot ? path.resolve(options.mapRoot) : null;

  if (normalizedRef === GIT_EXTRACT_REF_UNSTAGED) {
    const collectResult = await collectGitUnstagedFileEntries(projectPath, {
      mapRoot: mapRoot || undefined,
    });
    if (!collectResult.ok) {
      return collectResult;
    }
    return {
      ...collectResult,
      ref: GIT_EXTRACT_REF_UNSTAGED,
      refLabel: "未暂存变更",
      extractMode: "unstaged",
    };
  }

  const repo = await resolveGitRepo(projectPath);
  if (!repo.ok) {
    return repo;
  }

  const { projectPath: resolvedProjectPath, gitRoot } = repo;
  const effectiveMapRoot = mapRoot || resolvedProjectPath;
  const gitRootOptions = { gitRoot };
  const { entries, skippedOutsideProject, appendEntry } = createGitPathMapper(
    gitRoot,
    effectiveMapRoot
  );

  if (normalizedRef === GIT_EXTRACT_REF_STAGED) {
    const stagedResult = await execGit(
      ["diff", "--cached", "--name-only"],
      gitRootOptions
    );
    if (!stagedResult.ok) {
      return stagedResult;
    }

    for (const relPath of parseGitNameList(stagedResult.stdout)) {
      appendEntry(relPath, "upload");
    }

    return {
      ok: true,
      entries,
      gitRoot,
      skippedOutsideProject,
      ref: GIT_EXTRACT_REF_STAGED,
      refLabel: "已暂存未提交",
      extractMode: "copy_skip_missing",
    };
  }

  const verifyResult = await execGit(
    ["rev-parse", "--verify", `${normalizedRef}^{commit}`],
    gitRootOptions
  );
  if (!verifyResult.ok) {
    return {
      ok: false,
      code: "invalid_ref",
      message: isGitInvalidRefError(verifyResult.message)
        ? "所选提交不存在（仓库可能尚无 commit）。"
        : verifyResult.message || "无效的 Git 提交。",
    };
  }

  const commitHash = verifyResult.stdout.trim() || normalizedRef;
  const shortHashResult = await execGit(
    ["rev-parse", "--short", commitHash],
    gitRootOptions
  );
  const shortHash = shortHashResult.ok
    ? shortHashResult.stdout.trim()
    : commitHash.slice(0, 7);

  // 使用 commitHash~1（父提交）作为 diff 基准，确保包含选中 commit 本身的变更
  const parentResult = await execGit(
    ["rev-parse", "--verify", `${commitHash}~1`],
    gitRootOptions
  );
  // 父提交存在则以其为基准；否则（初始提交）使用空树哈希
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf899d15363d7b90d";
  const diffBase = parentResult.ok ? `${commitHash}~1` : EMPTY_TREE;
  const diffCmd = ["diff", "--name-only", diffBase];

  sendLog(
    "info",
    `执行: git ${diffCmd.join(" ")}（基准: ${parentResult.ok ? `${shortHash}~1` : "空树/初始提交"}）`
  );

  const diffResult = await execGit(diffCmd, gitRootOptions);
  if (!diffResult.ok) {
    return diffResult;
  }

  const untrackedResult = await execGit(
    ["ls-files", "--others", "--exclude-standard"],
    gitRootOptions
  );
  if (!untrackedResult.ok) {
    return untrackedResult;
  }

  for (const relPath of parseGitNameList(diffResult.stdout)) {
    appendEntry(relPath, "upload");
  }
  for (const relPath of parseGitNameList(untrackedResult.stdout)) {
    appendEntry(relPath, "upload");
  }

  return {
    ok: true,
    entries,
    gitRoot,
    skippedOutsideProject,
    ref: commitHash,
    refLabel: `提交 ${shortHash}（含）至工作区`,
    shortHash,
    extractMode: "copy_skip_missing",
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

async function extractGitSinceRef(projectPath, ref) {
  const normalizedRef = String(ref || "").trim();
  if (normalizedRef === GIT_EXTRACT_REF_UNSTAGED) {
    return extractGitUnstagedFiles(projectPath);
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const extractRoot = path.join(resolvedProjectPath, EXTRACT_CHANGES_FOLDER);

  const collectResult = await collectGitChangesSinceRef(
    resolvedProjectPath,
    normalizedRef
  );
  if (!collectResult.ok) {
    return collectResult;
  }

  const entries = collectResult.entries.filter(
    (entry) => !shouldSkipExtractPath(entry.relativePath)
  );

  if (collectResult.gitRoot && path.resolve(collectResult.gitRoot) !== resolvedProjectPath) {
    sendLog(
      "info",
      `Git 仓库根目录为 ${collectResult.gitRoot}，已按项目目录 ${resolvedProjectPath} 解析相对路径。`
    );
  }

  sendLog(
    "info",
    `提取范围：${collectResult.refLabel}（复制工作区最新内容）。`
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
      skippedMissing: [],
      message: `没有需要提取的文件（${collectResult.refLabel} 无变更）。`,
      ref: collectResult.ref,
      refLabel: collectResult.refLabel,
    };
  }

  await fs.mkdir(extractRoot, { recursive: true });

  sendLog(
    "info",
    `找到 ${entries.length} 个变更文件，开始提取到「${EXTRACT_CHANGES_FOLDER}」…`
  );

  const success = [];
  const failed = [];
  const skippedMissing = [];

  for (const entry of entries) {
    const { relativePath } = entry;
    const destPath = path.join(extractRoot, ...relativePath.split("/"));

    if (!isPathInsideRoot(resolvedProjectPath, destPath)) {
      const message = "目标路径超出项目目录。";
      failed.push({ relativePath, action: "copy", message });
      sendLog("error", `提取失败: ${relativePath} - ${message}`);
      continue;
    }

    const sourcePath = buildProjectLocalPath(resolvedProjectPath, relativePath);
    if (!isPathInsideRoot(resolvedProjectPath, sourcePath)) {
      const message = "源路径超出项目目录。";
      failed.push({ relativePath, action: "copy", message });
      sendLog("error", `提取失败: ${relativePath} - ${message}`);
      continue;
    }

    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        skippedMissing.push(relativePath);
        sendLog("info", `已跳过（当前不是文件）: ${relativePath}`);
        continue;
      }
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(sourcePath, destPath);
      success.push(relativePath);
      sendLog("info", `已提取: ${relativePath}`);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        skippedMissing.push(relativePath);
        sendLog("info", `已跳过（当前不存在，可能已删除）: ${relativePath}`);
        continue;
      }
      const message = error && error.message ? error.message : "复制文件失败";
      failed.push({ relativePath, action: "copy", message });
      sendLog("error", `提取失败: ${relativePath} - ${message}`);
    }
  }

  const copiedCount = success.length;
  const skippedCount = skippedMissing.length;
  const failedCount = failed.length;

  let message = `提取完成（${collectResult.refLabel}），成功 ${copiedCount} 个`;
  if (skippedCount) {
    message += `，跳过已删除/不存在 ${skippedCount} 个`;
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
    skippedMissing,
    ref: collectResult.ref,
    refLabel: collectResult.refLabel,
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
  return configStore.listProjectPaths().map((projectPath) => {
    const config = configStore.getProjectConfig(projectPath);
    return {
      path: projectPath,
      projectPath,
      alias: config.alias || "",
      config,
    };
  });
});

ipcMain.handle("project:reorder-history", async (_event, payload) => {
  const rawOrder = payload && Array.isArray(payload.order) ? payload.order : [];
  const order = rawOrder.map((item) => String(item || "").trim()).filter(Boolean);
  const nextOrder = configStore.reorderProjectHistory(order);
  await configStore.flush();
  return {
    ok: true,
    order: nextOrder,
  };
});

ipcMain.handle("project:set-alias", async (_event, payload) => {
  const rawProjectPath = payload && payload.projectPath ? String(payload.projectPath).trim() : "";
  if (!rawProjectPath) {
    return { ok: false, message: "未指定项目路径。" };
  }
  const projectPath = path.resolve(rawProjectPath);
  const alias = payload && payload.alias != null ? String(payload.alias) : "";
  configStore.setProjectAlias(projectPath, alias);
  await configStore.flush();
  return {
    ok: true,
    projectPath,
    alias: configStore.getProjectConfig(projectPath).alias || "",
  };
});

ipcMain.handle("project:open-in-explorer", async (_event, payload) => {
  const rawProjectPath = payload && payload.projectPath ? String(payload.projectPath).trim() : "";
  if (!rawProjectPath) {
    return { ok: false, message: "未指定项目路径。" };
  }
  const projectPath = path.resolve(rawProjectPath);
  try {
    const errorMessage = await shell.openPath(projectPath);
    if (errorMessage) {
      return { ok: false, message: errorMessage };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "打开资源管理器失败",
    };
  }
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
  let localSyncRoot;
  try {
    localSyncRoot = resolveProjectLocalSyncRoot(projectPath, config || {});
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "本地同步目录无效。",
    };
  }
  const existsResult = await assertLocalSyncRootExists(localSyncRoot);
  if (!existsResult.ok) {
    return existsResult;
  }

  configStore.setProjectConfig(projectPath, config || {});
  configStore.setLastProjectPath(projectPath);
  await configStore.flush();

  if (
    syncService &&
    activeSyncProjectPath &&
    path.resolve(activeSyncProjectPath) === path.resolve(projectPath)
  ) {
    const savedConfig = configStore.getProjectConfig(projectPath);
    syncService.updateIgnorePaths(savedConfig.ignorePaths);
  }

  return { ok: true, localSyncRoot };
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

  let localSyncRoot;
  try {
    localSyncRoot = resolveProjectLocalSyncRoot(projectPath, mergedConfig);
  } catch (error) {
    await projectLockManager.release(projectPath);
    return {
      ok: false,
      message: error && error.message ? error.message : "本地同步目录无效。",
    };
  }

  const existsResult = await assertLocalSyncRootExists(localSyncRoot);
  if (!existsResult.ok) {
    await projectLockManager.release(projectPath);
    return existsResult;
  }

  syncService = new FtpSyncService({
    projectPath: localSyncRoot,
    config: mergedConfig,
    ignorePaths: mergedConfig.ignorePaths,
    onLog: sendLog,
  });

  try {
    await syncService.start();
    setActiveSyncService(syncService);
    activeSyncProjectPath = path.resolve(projectPath);
    if (localSyncRoot !== path.resolve(projectPath)) {
      sendLog("info", `本地同步根目录: ${localSyncRoot}`);
    }
    return { ok: true, localSyncRoot };
  } catch (error) {
    clearActiveSyncService(syncService);
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

ipcMain.handle("ftp:force-disconnect", async () => {
  const result = forceDisconnectAll();
  const parts = [`已关闭 ${result.closedCount} 个本实例 FTP 连接`];
  if (result.syncConnectionClosed) {
    parts.push("监听长连接已断开");
  }
  if (result.watcherStillRunning) {
    parts.push("文件监听仍在运行，下次同步时将自动重连");
  }
  sendLog("info", `${parts.join("；")}。`);
  if (result.closedCount === 0 && !result.syncConnectionClosed) {
    sendLog(
      "info",
      "当前本实例无活跃 FTP 连接。若仍出现 421，说明连接被其他软件或其他窗口占用，请等待服务器释放或到面板清理会话。"
    );
  } else {
    sendLog(
      "warn",
      "此操作无法断开其他软件或其他应用实例占用的 FTP 连接；若仍 421，请稍候或在服务器面板清理会话。"
    );
  }
  return {
    ok: true,
    ...result,
    message: parts.join("；"),
  };
});

ipcMain.handle("list-local-dir", async (_event, payload) => {
  const { projectPath, targetPath, localBasePath } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }

  let localSyncRoot;
  try {
    localSyncRoot = resolveProjectLocalSyncRoot(projectPath, {
      localBasePath:
        localBasePath !== undefined
          ? localBasePath
          : configStore.getProjectConfig(projectPath).localBasePath,
    });
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "本地同步目录无效。",
    };
  }

  const resolvedRoot = path.resolve(localSyncRoot);
  const resolvedTargetPath = path.resolve(targetPath || resolvedRoot);
  const relativePath = path.relative(resolvedRoot, resolvedTargetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { ok: false, message: "目录超出本地同步目录范围。" };
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
      resolvedTargetPath === resolvedRoot ? null : path.dirname(resolvedTargetPath);

    return {
      ok: true,
      path: resolvedTargetPath,
      parentPath,
      localSyncRoot: resolvedRoot,
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
    const localSyncRoot = resolveProjectLocalSyncRoot(projectPath, config || {});
    await syncLocalToRemote({
      projectPath: localSyncRoot,
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

  let localSyncRoot;
  try {
    localSyncRoot = resolveProjectLocalSyncRoot(projectPath, config);
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "本地同步目录无效。",
    };
  }

  const collectResult = await collectGitUnstagedFileEntries(projectPath, {
    mapRoot: localSyncRoot,
  });
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
      `已跳过 ${collectResult.skippedOutsideProject.length} 个位于 Git 仓库内、但不在本地同步目录下的变更。`
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

  if (path.resolve(localSyncRoot) !== path.resolve(projectPath)) {
    sendLog("info", `Git 变更将按本地同步目录映射: ${localSyncRoot}`);
  } else if (
    collectResult.gitRoot &&
    path.resolve(collectResult.gitRoot) !== path.resolve(projectPath)
  ) {
    sendLog(
      "info",
      `Git 仓库根目录为 ${collectResult.gitRoot}，已按项目目录 ${path.resolve(projectPath)} 解析相对路径。`
    );
  }

  try {
    const result = await syncFilesList({
      projectPath: localSyncRoot,
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

ipcMain.handle("extract:git-list-options", async (_event, payload) => {
  const { projectPath, limit } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }

  try {
    const result = await listGitExtractOptions(projectPath, limit);
    if (!result.ok) {
      return {
        ok: false,
        message: result.message || "读取 Git 提交列表失败。",
        code: result.code,
      };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "读取 Git 提交列表失败",
    };
  }
});

ipcMain.handle("extract:git-since-ref", async (_event, payload) => {
  const { projectPath, ref } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }
  if (!ref) {
    return { ok: false, message: "请选择要提取的 Git 选项。" };
  }

  try {
    const result = await extractGitSinceRef(projectPath, ref);
    if (!result.ok && result.code) {
      return {
        ok: false,
        message: result.message || "获取 Git 变更失败。",
        code: result.code,
      };
    }

    if (result.total === 0) {
      sendLog("info", result.message || "没有需要提取的文件。");
    }

    return result;
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "提取 Git 变更失败",
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
    const localSyncRoot = resolveProjectLocalSyncRoot(projectPath, config || {});
    await syncRemoteToLocal({
      projectPath: localSyncRoot,
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
    const localSyncRoot = resolveProjectLocalSyncRoot(projectPath, config || {});
    await syncServerToLocalByLocalPath({
      projectPath: localSyncRoot,
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
    const localSyncRoot = resolveProjectLocalSyncRoot(projectPath, config || {});
    await syncLocalToServerByRemotePath({
      projectPath: localSyncRoot,
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

ipcMain.handle("sync:preview-extras", async (_event, payload) => {
  const { projectPath, config, localPath, remotePath, itemType, direction } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }
  if (!direction) {
    return { ok: false, message: "未指定同步方向。" };
  }

  try {
    const localSyncRoot = resolveProjectLocalSyncRoot(projectPath, config || {});
    const result = await previewSyncExtras({
      projectPath: localSyncRoot,
      config: config || {},
      localPath,
      remotePath,
      itemType,
      direction,
      onLog: sendLog,
    });
    return result;
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "差异检测失败",
    };
  }
});

ipcMain.handle("sync:apply-extras-deletion", async (_event, payload) => {
  const { projectPath, config, localPath, remotePath, orphanSide, orphans } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }

  try {
    const localSyncRoot = resolveProjectLocalSyncRoot(projectPath, config || {});
    const result = await applySyncExtrasDeletion({
      projectPath: localSyncRoot,
      config: config || {},
      localPath,
      remotePath,
      orphanSide,
      orphans,
      onLog: sendLog,
    });
    return result;
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "删除多余文件失败",
    };
  }
});

ipcMain.handle("delete-local-path", async (_event, payload) => {
  const { projectPath, config, targetPath } = payload || {};
  if (!projectPath) {
    return { ok: false, message: "请先选择项目目录。" };
  }
  if (!targetPath) {
    return { ok: false, message: "未指定要删除的本地路径。" };
  }

  try {
    const localSyncRoot = resolveProjectLocalSyncRoot(projectPath, config || {});
    await deleteLocalPathItem({
      projectPath: localSyncRoot,
      targetPath,
      onLog: sendLog,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "删除本地文件失败",
    };
  }
});

ipcMain.handle("delete-remote-path", async (_event, payload) => {
  const { config, remotePath, itemType } = payload || {};
  if (!remotePath) {
    return { ok: false, message: "未指定要删除的远程路径。" };
  }

  try {
    await deleteRemotePathItem({
      config: config || {},
      remotePath,
      itemType,
      onLog: sendLog,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error && error.message ? error.message : "删除远程文件失败",
    };
  }
});
