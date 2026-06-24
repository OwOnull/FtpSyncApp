const LOG_DRAWER_HEIGHT_KEY = "ftp-sync-log-drawer-height";
const LOG_DRAWER_OPEN_KEY = "ftp-sync-log-drawer-open";
const DEFAULT_LOG_HEIGHT = 280;
const CLOSE_LOG_HEIGHT_THRESHOLD = 0;
const MAX_LOG_HEIGHT_RATIO = 0.7;
const LOG_DRAG_ACTIVATE_DISTANCE = 12;

const state = {
  projectPath: "",
  localPath: "",
  remotePath: "",
  contextTarget: null,
  logDrawerOpen: false,
  isResizingLogDrawer: false,
  isDraggingLogTrigger: false,
};

const el = {
  projectPath: document.getElementById("projectPath"),
  type: document.getElementById("type"),
  host: document.getElementById("host"),
  port: document.getElementById("port"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  remoteBasePath: document.getElementById("remoteBasePath"),
  ignorePaths: document.getElementById("ignorePaths"),
  btnChooseProject: document.getElementById("btnChooseProject"),
  btnProjectHistory: document.getElementById("btnProjectHistory"),
  projectHistoryDialog: document.getElementById("projectHistoryDialog"),
  projectHistoryContent: document.getElementById("projectHistoryContent"),
  projectHistoryList: document.getElementById("projectHistoryList"),
  projectHistoryEmpty: document.getElementById("projectHistoryEmpty"),
  btnCloseProjectHistory: document.getElementById("btnCloseProjectHistory"),
  btnSaveConfig: document.getElementById("btnSaveConfig"),
  btnStartSync: document.getElementById("btnStartSync"),
  btnStopSync: document.getElementById("btnStopSync"),
  btnSyncGitUnstaged: document.getElementById("btnSyncGitUnstaged"),
  btnExtractGitUnstaged: document.getElementById("btnExtractGitUnstaged"),
  logs: document.getElementById("logs"),
  logDrawer: document.getElementById("logDrawer"),
  btnToggleLogs: document.getElementById("btnToggleLogs"),
  btnClearLogs: document.getElementById("btnClearLogs"),
  btnRefreshLocal: document.getElementById("btnRefreshLocal"),
  btnLocalUp: document.getElementById("btnLocalUp"),
  localPath: document.getElementById("localPath"),
  localError: document.getElementById("localError"),
  localList: document.getElementById("localList"),
  btnRefreshRemote: document.getElementById("btnRefreshRemote"),
  btnRemoteUp: document.getElementById("btnRemoteUp"),
  remotePath: document.getElementById("remotePath"),
  remoteError: document.getElementById("remoteError"),
  remoteList: document.getElementById("remoteList"),
  contextMenu: document.getElementById("contextMenu"),
  contextSyncToServer: document.querySelector('[data-action="sync-to-server"]'),
  contextSyncFromServer: document.querySelector('[data-action="sync-from-server"]'),
  contextSyncToLocal: document.querySelector('[data-action="sync-to-local"]'),
  contextSyncFromLocal: document.querySelector('[data-action="sync-from-local"]'),
};

function appendLog(level, message) {
  const line = `[${new Date().toLocaleTimeString()}] [${level}] ${message}`;
  el.logs.textContent += `${line}\n`;
  el.logs.scrollTop = el.logs.scrollHeight;
}

function clearLogs() {
  el.logs.textContent = "";
}

function getMaxLogDrawerHeight() {
  return Math.max(DEFAULT_LOG_HEIGHT, Math.floor(window.innerHeight * MAX_LOG_HEIGHT_RATIO));
}

function clampLogDrawerHeight(height) {
  return Math.min(getMaxLogDrawerHeight(), Math.max(0, Math.round(height)));
}

function getCurrentLogDrawerHeight() {
  return (
    Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--log-drawer-height"),
      10
    ) || 0
  );
}

