import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createStatusSummary, readWorkflowState } from "./ai-state.mjs";

const root = process.cwd();

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    fail(`Unable to read ${relativePath}: ${error.message}`);
  }
}

const command = process.argv[2] ?? "refresh";
if (!["refresh", "--help", "help"].includes(command)) {
  fail(`Unknown command: ${command}`);
}
if (command === "--help" || command === "help") {
  process.stdout.write("Usage: node scripts/ai-context.mjs refresh\n");
  process.exit(0);
}

const { state: storedState, tasks } = await readWorkflowState(root);
const state = createStatusSummary(storedState, tasks);
const openTasks = tasks.filter((task) => ["pending", "doing", "blocked"].includes(task.status));
const topTasks = openTasks.slice(0, 8);

const taskLines = topTasks.length
  ? topTasks.map((task) => `- ${task.id} [${task.status}] ${task.title} (${task.owner ?? "unowned"})`).join("\n")
  : "- 当前没有未完成任务。";

const content = `# 当前开发上下文

## 当前目标

${state.currentGoal ?? "待填写"}

## 当前状态

- 状态: ${state.status ?? "unknown"}
- 当前任务: ${(state.activeTaskIds ?? []).join(", ") || "none"}
- 可开始任务: ${(state.readyTaskIds ?? []).join(", ") || "none"}
- 最近验证: ${state.lastVerification?.result ?? "not-run"}
- 下一步: ${state.nextStep ?? "从 .codex-dev/tasks.json 领取任务"}

## 当前任务

${taskLines}

## 读取顺序

1. 先读 \`.codex-dev/state.json\`，确认当前目标、状态和下一步。
2. 再读 \`.codex-dev/tasks.json\`，只选择一个可验证的小任务。
3. 需要业务背景时再读本文件，不默认读取大型 PRD、设计稿、历史会话或截图目录。
4. 按任务需要使用 zvec/RAG 语义召回、\`rg\` 精确定位、CodeGraph 结构/影响面分析，以及相关测试和适用的 \`verify:*\` 门禁。

## 低 token 原则

- 主会话只做调度、决策、合并和验收。
- 子 Agent 或独立任务只读取自己的任务卡和必要源文件。
- 大文档只当长期契约，不当每轮执行上下文。
- \`PROJECT_DEVELOPMENT.md\` 只写人类摘要，机器状态写入 \`.codex-dev/state.json\`。
`;

await writeFile(path.join(root, ".codex-dev", "context.md"), content, "utf8");
process.stdout.write("Updated .codex-dev/context.md\n");
