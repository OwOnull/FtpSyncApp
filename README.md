# 项目实时 FTP 同步工具（桌面版）

这是一个基于 Electron + Node.js 的桌面应用。支持按项目保存 FTP 配置，并在文件变化时自动同步到远程服务器。

## 功能清单

- 选择并打开任意项目目录（工作区）
- 自动加载上一次使用的项目
- 按项目分别存储配置（项目 A / 项目 B 配置互不影响）
- 支持配置：类型（当前为 ftp）、主机、端口、用户名、密码、部署路径（远程基路径）
- 实时监听项目变更并同步
  - `add` / `change` -> 上传文件
  - `unlink` -> 删除远程文件
  - `addDir` -> 创建远程目录
  - `unlinkDir` -> 删除远程目录
- 忽略目录：`.git`、`node_modules`、`runtime`、`.idea`、`.vscode`、`dist`、`build`
- 提供日志面板，可查看同步动作与失败原因

## 环境要求

- Windows
- 已安装 Node.js（建议 18+）
- 可使用 `npm` 命令

## 安装与启动（双击）

1. 进入应用目录 `D:\Program\Utility\FtpSyncApp`
2. 推荐双击 `start-app.vbs`（无黑框，使用 WScript 隐藏控制台启动）
3. 首次运行会自动执行 `npm install`，完成后自动启动应用
4. 后续再次双击可直接启动

### 启动入口区别

- `start-app.vbs`：推荐入口，隐藏 cmd 窗口启动 Electron。
- `start-app-hidden.bat`：兼容入口，内部调用 `start-app.vbs`，效果同上。
- `start-app.bat`：原始入口，会显示 cmd 窗口，便于排查启动问题。

## 使用步骤

1. 点击“选择项目”选择本地项目目录
2. 填写 FTP 配置（主机、端口、用户名、密码、远程基路径）
3. 点击“保存配置”
4. 点击“开始同步”
5. 修改项目文件，观察日志中的同步记录
6. 需要时点击“停止同步”

## 目录面板使用

- 在“目录面板”区域可查看本地目录与远程目录。
- 本地目录：
  - 点击“刷新本地”读取当前项目目录内容。
  - 点击目录项后的“进入”进入下一级目录。
  - 点击“返回上级”回到父级目录。
- 远程目录（基于当前 FTP 配置）：
  - 点击“刷新远程”读取 `remoteBasePath`（部署路径）下的远程目录。
  - 点击目录项后的“进入”进入下一级目录。
  - 点击“返回上级”回到父级目录。
- 若 FTP 未配置或连接失败，远程目录面板会显示明确错误信息。

## 配置存储与安全说明

- 配置文件存放在 Electron 的用户数据目录下，文件名为 `project-ftp-sync-config.json`
- 配置按“项目绝对路径”作为 key 分开保存
- **密码目前为明文存储**，请确保本机账号与磁盘权限安全，必要时自行改造为加密存储
- 程序日志不会打印密码

## 日志弹窗布局调试

默认使用中性量产配色（白/浅灰）。需要核对层级时可开启**高对比调试色**：

| 选择器 | 调试色 | 含义 |
| --- | --- | --- |
| `.log-integrated-handle` | 蓝色 `#69c0ff` | 拖动手柄本体 |
| `.log-drawer-body` | 杏色 `#fff4e6` | 标题与内边距区 |
| `.logs` | 绿色 `#95de64` | 日志文本滚动区 |

**开关**（DevTools Console 或改 `index.html` 根节点 `data-debug-log-layout`）：

```js
document.documentElement.dataset.debugLogLayout = 'on'      // 调试色
document.documentElement.dataset.debugLogLayout = 'off'     // 默认量产 UI
document.documentElement.dataset.debugLogLayout = 'outline' // 叠加虚线描边
```

## 常见问题

- 启动监听后日志提示“FTP 连接失败”
  - 检查主机/端口/用户名/密码是否正确
  - 检查服务器是否允许该账号登录和写入
  - 检查本机网络、公司防火墙或 VPN 限制

- 文件变更后没有同步
  - 确认已点击“开始同步”
  - 确认变更文件不在忽略目录中
  - 查看日志是否有具体错误