function getLastNonZeroLogDrawerHeight() {
  const savedHeight = Number(localStorage.getItem(LOG_DRAWER_HEIGHT_KEY));
  if (Number.isFinite(savedHeight) && savedHeight > CLOSE_LOG_HEIGHT_THRESHOLD) {
    return clampLogDrawerHeight(savedHeight);
  }
  return clampLogDrawerHeight(DEFAULT_LOG_HEIGHT);
}

function setLogDrawerHeight(height, persist) {
  const nextHeight = clampLogDrawerHeight(height);
  document.documentElement.style.setProperty("--log-drawer-height", `${nextHeight}px`);
  if (persist && nextHeight > CLOSE_LOG_HEIGHT_THRESHOLD) {
    localStorage.setItem(LOG_DRAWER_HEIGHT_KEY, String(nextHeight));
  }
  return nextHeight;
}

function updateLogDrawerUi() {
  const isOpen = state.logDrawerOpen;
  el.logDrawer.classList.toggle("open", isOpen);
  el.logDrawer.setAttribute("aria-hidden", isOpen ? "false" : "true");
  el.btnToggleLogs.classList.toggle("open", isOpen);
  el.btnToggleLogs.setAttribute("aria-expanded", isOpen ? "true" : "false");
  el.btnToggleLogs.title = isOpen ? "收起日志" : "展开日志";
}

function openLogDrawer(persist = true) {
  const currentHeight = getCurrentLogDrawerHeight();
  if (currentHeight <= CLOSE_LOG_HEIGHT_THRESHOLD) {
    setLogDrawerHeight(getLastNonZeroLogDrawerHeight(), false);
  }
  state.logDrawerOpen = true;
  updateLogDrawerUi();
  if (persist) {
    localStorage.setItem(LOG_DRAWER_OPEN_KEY, "true");
  }
}

function closeLogDrawer(persist = true) {
  state.logDrawerOpen = false;
  updateLogDrawerUi();
  if (persist) {
    localStorage.setItem(LOG_DRAWER_OPEN_KEY, "false");
  }
}

function toggleLogDrawer() {
  const currentHeight = getCurrentLogDrawerHeight();
  if (currentHeight > CLOSE_LOG_HEIGHT_THRESHOLD) {
    // 点击时高度非 0，直接收起到 0。
    setLogDrawerHeight(0, false);
    closeLogDrawer();
    return;
  }
  // 点击时高度为 0，恢复到上次非零高度（无记录时回退默认值）。
  setLogDrawerHeight(getLastNonZeroLogDrawerHeight(), false);
  openLogDrawer();
}

function initLogDrawer() {
  const savedHeight = Number(localStorage.getItem(LOG_DRAWER_HEIGHT_KEY));
  const shouldOpen = localStorage.getItem(LOG_DRAWER_OPEN_KEY) === "true";
  const initialHeight =
    Number.isFinite(savedHeight) && savedHeight > CLOSE_LOG_HEIGHT_THRESHOLD
      ? savedHeight
      : DEFAULT_LOG_HEIGHT;
  setLogDrawerHeight(shouldOpen ? initialHeight : 0, false);
  state.logDrawerOpen = shouldOpen;
  updateLogDrawerUi();
}

