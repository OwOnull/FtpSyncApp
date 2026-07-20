const path = require("path");
const fs = require("fs/promises");
const chokidar = require("chokidar");
const ftp = require("basic-ftp");

const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/runtime/**",
  "**/.idea/**",
  "**/.vscode/**",
  "**/dist/**",
  "**/build/**",
];

const DEFAULT_IGNORE_SEGMENTS = [
  ".git",
  "node_modules",
  "runtime",
  ".idea",
  ".vscode",
  "dist",
  "build",
];

const DEFAULT_CONNECT_RETRY_OPTIONS = {
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 4000,
};

const TOO_MANY_CONNECTIONS_BACKOFF_MS = 3000;

class FtpConnectionManager {
  constructor() {
    this.activeClients = new Set();
    this.operationQueue = Promise.resolve();
    this.syncServiceRef = null;
  }

  setSyncService(service) {
    this.syncServiceRef = service || null;
  }

  clearSyncService(service) {
    if (service && this.syncServiceRef !== service) {
      return;
    }
    this.syncServiceRef = null;
  }

  register(client) {
    if (client) {
      this.activeClients.add(client);
    }
  }

  unregister(client) {
    if (client) {
      this.activeClients.delete(client);
    }
  }

  closeClient(client) {
    if (!client) {
      return false;
    }
    try {
      client.close();
    } catch (_error) {
      // close 失败不影响后续流程。
    }
    this.unregister(client);
    return true;
  }

  runExclusive(operation) {
    const run = this.operationQueue.then(() => operation());
    this.operationQueue = run.catch(() => {});
    return run;
  }

  async suspendSyncConnectionIfNeeded() {
    const syncService = this.syncServiceRef;
    if (!syncService || !syncService.isRunning || !syncService.client) {
      return false;
    }
    syncService.closeClientSafe();
    return true;
  }

  async resumeSyncConnectionIfNeeded(wasSuspended) {
    if (!wasSuspended) {
      return;
    }
    const syncService = this.syncServiceRef;
    if (!syncService || !syncService.isRunning || syncService.client) {
      return;
    }
    await syncService.connectWithRetry("FTP 恢复连接");
    syncService.log("info", "临时操作完成，监听 FTP 连接已恢复。");
  }

  forceDisconnectAll() {
    let closedCount = 0;
    for (const client of [...this.activeClients]) {
      if (this.closeClient(client)) {
        closedCount += 1;
      }
    }

    let syncConnectionClosed = false;
    let watcherStillRunning = false;
    const syncService = this.syncServiceRef;
    if (syncService) {
      syncService.forceDisconnectFtp();
      syncConnectionClosed = !syncService.client;
      watcherStillRunning = Boolean(syncService.isRunning && syncService.watcher);
    }

    return {
      closedCount,
      syncConnectionClosed,
      watcherStillRunning,
    };
  }
}

const ftpConnectionManager = new FtpConnectionManager();

function parseIgnorePaths(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function globMatch(text, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(text);
}

function matchesDefaultIgnore(relativeUnixPath) {
  const parts = relativeUnixPath.split("/").filter(Boolean);
  return parts.some((part) => DEFAULT_IGNORE_SEGMENTS.includes(part));
}

function matchesUserIgnorePattern(relativeUnixPath, pattern) {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.includes("*") || normalizedPattern.includes("?")) {
    const basename = relativeUnixPath.split("/").pop() || relativeUnixPath;
    return (
      globMatch(relativeUnixPath, normalizedPattern) ||
      globMatch(basename, normalizedPattern)
    );
  }

  if (normalizedPattern.includes("/")) {
    return (
      relativeUnixPath === normalizedPattern ||
      relativeUnixPath.startsWith(`${normalizedPattern}/`)
    );
  }

  const parts = relativeUnixPath.split("/").filter(Boolean);
  return (
    relativeUnixPath === normalizedPattern ||
    relativeUnixPath.startsWith(`${normalizedPattern}/`) ||
    parts.includes(normalizedPattern)
  );
}

function createIgnoreChecker(projectPath, userPatterns) {
  const resolvedProjectPath = path.resolve(projectPath);
  const userIgnoreList = parseIgnorePaths(userPatterns);

  return function isIgnored(filePath) {
    const resolvedFilePath = path.resolve(filePath);
    const relativePath = path.relative(resolvedProjectPath, resolvedFilePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return true;
    }

    const relativeUnixPath = relativePath.split(path.sep).join("/");
    if (matchesDefaultIgnore(relativeUnixPath)) {
      return true;
    }

    return userIgnoreList.some((pattern) =>
      matchesUserIgnorePattern(relativeUnixPath, pattern)
    );
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  return error && error.message ? String(error.message) : "未知错误";
}

function isTooManyConnectionsError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("421") || message.includes("too many connections");
}

function isRetryableConnectionError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    isTooManyConnectionsError(error) ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("not connected")
  );
}

function formatFriendlyConnectError(error) {
  const message = getErrorMessage(error);
  if (isTooManyConnectionsError(error)) {
    return `${message}（服务器连接数已满，请稍后重试或减少并发实例）`;
  }
  return message;
}

async function accessClientWithRetry(client, config, options = {}) {
  const retryOptions = {
    ...DEFAULT_CONNECT_RETRY_OPTIONS,
    ...(options.retry || {}),
  };

  let lastError = null;
  for (let attempt = 0; attempt < retryOptions.maxRetries; attempt += 1) {
    try {
      await client.access({
        host: config.host,
        port: Number(config.port) || 21,
        user: config.username,
        password: config.password,
        secure: false,
      });
      return;
    } catch (error) {
      lastError = error;
      const nextAttempt = attempt + 1;
      if (!isRetryableConnectionError(error) || nextAttempt >= retryOptions.maxRetries) {
        break;
      }
      const delayMs = Math.min(
        retryOptions.maxDelayMs,
        retryOptions.initialDelayMs * (2 ** attempt)
      );
      if (typeof options.onRetry === "function") {
        options.onRetry({
          attempt: nextAttempt,
          total: retryOptions.maxRetries,
          delayMs,
          error,
        });
      }
      await sleep(delayMs);
    }
  }

  throw lastError;
}

class FtpSyncService {
  constructor(options) {
    this.projectPath = options.projectPath;
    this.config = options.config;
    this.ignorePaths = parseIgnorePaths(
      options.ignorePaths !== undefined ? options.ignorePaths : options.config?.ignorePaths
    );
    this.ignoreChecker = createIgnoreChecker(this.projectPath, this.ignorePaths);
    this.onLog = options.onLog || (() => {});
    this.client = null;
    this.watcher = null;
    this.eventTimer = null;
    this.eventQueue = new Map();
    this.isRunning = false;
    this.connectionLock = null;
    this.connectRetry = {
      ...DEFAULT_CONNECT_RETRY_OPTIONS,
      ...(options.connectRetry || {}),
    };
  }

  log(level, message) {
    this.onLog(level, message);
  }

  attachClientHooks(client) {
    client.ftp.verbose = false;
    client.trackProgress((info) => {
      if (info.type === "upload") {
        this.log("info", `已上传: ${info.name}`);
      }
    });
  }

  closeClientSafe() {
    if (!this.client) {
      return;
    }
    const closingClient = this.client;
    this.client = null;
    ftpConnectionManager.closeClient(closingClient);
  }

  forceDisconnectFtp() {
    this.closeClientSafe();
  }

  async connectWithRetry(reasonLabel) {
    let lastError = null;
    for (let attempt = 0; attempt < this.connectRetry.maxRetries; attempt += 1) {
      this.closeClientSafe();
      const client = new ftp.Client(0);
      this.attachClientHooks(client);
      ftpConnectionManager.register(client);
      this.client = client;

      try {
        await accessClientWithRetry(this.client, this.config, {
          retry: {
            maxRetries: 1,
            initialDelayMs: this.connectRetry.initialDelayMs,
            maxDelayMs: this.connectRetry.maxDelayMs,
          },
        });
        return;
      } catch (error) {
        lastError = error;
        const nextAttempt = attempt + 1;
        const friendlyMessage = formatFriendlyConnectError(error);
        if (!isRetryableConnectionError(error) || nextAttempt >= this.connectRetry.maxRetries) {
          break;
        }
        const delayMs = Math.min(
          this.connectRetry.maxDelayMs,
          this.connectRetry.initialDelayMs * (2 ** attempt)
        );
        const backoffMs = isTooManyConnectionsError(error)
          ? Math.max(delayMs, TOO_MANY_CONNECTIONS_BACKOFF_MS * (attempt + 1))
          : delayMs;
        this.log(
          "warn",
          `${reasonLabel}失败（第 ${nextAttempt}/${this.connectRetry.maxRetries} 次）：${friendlyMessage}，${backoffMs}ms 后重试。`
        );
        if (isTooManyConnectionsError(error)) {
          this.closeClientSafe();
          this.log("warn", "FTP 服务器返回 421/连接数过多，建议稍等后再试或减少并行同步实例。");
          this.log(
            "warn",
            "若仍无法连接，请使用「断开 FTP 连接」释放本实例连接，或到服务器面板清理会话。"
          );
        }
        await sleep(backoffMs);
      }
    }

    throw new Error(`FTP 连接失败: ${formatFriendlyConnectError(lastError)}`);
  }

  async reconnectWithLock(reason) {
    if (this.connectionLock) {
      await this.connectionLock;
      return;
    }
    this.connectionLock = (async () => {
      this.log("info", `正在重连 FTP（原因：${reason}）`);
      await this.connectWithRetry("FTP 重连");
      this.log("info", "FTP 重连成功。");
    })();
    try {
      await this.connectionLock;
    } finally {
      this.connectionLock = null;
    }
  }

  async runWithReconnect(operationName, handler) {
    try {
      return await handler();
    } catch (error) {
      if (!isRetryableConnectionError(error)) {
        throw error;
      }
      const friendlyMessage = formatFriendlyConnectError(error);
      this.log(
        "warn",
        `${operationName}遇到连接异常：${friendlyMessage}，将关闭旧连接后重连并重试一次。`
      );
      if (isTooManyConnectionsError(error)) {
        this.closeClientSafe();
      }
      await this.reconnectWithLock(friendlyMessage);
      return handler();
    }
  }

  async start() {
    this.log(
      "info",
      `正在连接 FTP: ${this.config.host}:${Number(this.config.port) || 21}`
    );

    await this.connectWithRetry("FTP 连接");

    this.isRunning = true;
    this.startWatching();
    this.log("info", "FTP 连接成功，开始监听文件变化。");
  }

  startWatching() {
    this.watcher = chokidar.watch(this.projectPath, {
      ignoreInitial: true,
      persistent: true,
      ignored: (filePath) => this.ignoreChecker(filePath),
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on("all", (eventName, filePath) => {
      this.enqueueEvent(eventName, filePath);
    });

    this.watcher.on("error", (error) => {
      this.log("error", `监听器错误: ${error.message || String(error)}`);
    });
  }

  updateIgnorePaths(ignorePaths) {
    this.ignorePaths = parseIgnorePaths(ignorePaths);
    this.ignoreChecker = createIgnoreChecker(this.projectPath, this.ignorePaths);

    if (!this.isRunning || !this.watcher) {
      return;
    }

    this.watcher.close();
    this.watcher = null;
    this.startWatching();
    this.log("info", "忽略路径已更新，文件监听器已重启。");
  }

  enqueueEvent(eventName, filePath) {
    if (this.ignoreChecker(filePath)) {
      return;
    }

    const key = filePath;
    this.eventQueue.set(key, { eventName, filePath, at: Date.now() });

    if (this.eventTimer) {
      clearTimeout(this.eventTimer);
    }

    this.eventTimer = setTimeout(async () => {
      const queue = Array.from(this.eventQueue.values());
      this.eventQueue.clear();
      await this.processQueue(queue);
    }, 220);
  }

  normalizeRemotePath(localPath) {
    return localPathToRemote(
      this.projectPath,
      this.config.remoteBasePath,
      localPath
    );
  }

  async processQueue(queue) {
    if (!this.isRunning) {
      return;
    }

    if (!this.client) {
      try {
        await this.reconnectWithLock("监听同步恢复连接");
      } catch (error) {
        this.log(
          "error",
          `监听同步恢复 FTP 连接失败: ${formatFriendlyConnectError(error)}`
        );
        return;
      }
    }

    const pending = queue.filter((item) => !this.ignoreChecker(item.filePath));

    for (const item of pending) {
      const remotePath = this.normalizeRemotePath(item.filePath);
      try {
        if (item.eventName === "add" || item.eventName === "change") {
          await this.runWithReconnect(`${item.eventName} 上传`, async () => {
            await this.ensureRemoteDir(remotePath);
            await this.client.uploadFrom(item.filePath, remotePath);
          });
          this.log("info", `${item.eventName} -> 上传 ${remotePath}`);
        } else if (item.eventName === "addDir") {
          await this.runWithReconnect("创建目录", () => this.client.ensureDir(remotePath));
          this.log("info", `创建远程目录 ${remotePath}`);
        } else if (item.eventName === "unlink") {
          await this.runWithReconnect("删除文件", () => this.client.remove(remotePath));
          this.log("info", `删除远程文件 ${remotePath}`);
        } else if (item.eventName === "unlinkDir") {
          await this.runWithReconnect("删除目录", () => this.client.removeDir(remotePath));
          this.log("info", `删除远程目录 ${remotePath}`);
        }
      } catch (error) {
        const message = formatFriendlyConnectError(error);
        this.log(
          "error",
          `${item.eventName} 同步失败: ${remotePath}，原因: ${message}`
        );
      }
    }
  }

  async ensureRemoteDir(remotePath) {
    const lastSlash = remotePath.lastIndexOf("/");
    const parentDir = lastSlash > 0 ? remotePath.slice(0, lastSlash) : "/";
    await this.client.ensureDir(parentDir || "/");
  }

  stop() {
    this.isRunning = false;
    this.eventQueue.clear();
    if (this.eventTimer) {
      clearTimeout(this.eventTimer);
      this.eventTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.client) {
      this.closeClientSafe();
    }
  }
}

async function listRemoteDirWithConfig(config, targetPath, options = {}) {
  if (!config || !config.host || !config.username) {
    throw new Error("请先完善 FTP 配置（主机、用户名）");
  }

  return ftpConnectionManager.runExclusive(async () => {
    const suspendedSync = await ftpConnectionManager.suspendSyncConnectionIfNeeded();
    const client = new ftp.Client(0);
    client.ftp.verbose = false;
    ftpConnectionManager.register(client);
    const basePath = (config.remoteBasePath || "/").replace(/\\/g, "/");
    const normalizedBasePath = basePath.startsWith("/") ? basePath : `/${basePath}`;
    const currentPath = (targetPath || normalizedBasePath || "/").replace(/\\/g, "/");

    try {
      await accessClientWithRetry(client, config, {
        onRetry: ({ attempt, total, delayMs, error }) => {
          if (typeof options?.onLog === "function") {
            options.onLog(
              "warn",
              `列目录连接重试（第 ${attempt}/${total} 次）：${formatFriendlyConnectError(error)}，${delayMs}ms 后重试。`
            );
          }
        },
      });

      const list = await client.list(currentPath);
      const items = list.map((item) => ({
        name: item.name,
        type: item.isDirectory ? "dir" : "file",
        path:
          currentPath === "/"
            ? `/${item.name}`
            : `${currentPath.replace(/\/$/, "")}/${item.name}`,
      }));

      const parentPath =
        currentPath === "/" ? null : currentPath.replace(/\/[^/]+\/?$/, "") || "/";

      return {
        path: currentPath,
        parentPath,
        items,
      };
    } finally {
      ftpConnectionManager.closeClient(client);
      await ftpConnectionManager.resumeSyncConnectionIfNeeded(suspendedSync);
    }
  });
}

function normalizeRelativeUnixPath(relativePath) {
  return String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
}

function buildProjectLocalPath(projectPath, relativePath) {
  const normalized = normalizeRelativeUnixPath(relativePath);
  if (!normalized) {
    return path.resolve(projectPath);
  }
  return path.join(
    path.resolve(projectPath),
    ...normalized.split("/").filter(Boolean)
  );
}

// git diff / ls-files 输出路径相对仓库根目录，先拼到 gitRoot 再换算 projectRel
function gitOutputToProjectRelative(gitRoot, projectPath, gitOutputPath) {
  const normalizedGitRel = normalizeRelativeUnixPath(gitOutputPath);
  if (!normalizedGitRel) {
    return null;
  }

  const absolutePath = path.resolve(gitRoot, normalizedGitRel);
  const resolvedProjectPath = path.resolve(projectPath);
  const projectRelative = path.relative(resolvedProjectPath, absolutePath);
  if (
    !projectRelative ||
    projectRelative.startsWith("..") ||
    path.isAbsolute(projectRelative)
  ) {
    return null;
  }

  return projectRelative.split(path.sep).join("/");
}

function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || "")) || String(value || "").startsWith("\\\\");
}

function assertPosixRemotePath(remotePath, label) {
  const normalized = String(remotePath || "").replace(/\\/g, "/");
  if (isWindowsAbsolutePath(normalized)) {
    throw new Error(`${label || "远程路径"}不能为 Windows 本地绝对路径: ${remotePath}`);
  }
  if (!normalized.startsWith("/")) {
    throw new Error(`${label || "远程路径"}必须为 posix 绝对路径: ${remotePath}`);
  }
  return normalized;
}

function joinPosixRemotePath(basePath, ...segments) {
  const base = String(basePath || "/").replace(/\\/g, "/");
  const safeBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const parts = segments
    .flatMap((segment) => String(segment || "").split("/"))
    .filter(Boolean);
  const combined = parts.length
    ? path.posix.join(safeBase || "/", ...parts)
    : safeBase || "/";
  return combined.startsWith("/") ? combined : `/${combined}`;
}

function localPathToRemote(projectPath, remoteBasePath, localPath) {
  const resolvedProjectPath = path.resolve(projectPath);
  const resolvedLocalPath = path.resolve(localPath);
  const relativePath = path.relative(resolvedProjectPath, resolvedLocalPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("本地路径超出当前项目范围。");
  }

  const base = (remoteBasePath || "/").replace(/\\/g, "/");
  const safeBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const relUnix = relativePath.split(path.sep).join("/");
  const remotePath = relUnix
    ? joinPosixRemotePath(safeBase || "/", relUnix)
    : joinPosixRemotePath(safeBase || "/");
  return assertPosixRemotePath(remotePath, "FTP 上传目标");
}

function remotePathToLocal(projectPath, remoteBasePath, remotePath) {
  const base = (remoteBasePath || "/").replace(/\\/g, "/");
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedRemote = (remotePath || "/").replace(/\\/g, "/");

  if (
    normalizedRemote !== normalizedBase &&
    !normalizedRemote.startsWith(`${normalizedBase}/`)
  ) {
    throw new Error("远程路径超出部署基路径范围。");
  }

  const relative =
    normalizedRemote === normalizedBase
      ? ""
      : normalizedRemote.slice(normalizedBase.length + 1);
  return relative
    ? path.join(projectPath, ...relative.split("/").filter(Boolean))
    : path.resolve(projectPath);
}

async function withFtpClient(config, handler, options = {}) {
  if (!config || !config.host || !config.username) {
    throw new Error("请先完善 FTP 配置（主机、用户名）。");
  }

  return ftpConnectionManager.runExclusive(async () => {
    const suspendedSync = await ftpConnectionManager.suspendSyncConnectionIfNeeded();
    const client = new ftp.Client(0);
    client.ftp.verbose = false;
    ftpConnectionManager.register(client);

    try {
      await accessClientWithRetry(client, config, {
        onRetry: (payload) => {
          if (typeof options.onRetry === "function") {
            options.onRetry(payload);
          }
        },
      });
      return await handler(client);
    } finally {
      ftpConnectionManager.closeClient(client);
      await ftpConnectionManager.resumeSyncConnectionIfNeeded(suspendedSync);
    }
  });
}

async function ensureRemoteParentDir(client, remotePath) {
  const lastSlash = remotePath.lastIndexOf("/");
  const parentDir = lastSlash > 0 ? remotePath.slice(0, lastSlash) : "/";
  await client.ensureDir(parentDir || "/");
}

async function syncLocalToRemote({ projectPath, config, localPath, onLog }) {
  const log = onLog || (() => {});
  const resolvedLocalPath = path.resolve(localPath);
  const remotePath = localPathToRemote(projectPath, config.remoteBasePath, resolvedLocalPath);

  let stat;
  try {
    stat = await fs.stat(resolvedLocalPath);
  } catch (error) {
    throw new Error("本地文件或目录不存在。");
  }

  await withFtpClient(config, async (client) => {
    if (stat.isDirectory()) {
      await client.ensureDir(remotePath);
      await client.uploadFromDir(resolvedLocalPath, remotePath);
      log("info", `已上传目录: ${resolvedLocalPath} -> ${remotePath}`);
      return;
    }

    await ensureRemoteParentDir(client, remotePath);
    await client.uploadFrom(resolvedLocalPath, remotePath);
    log("info", `已上传文件: ${resolvedLocalPath} -> ${remotePath}`);
  });
}

async function syncFilesList({ projectPath, config, fileEntries, onLog }) {
  const log = onLog || (() => {});
  const resolvedProjectPath = path.resolve(projectPath);
  const defaultIgnoreChecker = createIgnoreChecker(resolvedProjectPath, []);
  const entries = Array.isArray(fileEntries) ? fileEntries : [];

  const pending = [];
  let skipped = 0;

  for (const entry of entries) {
    const relativePath = normalizeRelativeUnixPath(entry.relativePath);
    if (!relativePath) {
      continue;
    }

    const localPath = buildProjectLocalPath(resolvedProjectPath, relativePath);
    if (defaultIgnoreChecker(localPath)) {
      skipped += 1;
      continue;
    }

    pending.push({
      relativePath,
      action: entry.action === "delete" ? "delete" : "upload",
      localPath,
    });
  }

  if (skipped > 0) {
    log("info", `已跳过 ${skipped} 个内置忽略路径下的文件。`);
  }

  if (pending.length === 0) {
    return { ok: true, total: 0, success: [], failed: [], skipped };
  }

  log("info", `找到 ${pending.length} 个待同步文件。`);

  const success = [];
  const failed = [];

  await withFtpClient(config, async (client) => {
    for (const entry of pending) {
      const remotePath = localPathToRemote(
        resolvedProjectPath,
        config.remoteBasePath,
        entry.localPath
      );

      try {
        if (entry.action === "delete") {
          await client.remove(remotePath);
          log("info", `[删除] ${entry.relativePath} -> ${remotePath}`);
          success.push({ relativePath: entry.relativePath, action: "delete" });
        } else {
          try {
            const stat = await fs.stat(entry.localPath);
            if (!stat.isFile()) {
              throw new Error(`路径解析错误，本地路径不是文件: ${entry.localPath}`);
            }
          } catch (error) {
            if (error && error.code === "ENOENT") {
              throw new Error(`路径解析错误，本地文件不存在: ${entry.localPath}`);
            }
            throw error;
          }

          await ensureRemoteParentDir(client, remotePath);
          await client.uploadFrom(entry.localPath, remotePath);
          log("info", `[上传] ${entry.relativePath} -> ${remotePath}`);
          success.push({ relativePath: entry.relativePath, action: "upload" });
        }
      } catch (error) {
        const message = error && error.message ? error.message : "未知错误";
        log("error", `[失败] ${entry.relativePath}：${message}`);
        failed.push({
          relativePath: entry.relativePath,
          action: entry.action,
          message,
        });
      }
    }
  });

  log(
    "info",
    `Git 变更同步完成：成功 ${success.length} 个，失败 ${failed.length} 个。`
  );

  return {
    ok: failed.length === 0,
    total: pending.length,
    success,
    failed,
    skipped,
  };
}

async function syncRemoteToLocal({ projectPath, config, remotePath, itemType, onLog }) {
  const log = onLog || (() => {});
  const normalizedRemotePath = assertPosixRemotePath(
    (remotePath || "/").replace(/\\/g, "/"),
    "FTP 下载源"
  );
  const localPath = remotePathToLocal(
    projectPath,
    config.remoteBasePath,
    normalizedRemotePath
  );

  await withFtpClient(config, async (client) => {
    if (itemType === "dir") {
      await fs.mkdir(localPath, { recursive: true });
      await client.downloadToDir(localPath, normalizedRemotePath);
      log("info", `已下载目录: ${normalizedRemotePath} -> ${localPath}`);
      return;
    }

    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await client.downloadTo(localPath, normalizedRemotePath);
    log("info", `已下载文件: ${normalizedRemotePath} -> ${localPath}`);
  });
}

async function syncServerToLocalByLocalPath({ projectPath, config, localPath, onLog }) {
  const resolvedLocalPath = path.resolve(localPath);
  const remotePath = localPathToRemote(projectPath, config.remoteBasePath, resolvedLocalPath);
  let itemType = "file";
  try {
    const stat = await fs.stat(resolvedLocalPath);
    itemType = stat.isDirectory() ? "dir" : "file";
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  await syncRemoteToLocal({
    projectPath,
    config,
    remotePath,
    itemType,
    onLog,
  });
}

async function syncLocalToServerByRemotePath({
  projectPath,
  config,
  remotePath,
  itemType,
  onLog,
}) {
  const normalizedRemotePath = assertPosixRemotePath(
    (remotePath || "/").replace(/\\/g, "/"),
    "FTP 上传源映射"
  );
  const localPath = remotePathToLocal(
    projectPath,
    config.remoteBasePath,
    normalizedRemotePath
  );

  await syncLocalToRemote({
    projectPath,
    config,
    localPath,
    onLog,
  });
}

function setActiveSyncService(service) {
  ftpConnectionManager.setSyncService(service);
}

function clearActiveSyncService(service) {
  ftpConnectionManager.clearSyncService(service);
}

function forceDisconnectAll() {
  return ftpConnectionManager.forceDisconnectAll();
}

module.exports = {
  FtpSyncService,
  FtpConnectionManager,
  listRemoteDirWithConfig,
  syncLocalToRemote,
  syncRemoteToLocal,
  syncServerToLocalByLocalPath,
  syncLocalToServerByRemotePath,
  syncFilesList,
  parseIgnorePaths,
  createIgnoreChecker,
  normalizeRelativeUnixPath,
  buildProjectLocalPath,
  gitOutputToProjectRelative,
  localPathToRemote,
  setActiveSyncService,
  clearActiveSyncService,
  forceDisconnectAll,
  DEFAULT_IGNORES,
  DEFAULT_IGNORE_SEGMENTS,
};
