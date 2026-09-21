const LOG_DRAWER_HEIGHT_KEY = "ftp-sync-log-drawer-height";
const LOG_DRAWER_OPEN_KEY = "ftp-sync-log-drawer-open";
const DEFAULT_LOG_HEIGHT = 280;
const CLOSE_LOG_HEIGHT_THRESHOLD = 0;
const MAX_LOG_HEIGHT_RATIO = 0.7;
const LOG_DRAG_ACTIVATE_DISTANCE = 12;

const state = {
  projectPath: "",
  projectAlias: "",
  localPath: "",
  remotePath: "",
  contextTarget: null,
  historyContextTarget: null,
  historyDragSource: null,
  historyDragMoved: false,
  aliasDialogProjectPath: "",
  logDrawerOpen: false,
  isResizingLogDrawer: false,
  isDraggingLogTrigger: false,
  selectedExtractGitRef: "",
  selectedExtractGitLabel: "",
};

const el = {
  projectTitle: document.getElementById("projectTitle"),
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
  projectHistoryContextMenu: document.getElementById("projectHistoryContextMenu"),
  historySetAlias: document.querySelector('#projectHistoryContextMenu [data-action="set-alias"]'),
  historyOpenInExplorer: document.querySelector(
    '#projectHistoryContextMenu [data-action="open-in-explorer"]'
  ),
  projectAliasDialog: document.getElementById("projectAliasDialog"),
  projectAliasContent: document.getElementById("projectAliasContent"),
  projectAliasPathHint: document.getElementById("projectAliasPathHint"),
  projectAliasInput: document.getElementById("projectAliasInput"),
  btnCloseProjectAlias: document.getElementById("btnCloseProjectAlias"),
  btnCancelProjectAlias: document.getElementById("btnCancelProjectAlias"),
  btnConfirmProjectAlias: document.getElementById("btnConfirmProjectAlias"),
  btnSaveConfig: document.getElementById("btnSaveConfig"),
  btnStartSync: document.getElementById("btnStartSync"),
  btnStopSync: document.getElementById("btnStopSync"),
  btnDisconnectFtp: document.getElementById("btnDisconnectFtp"),
  disconnectFtpDialog: document.getElementById("disconnectFtpDialog"),
  disconnectFtpContent: document.getElementById("disconnectFtpContent"),
  btnCloseDisconnectFtp: document.getElementById("btnCloseDisconnectFtp"),
  btnCancelDisconnectFtp: document.getElementById("btnCancelDisconnectFtp"),
  btnConfirmDisconnectFtp: document.getElementById("btnConfirmDisconnectFtp"),
  btnSyncGitUnstaged: document.getElementById("btnSyncGitUnstaged"),
  btnExtractGitSinceRef: document.getElementById("btnExtractGitSinceRef"),
  extractGitSinceRefDialog: document.getElementById("extractGitSinceRefDialog"),
  extractGitSinceRefContent: document.getElementById("extractGitSinceRefContent"),
  extractGitSinceRefList: document.getElementById("extractGitSinceRefList"),
  extractGitSinceRefEmpty: document.getElementById("extractGitSinceRefEmpty"),
  btnCloseExtractGitSinceRef: document.getElementById("btnCloseExtractGitSinceRef"),
  btnCancelExtractGitSinceRef: document.getElementById("btnCancelExtractGitSinceRef"),
  btnConfirmExtractGitSinceRef: document.getElementById("btnConfirmExtractGitSinceRef"),
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

function formatProjectAlias(alias) {
  const text = String(alias || "").trim();
  return text || "暂无别名";
}

function updateProjectTitle(alias) {
  state.projectAlias = String(alias || "").trim();
  el.projectTitle.textContent = formatProjectAlias(state.projectAlias);
}

function setProjectPath(projectPath, alias) {
  state.projectPath = projectPath || "";
  state.localPath = state.projectPath;
  el.projectPath.textContent = state.projectPath || "-";
  if (alias !== undefined) {
    updateProjectTitle(alias);
  }
}

async function chooseProjectFromHistory() {
  const list = await window.appApi.listProjectHistory();
  const history = Array.isArray(list)
    ? list.filter((item) => item && (item.projectPath || item.path))
    : [];
  renderProjectHistory(history);

  if (!el.projectHistoryDialog.open) {
    el.projectHistoryDialog.showModal();
  }
}

function closeProjectHistoryDialog() {
  hideProjectHistoryContextMenu();
  if (el.projectHistoryDialog.open) {
    el.projectHistoryDialog.close();
  }
}

function openDisconnectFtpDialog() {
  if (!el.disconnectFtpDialog.open) {
    el.disconnectFtpDialog.showModal();
  }
}

function closeDisconnectFtpDialog() {
  if (el.disconnectFtpDialog.open) {
    el.disconnectFtpDialog.close();
  }
}

async function confirmDisconnectFtp() {
  closeDisconnectFtpDialog();
  appendLog("info", "正在断开本实例所有 FTP 连接…");
  const result = await window.appApi.forceDisconnectFtp();
  if (!result || !result.ok) {
    appendLog("error", (result && result.message) || "断开 FTP 连接失败。");
    return;
  }
  appendLog("info", (result && result.message) || "FTP 连接已断开。");
}

function setExtractGitRefSelection(ref, label) {
  state.selectedExtractGitRef = String(ref || "");
  state.selectedExtractGitLabel = String(label || "");
  el.btnConfirmExtractGitSinceRef.disabled = !state.selectedExtractGitRef;

  const buttons = el.extractGitSinceRefList.querySelectorAll(".extract-git-ref-item");
  buttons.forEach((button) => {
    const selected = button.dataset.ref === state.selectedExtractGitRef;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
}

function renderExtractGitRefOptions(options) {
  const list = Array.isArray(options) ? options : [];
  el.extractGitSinceRefList.innerHTML = "";
  const isEmpty = list.length === 0;
  el.extractGitSinceRefEmpty.classList.toggle("hidden", !isEmpty);
  el.extractGitSinceRefList.classList.toggle("hidden", isEmpty);
  if (isEmpty) {
    el.extractGitSinceRefEmpty.textContent = "暂无可选项。";
    setExtractGitRefSelection("", "");
    return;
  }

  list.forEach((option) => {
    const li = document.createElement("li");
    li.className = "project-history-row extract-git-ref-row";

    const chooseButton = document.createElement("button");
    chooseButton.type = "button";
    chooseButton.className = "project-history-item extract-git-ref-item";
    chooseButton.dataset.ref = option.ref;
    chooseButton.setAttribute("role", "option");
    chooseButton.setAttribute("aria-selected", "false");

    const isPseudo = option.type === "pseudo" || option.kind === "pseudo";
    if (isPseudo) {
      chooseButton.classList.add("extract-git-ref-pseudo");
    }

    const meta = document.createElement("span");
    meta.className = "extract-git-ref-meta";
    const message = document.createElement("span");
    message.className = "extract-git-ref-message";

    if (isPseudo) {
      meta.textContent = option.title || option.ref;
      message.textContent =
        option.subtitle || option.message || "工作区相关变更";
    } else {
      meta.textContent = [option.shortHash, option.date, option.author]
        .filter(Boolean)
        .join("  ·  ");
      message.textContent = option.subject || option.message || "";
    }

    chooseButton.title =
      option.label ||
      [meta.textContent, message.textContent].filter(Boolean).join(" — ");
    chooseButton.appendChild(meta);
    chooseButton.appendChild(message);

    chooseButton.addEventListener("click", () => {
      const labelText = isPseudo
        ? option.title || option.ref
        : option.label ||
          [option.shortHash, option.date, option.author, option.subject || option.message]
            .filter(Boolean)
            .join("  ");
      setExtractGitRefSelection(option.ref, labelText);
    });

    li.appendChild(chooseButton);
    el.extractGitSinceRefList.appendChild(li);
  });

  setExtractGitRefSelection("", "");
}

async function openExtractGitSinceRefDialog() {
  if (!state.projectPath) {
    appendLog("warn", "请先选择项目目录。");
    return;
  }

  setExtractGitRefSelection("", "");
  el.extractGitSinceRefList.innerHTML = "";
  el.extractGitSinceRefList.classList.add("hidden");
  el.extractGitSinceRefEmpty.classList.remove("hidden");
  el.extractGitSinceRefEmpty.textContent = "正在读取 Git 选项…";
  el.btnConfirmExtractGitSinceRef.disabled = true;

  if (!el.extractGitSinceRefDialog.open) {
    el.extractGitSinceRefDialog.showModal();
  }

  const result = await window.appApi.listGitExtractOptions({
    projectPath: state.projectPath,
  });

  if (!result.ok) {
    el.extractGitSinceRefEmpty.textContent = result.message || "读取 Git 选项失败。";
    el.extractGitSinceRefEmpty.classList.remove("hidden");
    el.extractGitSinceRefList.classList.add("hidden");
    appendLog("error", result.message || "读取 Git 选项失败。");
    return;
  }

  renderExtractGitRefOptions(result.options || []);
}

function closeExtractGitSinceRefDialog() {
  if (el.extractGitSinceRefDialog.open) {
    el.extractGitSinceRefDialog.close();
  }
  setExtractGitRefSelection("", "");
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
    const projectPath = item.projectPath || item.path || "";
    const alias = (item.alias || (item.config && item.config.alias) || "").trim();
    const displayAlias = formatProjectAlias(alias);

    const li = document.createElement("li");
    li.className = "project-history-row";
    li.dataset.projectPath = projectPath;
    li.draggable = false;

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "project-history-drag-handle";
    dragHandle.title = "拖拽排序";
    dragHandle.setAttribute("aria-label", "拖拽排序");
    dragHandle.innerHTML = '<span class="project-history-drag-grip" aria-hidden="true"></span>';
    dragHandle.addEventListener("pointerdown", () => {
      li.draggable = true;
    });
    dragHandle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    const chooseButton = document.createElement("button");
    chooseButton.type = "button";
    chooseButton.className = "project-history-item";
    chooseButton.title = projectPath;

    const aliasEl = document.createElement("span");
    aliasEl.className = `project-history-alias${alias ? "" : " is-empty"}`;
    aliasEl.textContent = displayAlias;

    const pathEl = document.createElement("span");
    pathEl.className = "project-history-path";
    pathEl.textContent = projectPath;

    chooseButton.appendChild(aliasEl);
    chooseButton.appendChild(pathEl);
    chooseButton.addEventListener("click", async () => {
      if (state.historyDragMoved) {
        return;
      }
      await applySelectedProject(
        {
          projectPath,
          alias,
          config: item.config,
        },
        { logMessage: "已加载历史项目" }
      );
      closeProjectHistoryDialog();
    });
    chooseButton.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showProjectHistoryContextMenu(event, {
        projectPath,
        alias,
        config: item.config,
      });
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "project-history-delete";
    deleteButton.textContent = "关闭";
    deleteButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const result = await window.appApi.deleteProjectHistoryItem({
        projectPath,
      });
      if (!result || !result.ok) {
        appendLog("error", (result && result.message) || "删除历史项目失败。");
        return;
      }
      appendLog("info", `已删除历史项目: ${projectPath}`);
      const updated = await window.appApi.listProjectHistory();
      const nextHistory = Array.isArray(updated)
        ? updated.filter((entry) => entry && (entry.projectPath || entry.path))
        : [];
      renderProjectHistory(nextHistory);
    });

    li.appendChild(dragHandle);
    li.appendChild(chooseButton);
    li.appendChild(deleteButton);
    bindProjectHistoryRowDrag(li);
    el.projectHistoryList.appendChild(li);
  });
}

