const path = require("path");
const {
  gitOutputToProjectRelative,
  buildProjectLocalPath,
} = require("../src/services/ftp-sync-service");

const gitRoot = path.resolve("D:/Workpace/SWXWL/250822yueyangwenlv/yywl");
const projectPath = path.join(gitRoot, "python");

// git -C <gitRoot> 后，diff / ls-files 输出均相对仓库根；勿将 cwd 相对的 workflow_status.py 当作根相对路径
const cases = [
  {
    name: "已跟踪修改（git diff 输出）",
    gitRel: "python/ws_workflow.py",
    expectProjectRel: "ws_workflow.py",
    expectLocal: path.join(projectPath, "ws_workflow.py"),
  },
  {
    name: "已跟踪修改 api_server",
    gitRel: "python/api_server.py",
    expectProjectRel: "api_server.py",
    expectLocal: path.join(projectPath, "api_server.py"),
  },
  {
    name: "未跟踪新增（git -C gitRoot ls-files 输出）",
    gitRel: "python/workflow_status.py",
    expectProjectRel: "workflow_status.py",
    expectLocal: path.join(projectPath, "workflow_status.py"),
  },
  {
    name: "仓库根或 cwd 相对的 workflow_status.py 均应跳过",
    gitRel: "workflow_status.py",
    expectProjectRel: null,
    expectLocal: null,
    note: "git -C gitRoot 后 ls-files 输出 python/workflow_status.py；若误用 projectPath cwd 会得到 workflow_status.py 并被错误 resolve 到仓库根",
  },
];

let passed = 0;
let failed = 0;

for (const testCase of cases) {
  const projectRel = gitOutputToProjectRelative(
    gitRoot,
    projectPath,
    testCase.gitRel
  );
  const localPath = projectRel
    ? buildProjectLocalPath(projectPath, projectRel)
    : null;

  const relOk = projectRel === testCase.expectProjectRel;
  const localOk = localPath === testCase.expectLocal;
  const ok = relOk && localOk;

  if (ok) {
    passed += 1;
    const label = testCase.name ? `${testCase.name}: ` : "";
    console.log(`[PASS] ${label}${testCase.gitRel} -> projectRel=${projectRel}`);
  } else {
    failed += 1;
    const label = testCase.name ? `${testCase.name}: ` : "";
    console.log(`[FAIL] ${label}${testCase.gitRel}`);
    console.log(`  expect projectRel: ${testCase.expectProjectRel}`);
    console.log(`  actual projectRel: ${projectRel}`);
    console.log(`  expect local:      ${testCase.expectLocal}`);
    console.log(`  actual local:      ${localPath}`);
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
