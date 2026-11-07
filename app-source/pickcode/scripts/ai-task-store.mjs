import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const tasksFile = ".codex-dev/tasks.json";
const stateFile = ".codex-dev/state.json";
const lockFile = ".codex-dev/tasks.lock";
const validStatuses = new Set(["pending", "doing", "blocked", "verified", "cancelled"]);
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const ignoredDirectoryNames = new Set([
  ".codegraph",
  ".git",
  ".gstack",
  "node_modules"
]);
const generatedCodexDevFiles = new Set([
  "api-sync.json",
  "context.md",
  "state.json",
  "tasks.json",
  "tasks.lock"
]);
const execFileAsync = promisify(execFile);

function shouldIgnoreEntry(relativePath, entry) {
  if (ignoredDirectoryNames.has(entry.name)) {
    return true;
  }
  const normalizedPath = relativePath.replaceAll("\\", "/");
  if (normalizedPath === ".codex-dev/evidence" && entry.isDirectory()) {
    return true;
  }
  if (!normalizedPath.startsWith(".codex-dev/")) {
    return false;
  }
  return generatedCodexDevFiles.has(entry.name) || entry.name.endsWith(".tmp");
}

function shouldIgnoreListedPath(relativePath) {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const parts = normalizedPath.split("/");
  if (parts.some((part) => ignoredDirectoryNames.has(part))) {
    return true;
  }
  if (normalizedPath.startsWith(".codex-dev/evidence/")) {
    return true;
  }
  if (!normalizedPath.startsWith(".codex-dev/")) {
    return false;
  }
  const name = parts.at(-1);
  return generatedCodexDevFiles.has(name) || name.endsWith(".tmp");
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

export function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function taskFingerprint(task) {
  const {
    status: _status,
    evidenceId: _evidenceId,
    startedAt: _startedAt,
    completedAt: _completedAt,
    verifiedAt: _verifiedAt,
    verificationState: _verificationState,
    ...definition
  } = task;
  return fingerprint(definition);
}

export function assertSafeId(id, kind = "Id") {
  if (typeof id !== "string" || !safeIdPattern.test(id)) {
    throw new Error(`${kind} must be a safe token`);
  }
  return id;
}

export async function worktreeFingerprint(root) {
  const files = [];

  async function addPath(relativePath) {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    const fullPath = path.resolve(root, relativePath);
    const rootPrefix = `${path.resolve(root)}${path.sep}`;
    if (fullPath !== path.resolve(root) && !fullPath.startsWith(rootPrefix)) {
      throw new Error(`Source path escapes project root: ${normalizedPath}`);
    }

    const metadata = await lstat(fullPath);
    if (metadata.isSymbolicLink()) {
      files.push([normalizedPath, "symlink", await readlink(fullPath)]);
    } else if (metadata.isFile()) {
      const contentHash = createHash("sha256")
        .update(await readFile(fullPath))
        .digest("hex");
      files.push([normalizedPath, "file", contentHash]);
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    );
    const listedPaths = stdout.split("\0").filter(Boolean);
    const additionalCodexSources = [
      ".codex-dev/agents.md",
      ".codex-dev/dashboard.html"
    ];
    for (const candidate of additionalCodexSources) {
      try {
        await lstat(path.join(root, candidate));
        listedPaths.push(candidate);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    for (const relativePath of [...new Set(listedPaths)].sort()) {
      if (!shouldIgnoreListedPath(relativePath)) {
        await addPath(relativePath);
      }
    }
    return fingerprint(files);
  } catch {
    // A missing Git binary, non-repository, or transient listing error uses the fallback.
    files.length = 0;
  }

  async function walk(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (shouldIgnoreEntry(relativePath, entry)) {
        continue;
      }
      const fullPath = path.join(directory, entry.name);
      const normalizedPath = relativePath.replaceAll("\\", "/");

      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        await addPath(normalizedPath);
      }
    }
  }

  await walk(root);
  return fingerprint(files);
}

export async function readJson(root, file) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

export async function atomicWriteJson(root, file, value) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export function validateTaskGraph(tasks) {
  if (!Array.isArray(tasks)) {
    throw new Error("tasks.json tasks must be an array");
  }

  const tasksById = new Map();
  for (const task of tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw new Error("Every task must be an object");
    }
    assertSafeId(task.id, "Task id");
    if (tasksById.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    if (!validStatuses.has(task.status)) {
      throw new Error(`Invalid status for ${task.id}: ${task.status}`);
    }
    if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) {
      throw new Error(`dependsOn for ${task.id} must be an array`);
    }
    tasksById.set(task.id, task);
  }

  for (const task of tasks) {
    const dependencies = task.dependsOn ?? [];
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`Duplicate dependency for ${task.id}`);
    }
    for (const dependencyId of dependencies) {
      assertSafeId(dependencyId, "Dependency id");
      if (!tasksById.has(dependencyId)) {
        throw new Error(`Unknown dependency ${dependencyId} for ${task.id}`);
      }
      if (dependencyId === task.id) {
        throw new Error(`Circular task dependency at ${task.id}`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(taskId) {
    if (visiting.has(taskId)) {
      throw new Error(`Circular task dependency at ${taskId}`);
    }
    if (visited.has(taskId)) {
      return;
    }

    visiting.add(taskId);
    for (const dependencyId of tasksById.get(taskId).dependsOn ?? []) {
      visit(dependencyId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const taskId of tasksById.keys()) {
    visit(taskId);
  }
}

export function hasValidVerification(task) {
  if (task && Object.hasOwn(task, "verificationState")) {
    return task.status === "verified" && task.verificationState === "evidenced";
  }
  return Boolean(
    task
      && task.status === "verified"
      && typeof task.evidenceId === "string"
      && safeIdPattern.test(task.evidenceId)
  );
}

async function inspectTaskVerification(root, task) {
  if (task.status !== "verified") {
    return "not-verified";
  }
  if (typeof task.evidenceId !== "string" || !safeIdPattern.test(task.evidenceId)) {
    return "needs-verification";
  }

  try {
    const evidence = JSON.parse(await readFile(evidencePath(root, task.evidenceId), "utf8"));
    const isValid = evidence.id === task.evidenceId
      && evidence.taskId === task.id
      && evidence.result === "pass"
      && evidence.exitCode === 0
      && Number.isInteger(evidence.executedChecks)
      && evidence.executedChecks > 0
      && evidence.skippedChecks === 0
      && typeof evidence.command === "string"
      && evidence.command.length > 0
      && evidence.sourceHashBefore === evidence.sourceHashAfter
      && evidence.taskHash === taskFingerprint(task);
    return isValid ? "evidenced" : "needs-verification";
  } catch {
    return "needs-verification";
  }
}

export async function createTaskViews(root, tasks) {
  return Promise.all(tasks.map(async (task) => ({
    ...task,
    verificationState: await inspectTaskVerification(root, task)
  })));
}

export function getNeedsVerificationTaskIds(tasks) {
  return tasks
    .filter((task) => task.status === "verified" && !hasValidVerification(task))
    .map((task) => task.id);
}

export function getReadyTaskIds(tasks) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return tasks
    .filter((task) => {
      if (task.status !== "pending") {
        return false;
      }
      return (task.dependsOn ?? []).every((id) => hasValidVerification(tasksById.get(id)));
    })
    .map((task) => task.id);
}

export function deriveWorkflowState(state, tasks) {
  validateTaskGraph(tasks);
  const activeTaskIds = tasks
    .filter((task) => task.status === "doing")
    .map((task) => task.id);
  const readyTaskIds = getReadyTaskIds(tasks);
  const needsVerificationTaskIds = getNeedsVerificationTaskIds(tasks);
  const actionableTasks = tasks.filter((task) => task.status !== "cancelled");
  const unfinishedTasks = actionableTasks.filter((task) => !hasValidVerification(task));

  let status = "not-started";
  if (activeTaskIds.length > 0) {
    status = "doing";
  } else if (actionableTasks.length > 0 && unfinishedTasks.length === 0) {
    status = "verified";
  } else if (readyTaskIds.length > 0) {
    status = "ready";
  } else if (needsVerificationTaskIds.length > 0) {
    status = "needs-verification";
  } else if (unfinishedTasks.length > 0) {
    status = "blocked";
  }

  let nextStep = state.nextStep ?? null;
  if (readyTaskIds.length > 0) {
    nextStep = `Ready: ${readyTaskIds.join(", ")}`;
  } else if (activeTaskIds.length > 0) {
    nextStep = `Continue: ${activeTaskIds.join(", ")}`;
  } else if (needsVerificationTaskIds.length > 0) {
    nextStep = `Needs verification evidence: ${needsVerificationTaskIds.join(", ")}`;
  } else if (status === "verified") {
    nextStep = "No open tasks. Start new work only from the user's next goal.";
  } else if (status === "blocked") {
    nextStep = "Resolve the recorded task blockers before starting dependent work.";
  }

  return {
    ...state,
    status,
    activeTaskIds,
    activeTaskId: activeTaskIds[0] ?? null,
    readyTaskIds,
    needsVerificationTaskIds,
    nextStep
  };
}

export async function readStore(root) {
  const [state, taskState] = await Promise.all([
    readJson(root, stateFile),
    readJson(root, tasksFile)
  ]);
  const normalizedTaskState = {
    ...taskState,
    tasks: taskState.tasks ?? [],
    revision: taskState.revision ?? 0
  };
  if (!Number.isInteger(normalizedTaskState.revision) || normalizedTaskState.revision < 0) {
    throw new Error("Task revision must be a non-negative integer");
  }
  validateTaskGraph(normalizedTaskState.tasks);
  return { state, taskState: normalizedTaskState };
}

async function acquireWriteLock(root, timeoutMilliseconds = 3000) {
  const lockPath = path.join(root, lockFile);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMilliseconds;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return async () => {
        await handle.close();
        await unlink(lockPath).catch((error) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        });
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("Task store is busy; retry the command");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function writeStore(root, state, taskState, expectedRevision) {
  const release = await acquireWriteLock(root);
  try {
    const current = await readJson(root, tasksFile);
    const currentRevision = current.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new Error(
        `Task revision conflict; expected ${expectedRevision}, found ${currentRevision}`
      );
    }

    validateTaskGraph(taskState.tasks);
    const nextTaskState = {
      ...taskState,
      revision: expectedRevision + 1
    };
    const taskViews = await createTaskViews(root, nextTaskState.tasks);
    const derivedState = deriveWorkflowState(state, taskViews);

    await atomicWriteJson(root, tasksFile, nextTaskState);
    await atomicWriteJson(root, stateFile, derivedState);
    taskState.revision = nextTaskState.revision;
    return derivedState;
  } finally {
    await release();
  }
}

export function evidencePath(root, id) {
  assertSafeId(id, "Evidence id");
  return path.join(root, ".codex-dev", "evidence", `${id}.json`);
}

export async function writeEvidence(root, evidence) {
  await atomicWriteJson(
    root,
    path.relative(root, evidencePath(root, evidence.id)),
    evidence
  );
}
