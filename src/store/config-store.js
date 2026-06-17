const fs = require("fs/promises");
const path = require("path");

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
    return this.state.projects[projectPath] || {
      type: "ftp",
      host: "",
      port: 21,
      username: "",
      password: "",
      remoteBasePath: "/",
    };
  }

  setProjectConfig(projectPath, config) {
    this.state.projects[projectPath] = {
      type: config.type || "ftp",
      host: config.host || "",
      port: Number(config.port) || 21,
      username: config.username || "",
      password: config.password || "",
      remoteBasePath: config.remoteBasePath || "/",
    };
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
};
