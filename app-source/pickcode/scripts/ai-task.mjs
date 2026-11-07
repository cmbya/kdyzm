import { readFile } from "node:fs/promises";
import {
  assertSafeId,
  createTaskViews,
  evidencePath,
  getReadyTaskIds,
  hasValidVerification,
  readStore,
  taskFingerprint,
  worktreeFingerprint,
  writeStore
} from "./ai-task-store.mjs";

const root = process.cwd();
const usage = [
  "Usage:",
  "  ai-task list [--ready] [--json]",
  "  ai-task add --title <title> [--owner <owner>] [--priority <priority>] [--depends-on <id,id>]",
  "              [--scope <path,path>] [--context-files <path,path>] [--notes <text>]",
  "  ai-task start <id>",
  "  ai-task done <id> --evidence <evidence-id>"
].join("\n");

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function parseOptions(argv, schema) {
  const options = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }

    const name = item.slice(2);
    const kind = schema[name];
    if (!kind) {
      fail(`Unknown flag: --${name}`, 2);
    }
    if (Object.hasOwn(options, name)) {
      fail(`Duplicate flag: --${name}`, 2);
    }
    if (kind === "boolean") {
      options[name] = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Missing value for --${name}`, 2);
    }
    options[name] = value;
    index += 1;
  }

  return { options, positional };
}

function requirePositionals(positional, count, command) {
  if (positional.length !== count) {
    fail(`${command} expects ${count} task id${count === 1 ? "" : "s"}`, 2);
  }
}

function findTask(tasks, id) {
  assertSafeId(id, "Task id");
  const found = tasks.find((item) => item.id === id);
  if (!found) {
    fail(`Unknown task id: ${id}`);
  }
  return found;
}

function nextId(tasks) {
  const largestNumber = tasks.reduce((maximum, item) => {
    const match = /^TASK-(\d+)$/u.exec(item.id);
    return Math.max(maximum, Number(match?.[1] ?? 0));
  }, 0);
  return `TASK-${String(largestNumber + 1).padStart(3, "0")}`;
}

function parseDependencies(value) {
  if (value === undefined) {
    return [];
  }
  const dependencies = value.split(",").map((item) => item.trim());
  if (dependencies.some((item) => item.length === 0)) {
    fail("--depends-on must be a comma-separated list of task ids", 2);
  }
  for (const id of dependencies) {
    assertSafeId(id, "Dependency id");
  }
  return dependencies;
}

function parseListFlag(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    fail(`--${name} must be a comma-separated list`, 2);
  }
  return items;
}

function validateEvidence(evidence, evidenceId, selected, currentSourceHash) {
  const hashesMatch = evidence.sourceHashBefore
    && evidence.sourceHashBefore === evidence.sourceHashAfter
    && evidence.sourceHashAfter === currentSourceHash;
  const commandWasExecuted = typeof evidence.command === "string"
    && evidence.command.length > 0
    && Number.isInteger(evidence.executedChecks)
    && evidence.executedChecks > 0
    && evidence.skippedChecks === 0;

  return evidence.id === evidenceId
    && evidence.taskId === selected.id
    && evidence.result === "pass"
    && evidence.exitCode === 0
    && commandWasExecuted
    && hashesMatch
    && evidence.taskHash === taskFingerprint(selected);
}

async function readEvidence(id) {
  assertSafeId(id, "Evidence id");
  try {
    return JSON.parse(await readFile(evidencePath(root, id), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(`Unknown evidence: ${id}`);
    }
    fail(`Unable to read evidence ${id}: ${error.message}`);
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }

  const { state, taskState } = await readStore(root);
  const now = new Date().toISOString();

  if (command === "list") {
    const { options, positional } = parseOptions(argv, {
      ready: "boolean",
      json: "boolean"
    });
    requirePositionals(positional, 0, "list");
    const taskViews = await createTaskViews(root, taskState.tasks);
    const readyIds = new Set(getReadyTaskIds(taskViews));
    const tasks = options.ready
      ? taskState.tasks.filter((item) => readyIds.has(item.id))
      : taskState.tasks;
    const output = options.json
      ? JSON.stringify(tasks, null, 2)
      : tasks.map((item) => `${item.id} [${item.status}] ${item.title}`).join("\n");
    process.stdout.write(`${output}\n`);
    return;
  }

  if (command === "add") {
    const { options, positional } = parseOptions(argv, {
      title: "value",
      owner: "value",
      priority: "value",
      verification: "value",
      "depends-on": "value",
      scope: "value",
      "context-files": "value",
      notes: "value"
    });
    requirePositionals(positional, 0, "add");
    if (!options.title?.trim()) {
      fail("Missing required flag: --title", 2);
    }

    const addedTask = {
      id: nextId(taskState.tasks),
      title: options.title.trim(),
      owner: options.owner ?? "orchestrator",
      status: "pending",
      priority: options.priority ?? "medium",
      dependsOn: parseDependencies(options["depends-on"]),
      verification: options.verification ?? null,
      createdAt: now,
      ...(options.scope ? { scope: parseListFlag(options.scope, "scope") } : {}),
      ...(options["context-files"]
        ? { contextFiles: parseListFlag(options["context-files"], "context-files") }
        : {}),
      ...(options.notes ? { notes: options.notes } : {})
    };
    taskState.tasks.push(addedTask);
    await writeStore(root, state, taskState, taskState.revision);
    process.stdout.write(`Added ${addedTask.id}\n`);
    return;
  }

  if (command === "start") {
    const { positional } = parseOptions(argv, {});
    requirePositionals(positional, 1, "start");
    const selected = findTask(taskState.tasks, positional[0]);
    const taskViews = await createTaskViews(root, taskState.tasks);
    const selectedView = taskViews.find((item) => item.id === selected.id);
    const mayReverifyLegacy = selected.status === "verified" && !hasValidVerification(selectedView);
    if (selected.status !== "pending" && !mayReverifyLegacy) {
      fail(`Cannot start ${selected.id} from status ${selected.status}`);
    }

    const tasksById = new Map(taskViews.map((item) => [item.id, item]));
    const unmet = (selected.dependsOn ?? []).filter(
      (id) => !hasValidVerification(tasksById.get(id))
    );
    if (unmet.length > 0) {
      fail(`Cannot start ${selected.id}; unmet dependencies: ${unmet.join(", ")}`);
    }

    selected.status = "doing";
    selected.startedAt = now;
    delete selected.evidenceId;
    delete selected.completedAt;
    delete selected.verifiedAt;
    await writeStore(root, state, taskState, taskState.revision);
    process.stdout.write(`Started ${selected.id}\n`);
    return;
  }

  if (command === "done") {
    const { options, positional } = parseOptions(argv, { evidence: "value" });
    requirePositionals(positional, 1, "done");
    if (!options.evidence) {
      fail("Missing required flag: --evidence", 2);
    }

    const selected = findTask(taskState.tasks, positional[0]);
    if (selected.status !== "doing") {
      fail(`Cannot complete ${selected.id} from status ${selected.status}`);
    }
    const evidence = await readEvidence(options.evidence);
    const currentSourceHash = await worktreeFingerprint(root);
    if (!validateEvidence(evidence, options.evidence, selected, currentSourceHash)) {
      fail("Evidence is failed, skipped, empty, stale, or belongs to another task");
    }
    if (taskState.tasks.some(
      (item) => item.id !== selected.id && item.evidenceId === options.evidence
    )) {
      fail(`Evidence ${options.evidence} has already been consumed`);
    }

    selected.status = "verified";
    selected.evidenceId = options.evidence;
    selected.completedAt = now;
    selected.verifiedAt = evidence.finishedAt ?? now;
    state.lastVerification = evidence;
    state.lastVerifiedAt = selected.verifiedAt;
    await writeStore(root, state, taskState, taskState.revision);
    process.stdout.write(`Verified ${selected.id}\n`);
    return;
  }

  fail(`Unknown command: ${command}`, 2);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(error.exitCode ?? 1);
}
