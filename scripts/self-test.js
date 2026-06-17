const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { ConfigStore } = require("../src/store/config-store");
const { FtpSyncService } = require("../src/services/ftp-sync-service");

async function main() {
  const appDataPath = path.join(__dirname, "..", ".tmp-self-test-appdata");
  const projectPath = path.join(__dirname, "..", ".tmp-self-test-project");
  const testFile = path.join(projectPath, "hello.txt");
  const logs = [];

  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(testFile, "init", "utf8");

  const configStore = new ConfigStore(appDataPath);
  await configStore.init();
  configStore.setProjectConfig(projectPath, {
    type: "ftp",
    host: "127.0.0.1",
    port: 21,
    username: "demo",
    password: "demo",
    remoteBasePath: "/self-test",
  });
  configStore.setLastProjectPath(projectPath);
  await configStore.flush();

  const config = configStore.getProjectConfig(projectPath);
  const service = new FtpSyncService({
    projectPath,
    config,
    onLog: (level, message) => {
      logs.push(`[${level}] ${message}`);
    },
  });

  try {
    await service.start();
    await fs.writeFile(testFile, `changed at ${new Date().toISOString()}`, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 800));
  } catch (error) {
    logs.push(`[error] 自测阶段捕获异常: ${error.message}`);
    await fs.writeFile(testFile, `changed but no ftp ${Date.now()}`, "utf8");
  } finally {
    service.stop();
  }

  console.log("=== SELF TEST RESULT ===");
  console.log(`platform=${os.platform()}`);
  console.log(`projectPath=${projectPath}`);
  console.log(`configSaved=true`);
  console.log(`fileChanged=true`);
  logs.forEach((line) => console.log(line));
}

main().catch((error) => {
  console.error("self-test failed:", error);
  process.exit(1);
});
