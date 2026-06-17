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

class FtpSyncService {
  constructor(options) {
    this.projectPath = options.projectPath;
    this.config = options.config;
    this.onLog = options.onLog || (() => {});
    this.client = null;
    this.watcher = null;
    this.eventTimer = null;
    this.eventQueue = new Map();
    this.isRunning = false;
  }

  log(level, message) {
    this.onLog(level, message);
  }

  async start() {
    this.client = new ftp.Client(0);
    this.client.ftp.verbose = false;

    this.client.trackProgress((info) => {
      if (info.type === "upload") {
        this.log("info", `已上传: ${info.name}`);
      }
    });

    this.log(
      "info",
      `正在连接 FTP: ${this.config.host}:${Number(this.config.port) || 21}`
    );

    try {
      await this.client.access({
        host: this.config.host,
        port: Number(this.config.port) || 21,
        user: this.config.username,
        password: this.config.password,
        secure: false,
      });
    } catch (error) {
      const msg = error && error.message ? error.message : "未知连接错误";
      this.log("error", `FTP 连接失败: ${msg}`);
      throw new Error(`FTP 连接失败: ${msg}`);
    }

    this.isRunning = true;
    this.startWatching();
    this.log("info", "FTP 连接成功，开始监听文件变化。");
  }

  startWatching() {
    this.watcher = chokidar.watch(this.projectPath, {
      ignoreInitial: true,
      persistent: true,
      ignored: DEFAULT_IGNORES,
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

  enqueueEvent(eventName, filePath) {
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
    const relativePath = path.relative(this.projectPath, localPath);
    const base = (this.config.remoteBasePath || "/").replace(/\\/g, "/");
    const safeBase = base.endsWith("/") ? base.slice(0, -1) : base;
    const relUnix = relativePath.split(path.sep).join("/");
    const combined = `${safeBase}/${relUnix}`.replace(/\/+/g, "/");
    return combined.startsWith("/") ? combined : `/${combined}`;
  }

  async processQueue(queue) {
    if (!this.isRunning || !this.client) {
      return;
    }

    for (const item of queue) {
      const remotePath = this.normalizeRemotePath(item.filePath);
      try {
        if (item.eventName === "add" || item.eventName === "change") {
          await this.ensureRemoteDir(remotePath);
          await this.client.uploadFrom(item.filePath, remotePath);
          this.log("info", `${item.eventName} -> 上传 ${remotePath}`);
        } else if (item.eventName === "addDir") {
          await this.client.ensureDir(remotePath);
          this.log("info", `创建远程目录 ${remotePath}`);
        } else if (item.eventName === "unlink") {
          await this.client.remove(remotePath);
          this.log("info", `删除远程文件 ${remotePath}`);
        } else if (item.eventName === "unlinkDir") {
          await this.client.removeDir(remotePath);
          this.log("info", `删除远程目录 ${remotePath}`);
        }
      } catch (error) {
        const message = error && error.message ? error.message : "未知错误";
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
      this.client.close();
      this.client = null;
    }
  }
}

async function listRemoteDirWithConfig(config, targetPath) {
  if (!config || !config.host || !config.username) {
    throw new Error("请先完善 FTP 配置（主机、用户名）");
  }

  const client = new ftp.Client(0);
  client.ftp.verbose = false;
  const basePath = (config.remoteBasePath || "/").replace(/\\/g, "/");
  const normalizedBasePath = basePath.startsWith("/") ? basePath : `/${basePath}`;
  const currentPath = (targetPath || normalizedBasePath || "/").replace(/\\/g, "/");

  try {
    await client.access({
      host: config.host,
      port: Number(config.port) || 21,
      user: config.username,
      password: config.password,
      secure: false,
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
    client.close();
  }
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
  const combined = relUnix
    ? `${safeBase}/${relUnix}`.replace(/\/+/g, "/")
    : safeBase || "/";
  return combined.startsWith("/") ? combined : `/${combined}`;
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

async function withFtpClient(config, handler) {
  if (!config || !config.host || !config.username) {
    throw new Error("请先完善 FTP 配置（主机、用户名）。");
  }

  const client = new ftp.Client(0);
  client.ftp.verbose = false;

  try {
    await client.access({
      host: config.host,
      port: Number(config.port) || 21,
      user: config.username,
      password: config.password,
      secure: false,
    });
    return await handler(client);
  } finally {
    client.close();
  }
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

async function syncRemoteToLocal({ projectPath, config, remotePath, itemType, onLog }) {
  const log = onLog || (() => {});
  const normalizedRemotePath = (remotePath || "/").replace(/\\/g, "/");
  const localPath = remotePathToLocal(
    projectPath,
    config.remoteBasePath,
    normalizedRemotePath
  );

  await withFtpClient(config, async (client) => {
    if (itemType === "dir") {
      await fs.mkdir(localPath, { recursive: true });
      await client.downloadToDir(normalizedRemotePath, localPath);
      log("info", `已下载目录: ${normalizedRemotePath} -> ${localPath}`);
      return;
    }

    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await client.downloadTo(normalizedRemotePath, localPath);
    log("info", `已下载文件: ${normalizedRemotePath} -> ${localPath}`);
  });
}

module.exports = {
  FtpSyncService,
  listRemoteDirWithConfig,
  syncLocalToRemote,
  syncRemoteToLocal,
};
