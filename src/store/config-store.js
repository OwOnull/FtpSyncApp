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

function normalizeHistoryOrder(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const ordered = [];
  for (const item of value) {
    const projectPath = String(item || "").trim();
    if (!projectPath || seen.has(projectPath)) {
      continue;
    }
    seen.add(projectPath);
    ordered.push(projectPath);
  }
  return ordered;
}

class ConfigStore {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.configFilePath = path.join(userDataPath, "project-ftp-sync-config.json");
    this.state = {
      lastProjectPath: "",
      projects: {},
      projectHistoryOrder: [],
    };
  }

  async init() {
    try {
      const content = await fs.readFile(this.configFilePath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object") {
        this.state.lastProjectPath = parsed.lastProjectPath || "";
        this.state.projects = parsed.projects || {};
        const hadSavedOrder =
          Array.isArray(parsed.projectHistoryOrder) && parsed.projectHistoryOrder.length > 0;
        this.state.projectHistoryOrder = normalizeHistoryOrder(parsed.projectHistoryOrder);
        this.ensureHistoryOrderCoversProjects();
        if (!hadSavedOrder && this.state.lastProjectPath) {
          const last = this.state.lastProjectPath;
          this.state.projectHistoryOrder = [
            last,
            ...this.state.projectHistoryOrder.filter((item) => item !== last),
          ];
        }
      }
    } catch (_error) {
      // 配置文件不存在时使用默认值。
    }
  }

  ensureHistoryOrderCoversProjects() {
    const known = new Set(Object.keys(this.state.projects || {}));
    const last = this.state.lastProjectPath || "";
    if (last) {
      known.add(last);
    }
    const current = normalizeHistoryOrder(this.state.projectHistoryOrder).filter((projectPath) =>
      known.has(projectPath)
    );
    const present = new Set(current);
    for (const projectPath of known) {
      if (!present.has(projectPath)) {
        current.push(projectPath);
        present.add(projectPath);
      }
    }
    this.state.projectHistoryOrder = current;
  }

  ensureProjectInHistoryOrder(projectPath, { prepend = false } = {}) {
    const targetPath = String(projectPath || "").trim();
    if (!targetPath) {
      return;
    }
    const order = normalizeHistoryOrder(this.state.projectHistoryOrder);
    const index = order.indexOf(targetPath);
    if (index >= 0) {
      this.state.projectHistoryOrder = order;
      return;
    }
    if (prepend) {
      order.unshift(targetPath);
    } else {
      order.push(targetPath);
    }
    this.state.projectHistoryOrder = order;
  }

  getLastProjectPath() {
    return this.state.lastProjectPath || "";
  }

  setLastProjectPath(projectPath) {
    this.state.lastProjectPath = projectPath || "";
    if (this.state.lastProjectPath) {
      this.ensureProjectInHistoryOrder(this.state.lastProjectPath, { prepend: true });
    }
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
    const isNew = !Object.prototype.hasOwnProperty.call(this.state.projects, projectPath);
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
    this.ensureProjectInHistoryOrder(projectPath, { prepend: isNew });
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
    this.ensureHistoryOrderCoversProjects();
    const known = new Set(Object.keys(this.state.projects || {}));
    const last = this.state.lastProjectPath || "";
    if (last) {
      known.add(last);
    }
    const ordered = [];
    const seen = new Set();
    for (const projectPath of this.state.projectHistoryOrder) {
      if (!known.has(projectPath) || seen.has(projectPath)) {
        continue;
      }
      seen.add(projectPath);
      ordered.push(projectPath);
    }
    for (const projectPath of known) {
      if (seen.has(projectPath)) {
        continue;
      }
      seen.add(projectPath);
      ordered.push(projectPath);
    }
    return ordered;
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

  reorderProjectHistory(orderedPaths) {
    const requested = normalizeHistoryOrder(orderedPaths);
    const known = new Set(this.listProjectPaths());
    const next = [];
    const seen = new Set();
    for (const projectPath of requested) {
      if (!known.has(projectPath) || seen.has(projectPath)) {
        continue;
      }
      seen.add(projectPath);
      next.push(projectPath);
    }
    for (const projectPath of known) {
      if (seen.has(projectPath)) {
        continue;
      }
      seen.add(projectPath);
      next.push(projectPath);
    }
    this.state.projectHistoryOrder = next;
    return next.slice();
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
    this.state.projectHistoryOrder = normalizeHistoryOrder(this.state.projectHistoryOrder).filter(
      (item) => item !== targetPath
    );
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