function getProjectHistoryOrderFromDom() {
  return Array.from(el.projectHistoryList.querySelectorAll(".project-history-row"))
    .map((row) => row.dataset.projectPath || "")
    .filter(Boolean);
}

function clearProjectHistoryDragState() {
  state.historyDragSource = null;
  state.historyDragMoved = false;
  el.projectHistoryList
    .querySelectorAll(".project-history-row.is-dragging, .project-history-row.drag-over")
    .forEach((row) => {
      row.classList.remove("is-dragging", "drag-over", "drag-over-before", "drag-over-after");
    });
}

function bindProjectHistoryRowDrag(row) {
  row.addEventListener("dragstart", (event) => {
    hideProjectHistoryContextMenu();
    state.historyDragSource = row;
    state.historyDragMoved = false;
    row.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.projectPath || "");
    }
  });

  row.addEventListener("dragend", async () => {
    row.draggable = false;
    const moved = state.historyDragMoved;
    clearProjectHistoryDragState();
    if (!moved) {
      return;
    }
    const order = getProjectHistoryOrderFromDom();
    const result = await window.appApi.reorderProjectHistory({ order });
    if (!result || !result.ok) {
      appendLog("error", (result && result.message) || "保存历史项目排序失败。");
      const updated = await window.appApi.listProjectHistory();
      const nextHistory = Array.isArray(updated)
        ? updated.filter((entry) => entry && (entry.projectPath || entry.path))
        : [];
      renderProjectHistory(nextHistory);
      return;
    }
    appendLog("info", "已保存历史项目排序。");
  });

  row.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!state.historyDragSource || state.historyDragSource === row) {
      return;
    }
    const rect = row.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    row.classList.add("drag-over");
    row.classList.toggle("drag-over-before", before);
    row.classList.toggle("drag-over-after", !before);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  });

  row.addEventListener("dragleave", () => {
    row.classList.remove("drag-over", "drag-over-before", "drag-over-after");
  });

  row.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const source = state.historyDragSource;
    row.classList.remove("drag-over", "drag-over-before", "drag-over-after");
    if (!source || source === row) {
      return;
    }
    const rect = row.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    if (before) {
      el.projectHistoryList.insertBefore(source, row);
    } else {
      el.projectHistoryList.insertBefore(source, row.nextSibling);
    }
    state.historyDragMoved = true;
  });
}