function bindLogTriggerDrag() {
  let startY = 0;
  let startHeight = 0;
  let dragDistance = 0;

  const onPointerMove = (event) => {
    if (!state.isDraggingLogTrigger) {
      return;
    }
    const deltaY = startY - event.clientY;
    dragDistance = Math.max(dragDistance, Math.abs(deltaY));
    // 拖拽阶段仅线性更新高度，避免过程中的突变开关。
    const nextHeight = setLogDrawerHeight(startHeight + deltaY, false);
    state.logDrawerOpen = nextHeight > CLOSE_LOG_HEIGHT_THRESHOLD;
    updateLogDrawerUi();
  };

  const stopDrag = () => {
    if (!state.isDraggingLogTrigger) {
      return;
    }
    state.isDraggingLogTrigger = false;
    state.isResizingLogDrawer = false;
    el.logDrawer.classList.remove("resizing");
    document.body.classList.remove("log-drawer-dragging");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
    window.removeEventListener("pointercancel", stopDrag);

    if (dragDistance < LOG_DRAG_ACTIVATE_DISTANCE) {
      toggleLogDrawer();
      return;
    }

    const currentHeight = getCurrentLogDrawerHeight();
    const isOpen = currentHeight > CLOSE_LOG_HEIGHT_THRESHOLD;
    state.logDrawerOpen = isOpen;
    updateLogDrawerUi();
    localStorage.setItem(LOG_DRAWER_OPEN_KEY, isOpen ? "true" : "false");
    if (isOpen) {
      setLogDrawerHeight(currentHeight, true);
      return;
    }
    setLogDrawerHeight(0, false);
  };

  el.btnToggleLogs.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    state.isDraggingLogTrigger = true;
    state.isResizingLogDrawer = true;
    startY = event.clientY;
    dragDistance = 0;
    startHeight = getCurrentLogDrawerHeight();
    el.logDrawer.classList.add("resizing");
    document.body.classList.add("log-drawer-dragging");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
  });
}

function bindLogDrawerViewportSync() {
  window.addEventListener("resize", () => {
    if (state.isResizingLogDrawer) {
      return;
    }
    const currentHeight = getCurrentLogDrawerHeight();
    // 关闭态（高度 0）仅保持关闭，勿用默认高度回填以免误展开。
    if (!state.logDrawerOpen || currentHeight <= CLOSE_LOG_HEIGHT_THRESHOLD) {
      return;
    }
    setLogDrawerHeight(currentHeight, true);
  });
}

function parseIgnorePathsText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatIgnorePathsForTextarea(ignorePaths) {
  if (Array.isArray(ignorePaths)) {
    return ignorePaths.join("\n");
  }
  if (typeof ignorePaths === "string") {
    return ignorePaths;
  }
  return "";
}

function getFormConfig() {
  return {
    type: el.type.value,
    host: el.host.value.trim(),
    port: Number(el.port.value) || 21,
    username: el.username.value.trim(),
    password: el.password.value,
    remoteBasePath: el.remoteBasePath.value.trim() || "/",
    ignorePaths: parseIgnorePathsText(el.ignorePaths.value),
  };
}

function setFormConfig(config) {
  const c = config || {};
  el.type.value = c.type || "ftp";
  el.host.value = c.host || "";
  el.port.value = c.port || 21;
  el.username.value = c.username || "";
  el.password.value = c.password || "";
  el.remoteBasePath.value = c.remoteBasePath || "/";
  el.ignorePaths.value = formatIgnorePathsForTextarea(c.ignorePaths);
}

function setProjectPath(projectPath) {
  state.projectPath = projectPath || "";
  state.localPath = state.projectPath;
  el.projectPath.textContent = state.projectPath || "-";
}

async function chooseProjectFromHistory() {
  const list = await window.appApi.listProjectHistory();
  const history = Array.isArray(list) ? list.filter((item) => item && item.projectPath) : [];
  renderProjectHistory(history);

  if (!el.projectHistoryDialog.open) {
    el.projectHistoryDialog.showModal();
  }
}

function closeProjectHistoryDialog() {
  if (el.projectHistoryDialog.open) {
    el.projectHistoryDialog.close();
  }
}

