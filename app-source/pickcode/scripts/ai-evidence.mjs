import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  assertSafeId,
  readStore,
  taskFingerprint,
  worktreeFingerprint,
  writeEvidence
} from "./ai-task-store.mjs";

function formatCommand(args) {
  return args
    .map((argument) => (/\s|["']/u.test(argument) ? JSON.stringify(argument) : argument))
    .join(" ");
}

function evidenceId(taskId) {
  return `${taskId}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

async function main() {
  const [command, taskId, separator, ...commandArgs] = process.argv.slice(2);
  if (command !== "run" || !taskId || separator !== "--" || commandArgs.length === 0) {
    throw new Error("Usage: ai-evidence run <task-id> -- <command> [args]");
  }
  assertSafeId(taskId, "Task id");

  const root = process.cwd();
  const { taskState } = await readStore(root);
  const task = taskState.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`Unknown task id: ${taskId}`);
  }
  if (task.status !== "doing") {
    throw new Error(`Cannot create evidence for ${taskId} from status ${task.status}`);
  }

  const startedAt = new Date().toISOString();
  const startedMilliseconds = Date.now();
  const sourceHashBefore = await worktreeFingerprint(root);
  const taskHash = taskFingerprint(task);
  const execution = spawnSync(commandArgs[0], commandArgs.slice(1), {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: "inherit"
  });
  const sourceHashAfter = await worktreeFingerprint(root);
  const finishedAt = new Date().toISOString();
  const exitCode = execution.status ?? 1;
  const id = evidenceId(taskId);
  const evidence = {
    schemaVersion: 1,
    id,
    taskId,
    kind: "command",
    command: formatCommand(commandArgs),
    commandArgs,
    startedAt,
    finishedAt,
    durationMilliseconds: Date.now() - startedMilliseconds,
    exitCode,
    result: exitCode === 0 && !execution.error ? "pass" : "fail",
    executedChecks: execution.error ? 0 : 1,
    skippedChecks: 0,
    taskHash,
    sourceHashBefore,
    sourceHashAfter
  };
  if (execution.error) {
    evidence.error = execution.error.message;
  }

  await writeEvidence(root, evidence);
  process.stdout.write(`${id}\n`);
  process.exitCode = exitCode;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