function hideProjectHistoryContextMenu() {
  state.historyContextTarget = null;
  el.projectHistoryContextMenu.classList.add("hidden");
}

function showProjectHistoryContextMenu(event, item) {
  hideContextMenu();
  state.historyContextTarget = item;
  el.projectHistoryContextMenu.classList.remove("hidden");
  const menuWidth = el.projectHistoryContextMenu.offsetWidth || 180;
  const menuHeight = el.projectHistoryContextMenu.offsetHeight || 80;
  const left = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
  const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
  el.projectHistoryContextMenu.style.left = `${Math.max(8, left)}px`;
  el.projectHistoryContextMenu.style.top = `${Math.max(8, top)}px`;
}

function closeProjectAliasDialog() {
  state.aliasDialogProjectPath = "";
  if (el.projectAliasDialog.open) {
    el.projectAliasDialog.close();
  }
}

function openProjectAliasDialog(item) {
  if (!item || !item.projectPath) {
    return;
  }
  hideProjectHistoryContextMenu();
  state.aliasDialogProjectPath = item.projectPath;
  el.projectAliasPathHint.textContent = item.projectPath;
  el.projectAliasInput.value = item.alias || "";
  if (!el.projectAliasDialog.open) {
    el.projectAliasDialog.showModal();
  }
  requestAnimationFrame(() => {
    el.projectAliasInput.focus();
    el.projectAliasInput.select();
  });
}

