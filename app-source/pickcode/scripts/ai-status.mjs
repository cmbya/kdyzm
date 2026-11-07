import { createStatusSummary, readWorkflowState } from "./ai-state.mjs";

const root = process.cwd();

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const jsonOutput = process.argv.includes("--json");
let summary;
try {
  const { state, tasks } = await readWorkflowState(root);
  summary = createStatusSummary(state, tasks);
} catch (error) {
  fail(error.message);
}

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  const countText = Object.entries(summary.taskCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ") || "none";
  process.stdout.write([
    `Goal: ${summary.currentGoal}`,
    `Status: ${summary.status}`,
    `Active tasks: ${(summary.activeTaskIds ?? []).join(", ") || "none"}`,
    `Ready tasks: ${(summary.readyTaskIds ?? []).join(", ") || "none"}`,
    `Tasks: ${countText}`,
    `Last verification: ${summary.lastVerification?.result ?? "not-run"}`,
    `Next: ${summary.nextStep ?? "none"}`
  ].join("\n") + "\n");
}
