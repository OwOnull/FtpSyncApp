const fs = require("fs/promises");
const path = require("path");

function normalizeIgnorePaths(value) {
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

class ConfigStore {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.configFilePath = path.join(userDataPath, "project-ftp-sync-config.json");
    this.state = {
      lastProjectPath: "",
      projects: {},
    };
  }

  async init() {
    try {
      const content = await fs.readFile(this.configFilePath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object") {
        this.state.lastProjectPath = parsed.lastProjectPath || "";
        this.state.projects = parsed.projects || {};
      }
    } catch (_error) {
      // 配置文件不存在时使用默认值。
    }
  }

  getLastProjectPath() {
    return this.state.lastProjectPath || "";
  }

  setLastProjectPath(projectPath) {
    this.state.lastProjectPath = projectPath || "";
  }

  getProjectConfig(projectPath) {
    const stored = this.state.projects[projectPath] || {};
    return {
      type: stored.type || "ftp",
      host: stored.host || "",
      port: Number(stored.port) || 21,
      username: stored.username || "",
      password: stored.password || "",
      remoteBasePath: stored.remoteBasePath || "/",
      ignorePaths: normalizeIgnorePaths(stored.ignorePaths),
      alias: typeof stored.alias === "string" ? stored.alias.trim() : "",
    };
  }

  setProjectConfig(projectPath, config) {
    const existing = this.state.projects[projectPath] || {};
    const nextAlias =
      config && Object.prototype.hasOwnProperty.call(config, "alias")
        ? String(config.alias || "").trim()
        : typeof existing.alias === "string"
          ? existing.alias.trim()
          : "";
    this.state.projects[projectPath] = {
      type: config.type || "ftp",
      host: config.host || "",
      port: Number(config.port) || 21,
      username: config.username || "",
      password: config.password || "",
      remoteBasePath: config.remoteBasePath || "/",
      ignorePaths: normalizeIgnorePaths(config.ignorePaths),
      alias: nextAlias,
    };
  }

  setProjectAlias(projectPath, alias) {
    const targetPath = String(projectPath || "");
    if (!targetPath) {
      return false;
    }
    const existing = this.getProjectConfig(targetPath);
    this.setProjectConfig(targetPath, {
      ...existing,
      alias: String(alias || "").trim(),
    });
    return true;
  }

  listProjectPaths() {
    return Object.keys(this.state.projects || {});
  }

  listProjectHistory() {
    return this.listProjectPaths().map((projectPath) => {
      const config = this.getProjectConfig(projectPath);
      return {
        path: projectPath,
        alias: config.alias || "",
      };
    });
  }

  removeProject(projectPath) {
    const targetPath = String(projectPath || "");
    if (!targetPath) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(this.state.projects, targetPath)) {
      return false;
    }
    delete this.state.projects[targetPath];
    if (this.state.lastProjectPath === targetPath) {
      this.state.lastProjectPath = "";
    }
    return true;
  }

  async flush() {
    await fs.mkdir(path.dirname(this.configFilePath), { recursive: true });
    await fs.writeFile(
      this.configFilePath,
      JSON.stringify(this.state, null, 2),
      "utf8"
    );
  }
}

module.exports = {
  ConfigStore,
  normalizeIgnorePaths,
};