function renderProjectHistory(history) {
  const list = Array.isArray(history) ? history : [];
  el.projectHistoryList.innerHTML = "";
  const isEmpty = list.length === 0;
  el.projectHistoryEmpty.classList.toggle("hidden", !isEmpty);
  el.projectHistoryList.classList.toggle("hidden", isEmpty);
  if (isEmpty) {
    appendLog("info", "暂无历史项目，请先手动选择项目。");
    return;
  }

  list.forEach((item) => {
    const li = document.createElement("li");
    li.className = "project-history-row";

    const chooseButton = document.createElement("button");
    chooseButton.type = "button";
    chooseButton.className = "project-history-item";
    chooseButton.textContent = item.projectPath;
    chooseButton.title = item.projectPath;
    chooseButton.addEventListener("click", async () => {
      await applySelectedProject(item, { logMessage: "已加载历史项目" });
      closeProjectHistoryDialog();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "project-history-delete";
    deleteButton.textContent = "关闭";
    deleteButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const result = await window.appApi.deleteProjectHistoryItem({
        projectPath: item.projectPath,
      });
      if (!result || !result.ok) {
        appendLog("error", (result && result.message) || "删除历史项目失败。");
        return;
      }
      appendLog("info", `已删除历史项目: ${item.projectPath}`);
      const updated = await window.appApi.listProjectHistory();
      const nextHistory = Array.isArray(updated) ? updated.filter((entry) => entry && entry.projectPath) : [];
      renderProjectHistory(nextHistory);
    });

    li.appendChild(chooseButton);
    li.appendChild(deleteButton);
    el.projectHistoryList.appendChild(li);
  });
}

async function applySelectedProject(selected, options) {
  if (!selected || !selected.projectPath) {
    appendLog("warn", "历史项目数据无效。");
    return;
  }
  const logMessage = options?.logMessage;
  setProjectPath(selected.projectPath);
  setFormConfig(selected.config);
  if (logMessage) {
    appendLog("info", `${logMessage}: ${selected.projectPath}`);
  }
  await refreshLocalDir(selected.projectPath);
}

function setPanelError(errorEl, message) {
  const text = (message || "").trim();
  errorEl.textContent = text;
  errorEl.classList.toggle("hidden", !text);
}

function hideContextMenu() {
  state.contextTarget = null;
  el.contextMenu.classList.add("hidden");
}

function showContextMenu(event, item, panel) {
  state.contextTarget = { item, panel };
  const isLocal = panel === "local";
  el.contextSyncToServer.classList.toggle("hidden", !isLocal);
  el.contextSyncFromServer.classList.toggle("hidden", !isLocal);
  el.contextSyncToLocal.classList.toggle("hidden", isLocal);
  el.contextSyncFromLocal.classList.toggle("hidden", isLocal);

  el.contextMenu.classList.remove("hidden");
  const menuWidth = el.contextMenu.offsetWidth || 160;
  const menuHeight = el.contextMenu.offsetHeight || 80;
  const left = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
  const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
  el.contextMenu.style.left = `${Math.max(8, left)}px`;
  el.contextMenu.style.top = `${Math.max(8, top)}px`;
}

function renderDirList(listEl, items, options) {
  listEl.innerHTML = "";
  if (!items || items.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "dir-item";
    emptyItem.innerHTML = '<span class="name">当前目录为空</span><span class="type">-</span>';
    listEl.appendChild(emptyItem);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "dir-item";
    if (item.type === "dir") {
      li.classList.add("dir-entry");
    }

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = item.name;

    const typeEl = document.createElement("span");
    typeEl.className = "type";
    typeEl.textContent = item.type;

    li.appendChild(nameEl);
    li.appendChild(typeEl);

    if (item.type === "dir") {
      li.addEventListener("dblclick", () => options.onOpenDir(item.path));
    }

    li.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showContextMenu(event, item, options.panel);
    });

    listEl.appendChild(li);
  });
}