async function confirmProjectAlias() {
  const projectPath = state.aliasDialogProjectPath;
  if (!projectPath) {
    closeProjectAliasDialog();
    return;
  }
  const alias = el.projectAliasInput.value.trim();
  const result = await window.appApi.setProjectAlias({
    projectPath,
    alias,
  });
  if (!result || !result.ok) {
    appendLog("error", (result && result.message) || "设置别名失败。");
    return;
  }

  const savedAlias = result.alias || "";
  appendLog("info", savedAlias ? `已设置别名: ${savedAlias}` : "已清除项目别名。");
  closeProjectAliasDialog();

  if (state.projectPath && state.projectPath === projectPath) {
    updateProjectTitle(savedAlias);
  }

  if (el.projectHistoryDialog.open) {
    const updated = await window.appApi.listProjectHistory();
    const nextHistory = Array.isArray(updated)
      ? updated.filter((entry) => entry && (entry.projectPath || entry.path))
      : [];
    renderProjectHistory(nextHistory);
  }
}

async function openHistoryProjectInExplorer(item) {
  hideProjectHistoryContextMenu();
  if (!item || !item.projectPath) {
    return;
  }
  const result = await window.appApi.openProjectInExplorer({
    projectPath: item.projectPath,
  });
  if (!result || !result.ok) {
    appendLog("error", (result && result.message) || "打开资源管理器失败。");
  }
}

