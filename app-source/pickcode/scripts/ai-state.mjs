import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createTaskViews,
  deriveWorkflowState,
  getReadyTaskIds,
  validateTaskGraph
} from "./ai-task-store.mjs";

export async function readJson(root, relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${relativePath}: ${error.message}`);
  }
}

export async function readText(root, relativePath) {
  try {
    return await readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${relativePath}: ${error.message}`);
  }
}

export function countTasks(tasks) {
  const counts = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

function workflowFields(state) {
  return {
    status: state.status,
    activeTaskId: state.activeTaskId ?? null,
    activeTaskIds: state.activeTaskIds ?? [],
    readyTaskIds: state.readyTaskIds ?? [],
    needsVerificationTaskIds: state.needsVerificationTaskIds ?? []
  };
}

function workflowStateIsStale(storedState, derivedState) {
  return JSON.stringify(workflowFields(storedState))
    !== JSON.stringify(workflowFields(derivedState));
}

export function createStatusSummary(state, tasks) {
  const derived = deriveWorkflowState(state, tasks);
  const taskCounts = countTasks(tasks);
  const activeTask = tasks.find((task) => task.id === derived.activeTaskId) ?? null;
  return {
    currentGoal: derived.currentGoal,
    status: derived.status,
    activeTaskId: derived.activeTaskId,
    activeTaskIds: derived.activeTaskIds,
    readyTaskIds: getReadyTaskIds(tasks),
    needsVerificationTaskIds: derived.needsVerificationTaskIds,
    activeTaskTitle: activeTask?.title ?? null,
    nextStep: derived.nextStep,
    lastVerification: derived.lastVerification ?? null,
    taskCounts,
    readOnly: true,
    stateStale: Boolean(state.stateStale)
  };
}

export async function readWorkflowState(root) {
  const [storedState, taskState] = await Promise.all([
    readJson(root, ".codex-dev/state.json"),
    readJson(root, ".codex-dev/tasks.json")
  ]);
  const rawTasks = taskState.tasks ?? [];
  validateTaskGraph(rawTasks);
  const taskViews = await createTaskViews(root, rawTasks);
  const derivedState = deriveWorkflowState(storedState, taskViews);
  const stateStale = workflowStateIsStale(storedState, derivedState);
  const state = {
    ...derivedState,
    readOnly: true,
    stateStale
  };
  return {
    state,
    storedState,
    taskState,
    tasks: taskViews,
    taskViews,
    rawTasks,
    stateStale
  };
}