async function refreshLocalDir(targetPath) {
  if (!state.projectPath) {
    setPanelError(el.localError, "请先选择项目目录。");
    el.localPath.textContent = "-";
    el.localList.innerHTML = "";
    return;
  }

  const result = await window.appApi.listLocalDir({
    projectPath: state.projectPath,
    targetPath: targetPath || state.localPath || state.projectPath,
  });

  if (!result.ok) {
    setPanelError(el.localError, result.message || "读取本地目录失败。");
    return;
  }

  state.localPath = result.path;
  el.localPath.textContent = result.path;
  setPanelError(el.localError, "");
  el.btnLocalUp.disabled = !result.parentPath;
  renderDirList(el.localList, result.items, {
    panel: "local",
    onOpenDir: (nextPath) => refreshLocalDir(nextPath),
  });
}

async function refreshRemoteDir(targetPath) {
  const config = getFormConfig();
  const result = await window.appApi.listRemoteDir({
    config,
    targetPath: targetPath || state.remotePath || config.remoteBasePath || "/",
  });

  if (!result.ok) {
    setPanelError(el.remoteError, result.message || "读取远程目录失败。");
    el.btnRemoteUp.disabled = true;
    return;
  }

  state.remotePath = result.path;
  el.remotePath.textContent = result.path;
  setPanelError(el.remoteError, "");
  el.btnRemoteUp.disabled = !result.parentPath;
  renderDirList(el.remoteList, result.items, {
    panel: "remote",
    onOpenDir: (nextPath) => refreshRemoteDir(nextPath),
  });
}

async function chooseProject() {
  const result = await window.appApi.chooseProject();
  if (result.cancelled) {
    return;
  }
  await applySelectedProject({
    projectPath: result.projectPath,
    config: result.config,
  }, { logMessage: "已选择项目" });
}

async function saveConfig() {
  if (!state.projectPath) {
    appendLog("warn", "请先选择项目目录。");
    return;
  }

  const result = await window.appApi.saveConfig({
    projectPath: state.projectPath,
    config: getFormConfig(),
  });

  if (result.ok) {
    appendLog("info", "配置保存成功。");
    return;
  }
  appendLog("error", result.message || "配置保存失败。");
}

async function startSync() {
  if (!state.projectPath) {
    appendLog("warn", "请先选择项目目录。");
    return;
  }

  // 启动前先持久化，保证每个项目配置一致。
  await saveConfig();

  const result = await window.appApi.startSync({
    projectPath: state.projectPath,
    config: getFormConfig(),
  });
  if (result.ok) {
    appendLog("info", "同步已启动。");
    return;
  }
  appendLog("error", result.message || "同步启动失败。");
}

async function stopSync() {
  await window.appApi.stopSync();
  appendLog("info", "同步已停止。");
}

async function extractGitUnstaged() {
  if (!state.projectPath) {
    appendLog("warn", "请先选择项目目录。");
    return;
  }

  openLogDrawer();
  appendLog("info", "正在收集 Git 未暂存变更…");
  el.btnExtractGitUnstaged.disabled = true;

  try {
    const result = await window.appApi.extractGitUnstaged({
      projectPath: state.projectPath,
    });

    if (!result.ok && result.code) {
      appendLog("error", result.message || "提取 Git 未暂存的变更失败。");
      return;
    }

    if (!result.ok && result.message && !result.total) {
      appendLog("error", result.message);
      return;
    }

    if (result.total === 0) {
      appendLog("info", result.message || "没有需要提取的文件。");
      return;
    }

    appendLog("info", result.message || "Git 未暂存的变更提取完成。");
    if (result.failed && result.failed.length) {
      result.failed.forEach((item) => {
        appendLog(
          "error",
          `失败: ${item.relativePath} (${item.action}) - ${item.message || "未知错误"}`
        );
      });
    }
  } finally {
    el.btnExtractGitUnstaged.disabled = false;
  }
}