async function applySelectedProject(selected, options) {
  if (!selected || !selected.projectPath) {
    appendLog("warn", "历史项目数据无效。");
    return;
  }
  const logMessage = options?.logMessage;
  const alias =
    selected.alias != null
      ? selected.alias
      : selected.config && selected.config.alias
        ? selected.config.alias
        : "";
  setProjectPath(selected.projectPath, alias);
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

function hideAllContextMenus() {
  hideContextMenu();
  hideProjectHistoryContextMenu();
}

function showContextMenu(event, item, panel) {
  hideProjectHistoryContextMenu();
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

async function confirmExtractGitSinceRef() {
  if (!state.projectPath) {
    appendLog("warn", "请先选择项目目录。");
    closeExtractGitSinceRefDialog();
    return;
  }

  const ref = String(state.selectedExtractGitRef || "").trim();
  if (!ref) {
    appendLog("warn", "请先选择要提取的 Git 选项。");
    return;
  }

  const label = state.selectedExtractGitLabel || ref;
  closeExtractGitSinceRefDialog();
  openLogDrawer();
  appendLog("info", `正在收集「${label}」相关的 Git 变更…`);
  el.btnExtractGitSinceRef.disabled = true;
  el.btnConfirmExtractGitSinceRef.disabled = true;

  try {
    const result = await window.appApi.extractGitSinceRef({
      projectPath: state.projectPath,
      ref,
    });

    if (!result.ok && result.code) {
      appendLog("error", result.message || "提取 Git 变更失败。");
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

    appendLog("info", result.message || "Git 变更提取完成。");
    if (result.failed && result.failed.length) {
      result.failed.forEach((item) => {
        appendLog(
          "error",
          `失败: ${item.relativePath} (${item.action}) - ${item.message || "未知错误"}`
        );
      });
    }
  } finally {
    el.btnExtractGitSinceRef.disabled = false;
    el.btnConfirmExtractGitSinceRef.disabled = true;
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
  el.btnDisconnectFtp.addEventListener("click", openDisconnectFtpDialog);
  el.btnSyncGitUnstaged.addEventListener("click", syncGitUnstaged);
  el.btnExtractGitSinceRef.addEventListener("click", openExtractGitSinceRefDialog);
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

  el.historySetAlias.addEventListener("click", () => {
    const target = state.historyContextTarget;
    hideProjectHistoryContextMenu();
    if (!target) {
      return;
    }
    openProjectAliasDialog(target);
  });

  el.historyOpenInExplorer.addEventListener("click", async () => {
    const target = state.historyContextTarget;
    await openHistoryProjectInExplorer(target);
  });

  document.addEventListener("click", (event) => {
    if (!el.contextMenu.contains(event.target)) {
      hideContextMenu();
    }
    if (!el.projectHistoryContextMenu.contains(event.target)) {
      hideProjectHistoryContextMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideAllContextMenus();
    }
  });

  window.addEventListener("blur", hideAllContextMenus);
  window.addEventListener("resize", hideAllContextMenus);
  window.addEventListener("scroll", hideAllContextMenus, true);
  el.btnCloseProjectHistory.addEventListener("click", () => {
    hideProjectHistoryContextMenu();
    closeProjectHistoryDialog();
  });
  el.btnCloseProjectAlias.addEventListener("click", () => {
    closeProjectAliasDialog();
  });
  el.btnCancelProjectAlias.addEventListener("click", () => {
    closeProjectAliasDialog();
  });
  el.btnConfirmProjectAlias.addEventListener("click", () => {
    confirmProjectAlias();
  });
  el.projectAliasInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmProjectAlias();
    }
  });
  el.projectAliasContent.addEventListener("submit", (event) => {
    event.preventDefault();
  });
  el.btnCloseDisconnectFtp.addEventListener("click", () => {
    closeDisconnectFtpDialog();
  });
  el.btnCancelDisconnectFtp.addEventListener("click", () => {
    closeDisconnectFtpDialog();
  });
  el.btnConfirmDisconnectFtp.addEventListener("click", () => {
    confirmDisconnectFtp();
  });
  el.btnCloseExtractGitSinceRef.addEventListener("click", () => {
    closeExtractGitSinceRefDialog();
  });
  el.btnCancelExtractGitSinceRef.addEventListener("click", () => {
    closeExtractGitSinceRefDialog();
  });
  el.btnConfirmExtractGitSinceRef.addEventListener("click", () => {
    confirmExtractGitSinceRef();
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
      hideProjectHistoryContextMenu();
      closeProjectHistoryDialog();
    }
  });
  el.projectAliasDialog.addEventListener("click", (event) => {
    if (!el.projectAliasDialog.open || event.target !== el.projectAliasDialog) {
      return;
    }
    const contentRect = el.projectAliasContent.getBoundingClientRect();
    const isOutsideContent =
      event.clientX < contentRect.left ||
      event.clientX > contentRect.right ||
      event.clientY < contentRect.top ||
      event.clientY > contentRect.bottom;
    if (isOutsideContent) {
      closeProjectAliasDialog();
    }
  });
  el.disconnectFtpDialog.addEventListener("click", (event) => {
    if (!el.disconnectFtpDialog.open || event.target !== el.disconnectFtpDialog) {
      return;
    }
    const contentRect = el.disconnectFtpContent.getBoundingClientRect();
    const isOutsideContent =
      event.clientX < contentRect.left ||
      event.clientX > contentRect.right ||
      event.clientY < contentRect.top ||
      event.clientY > contentRect.bottom;
    if (isOutsideContent) {
      closeDisconnectFtpDialog();
    }
  });
  el.extractGitSinceRefDialog.addEventListener("click", (event) => {
    if (!el.extractGitSinceRefDialog.open || event.target !== el.extractGitSinceRefDialog) {
      return;
    }
    const contentRect = el.extractGitSinceRefContent.getBoundingClientRect();
    const isOutsideContent =
      event.clientX < contentRect.left ||
      event.clientX > contentRect.right ||
      event.clientY < contentRect.top ||
      event.clientY > contentRect.bottom;
    if (isOutsideContent) {
      closeExtractGitSinceRefDialog();
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
  updateProjectTitle("");

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
      alias: last.config && last.config.alias,
      config: last.config,
    }, { logMessage: "已自动加载上次项目" });
  } else {
    appendLog("info", "未找到上次项目，请先选择项目目录。");
  }
}

init();
