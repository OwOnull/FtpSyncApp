const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const crypto = require("crypto");

function normalizeProjectPath(projectPath) {
  return path.resolve(projectPath || "");
}

function hashProjectPath(projectPath) {
  return crypto.createHash("sha1").update(projectPath).digest("hex");
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

class ProjectLockManager {
  constructor(userDataPath) {
    this.lockRoot = path.join(userDataPath, "locks");
    this.heldLocks = new Map();
  }

  getLockFilePath(projectPath) {
    const normalized = normalizeProjectPath(projectPath);
    const fileName = `${hashProjectPath(normalized)}.lock`;
    return path.join(this.lockRoot, fileName);
  }

  async ensureLockRoot() {
    await fsPromises.mkdir(this.lockRoot, { recursive: true });
  }

  async readLockInfo(lockPath) {
    try {
      const content = await fsPromises.readFile(lockPath, "utf8");
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  async removeLockFile(lockPath) {
    try {
      await fsPromises.unlink(lockPath);
    } catch (_error) {
      // 文件不存在或删除失败时忽略，避免影响后续流程。
    }
  }

  async tryAcquire(projectPath) {
    const normalized = normalizeProjectPath(projectPath);
    if (!normalized) {
      return { ok: false, message: "项目路径不能为空。" };
    }

    const existing = this.heldLocks.get(normalized);
    if (existing && existing.fd) {
      return { ok: true };
    }

    await this.ensureLockRoot();
    const lockPath = this.getLockFilePath(normalized);

    try {
      const fd = await fsPromises.open(lockPath, "wx");
      const payload = {
        pid: process.pid,
        projectPath: normalized,
        createdAt: Date.now(),
      };
      await fd.writeFile(JSON.stringify(payload, null, 2), "utf8");
      this.heldLocks.set(normalized, { fd, lockPath });
      return { ok: true };
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        return { ok: false, message: "项目锁创建失败，请稍后重试。" };
      }

      const lockInfo = await this.readLockInfo(lockPath);
      if (lockInfo && !isProcessAlive(Number(lockInfo.pid))) {
        await this.removeLockFile(lockPath);
        return this.tryAcquire(normalized);
      }

      return { ok: false, message: "该项目已在其他窗口/实例同步中。" };
    }
  }

  async release(projectPath) {
    const normalized = normalizeProjectPath(projectPath);
    const held = this.heldLocks.get(normalized);
    if (!held) {
      return;
    }

    this.heldLocks.delete(normalized);
    try {
      await held.fd.close();
    } catch (_error) {
      // fd 已关闭时忽略。
    }
    await this.removeLockFile(held.lockPath);
  }

  async releaseAll() {
    const projectPaths = Array.from(this.heldLocks.keys());
    for (const projectPath of projectPaths) {
      await this.release(projectPath);
    }
  }
}

module.exports = {
  ProjectLockManager,
};