async function syncGitUnstaged() {
  if (!state.projectPath) {
    appendLog("warn", "请先选择项目目录。");
    return;
  }

  const config = getFormConfig();
  if (!config.host || !config.username) {
    appendLog("warn", "请先完善 FTP 配置。");
    return;
  }

  openLogDrawer();
  appendLog("info", "正在获取 Git 未暂存变更…");
  el.btnSyncGitUnstaged.disabled = true;

  try {
    const result = await window.appApi.syncGitUnstaged({
      projectPath: state.projectPath,
      config,
    });

    if (!result.ok) {
      appendLog("error", result.message || "Git 变更同步失败。");
      return;
    }

    if (result.total === 0) {
      appendLog("info", result.message || "没有需要同步的文件。");
      return;
    }

    appendLog("info", result.message || "Git 未暂存变更同步完成。");
    if (result.failed && result.failed.length) {
      result.failed.forEach((item) => {
        appendLog(
          "error",
          `失败: ${item.relativePath} (${item.action}) - ${item.message || "未知错误"}`
        );
      });
    }
    await refreshRemoteDir();
  } finally {
    el.btnSyncGitUnstaged.disabled = false;
  }
}

async function syncItemFromServer(item) {
  if (!state.projectPath) {
    appendLog("warn", "请先选择项目目录。");
    return;
  }

  const config = getFormConfig();
  if (!config.host || !config.username) {
    appendLog("warn", "请先完善 FTP 配置。");
    return;
  }

  appendLog("info", `正在与服务器同步: ${item.name}`);
  const result = await window.appApi.syncServerToLocalByLocal({
    projectPath: state.projectPath,
    config,
    localPath: item.path,
  });

  if (result.ok) {
    appendLog("info", `与服务器同步完成: ${item.name}`);
    await refreshLocalDir();
    return;
  }
  appendLog("error", result.message || "与服务器同步失败。");
}

async function syncItemFromLocal(item) {
  if (!state.projectPath) {
    appendLog("warn", "请先选择项目目录。");
    return;
  }

  const config = getFormConfig();
  if (!config.host || !config.username) {
    appendLog("warn", "请先完善 FTP 配置。");
    return;
  }

  appendLog("info", `正在与本地同步: ${item.name}`);
  const result = await window.appApi.syncLocalToServerByRemote({
    projectPath: state.projectPath,
    config,
    remotePath: item.path,
    itemType: item.type,
  });

  if (result.ok) {
    appendLog("info", `与本地同步完成: ${item.name}`);
    await refreshRemoteDir();
    return;
  }
  appendLog("error", result.message || "与本地同步失败。");
}

async function syncItemToServer(item) {
  if (!state.projectPath) {
    appendLog("warn", "请先选择项目目录。");
    return;
  }

  const config = getFormConfig();
  if (!config.host || !config.username) {
    appendLog("warn", "请先完善 FTP 配置。");
    return;
  }

  appendLog("info", `正在同步到服务器: ${item.name}`);
  const result = await window.appApi.syncLocalToRemote({
    projectPath: state.projectPath,
    config,
    localPath: item.path,
  });

  if (result.ok) {
    appendLog("info", `同步到服务器完成: ${item.name}`);
    await refreshRemoteDir();
    return;
  }
  appendLog("error", result.message || "同步到服务器失败。");
}

async function syncItemToLocal(item) {
  if (!state.projectPath) {
    appendLog("warn", "请先选择项目目录。");
    return;
  }

  const config = getFormConfig();
  if (!config.host || !config.username) {
    appendLog("warn", "请先完善 FTP 配置。");
    return;
  }

  appendLog("info", `正在同步到本地: ${item.name}`);
  const result = await window.appApi.syncRemoteToLocal({
    projectPath: state.projectPath,
    config,
    remotePath: item.path,
    itemType: item.type,
  });

  if (result.ok) {
    appendLog("info", `同步到本地完成: ${item.name}`);
    await refreshLocalDir();
    return;
  }
  appendLog("error", result.message || "同步到本地失败。");
}

function bindEvents() {
  el.btnChooseProject.addEventListener("click", chooseProject);
  el.btnProjectHistory.addEventListener("click", chooseProjectFromHistory);
  el.btnSaveConfig.addEventListener("click", saveConfig);
  el.btnStartSync.addEventListener("click", startSync);
  el.btnStopSync.addEventListener("click", stopSync);
  el.btnSyncGitUnstaged.addEventListener("click", syncGitUnstaged);
  el.btnExtractGitUnstaged.addEventListener("click", extractGitUnstaged);
  el.btnClearLogs.addEventListener("click", clearLogs);
  el.btnRefreshLocal.addEventListener("click", () => refreshLocalDir());
  el.btnLocalUp.addEventListener("click", () =>
    window.appApi
      .listLocalDir({
        projectPath: state.projectPath,
        targetPath: state.localPath || state.projectPath,
      })
      .then((res) => {
        if (res.ok && res.parentPath) {
          refreshLocalDir(res.parentPath);
        }
      })
  );
  el.btnRefreshRemote.addEventListener("click", () => refreshRemoteDir());
  el.btnRemoteUp.addEventListener("click", () =>
    window.appApi
      .listRemoteDir({
        config: getFormConfig(),
        targetPath: state.remotePath || getFormConfig().remoteBasePath || "/",
      })
      .then((res) => {
        if (res.ok && res.parentPath) {
          refreshRemoteDir(res.parentPath);
        }
      })
  );

  el.contextSyncToServer.addEventListener("click", async () => {
    const target = state.contextTarget;
    hideContextMenu();
    if (!target || target.panel !== "local") {
      return;
    }
    await syncItemToServer(target.item);
  });

  el.contextSyncFromServer.addEventListener("click", async () => {
    const target = state.contextTarget;
    hideContextMenu();
    if (!target || target.panel !== "local") {
      return;
    }
    await syncItemFromServer(target.item);
  });

  el.contextSyncToLocal.addEventListener("click", async () => {
    const target = state.contextTarget;
    hideContextMenu();
    if (!target || target.panel !== "remote") {
      return;
    }
    await syncItemToLocal(target.item);
  });

  el.contextSyncFromLocal.addEventListener("click", async () => {
    const target = state.contextTarget;
    hideContextMenu();
    if (!target || target.panel !== "remote") {
      return;
    }
    await syncItemFromLocal(target.item);
  });

  document.addEventListener("click", (event) => {
    if (!el.contextMenu.contains(event.target)) {
      hideContextMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu();
    }
  });

  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("resize", hideContextMenu);
  window.addEventListener("scroll", hideContextMenu, true);
  el.btnCloseProjectHistory.addEventListener("click", () => {
    closeProjectHistoryDialog();
  });
  el.projectHistoryDialog.addEventListener("click", (event) => {
    if (!el.projectHistoryDialog.open || event.target !== el.projectHistoryDialog) {
      return;
    }
    const contentRect = el.projectHistoryContent.getBoundingClientRect();
    const isOutsideContent =
      event.clientX < contentRect.left ||
      event.clientX > contentRect.right ||
      event.clientY < contentRect.top ||
      event.clientY > contentRect.bottom;
    if (isOutsideContent) {
      closeProjectHistoryDialog();
    }
  });
}

async function init() {
  initLogDrawer();
  bindLogTriggerDrag();
  bindLogDrawerViewportSync();
  bindEvents();
  el.btnLocalUp.disabled = true;
  el.btnRemoteUp.disabled = true;
  setPanelError(el.localError, "");
  setPanelError(el.remoteError, "");

  const unlisten = window.appApi.onLog((item) => {
    appendLog(item.level || "info", item.message || "");
  });
  window.addEventListener("beforeunload", () => {
    unlisten();
  });

  const last = await window.appApi.getLastProject();
  if (last && last.projectPath) {
    await applySelectedProject({
      projectPath: last.projectPath,
      config: last.config,
    }, { logMessage: "已自动加载上次项目" });
  } else {
    appendLog("info", "未找到上次项目，请先选择项目目录。");
  }
}

init();
