import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredScripts = [
  "ai:status",
  "ai:task",
  "ai:evidence",
  "ai:context",
  "ai:serve",
  "verify:policy",
  "verify:fast",
  "verify:full",
  "verify:nightly"
];
const requiredProfiles = ["fast", "full", "nightly"];
const requiredSchemeAFiles = [
  ".codex-dev/state.json",
  ".codex-dev/tasks.json",
  ".codex-dev/context.md",
  ".codex-dev/api-sync.json",
  ".codex-dev/agents.md",
  "docs/SCHEME_A_OPTIMIZATION_PLAN.md",
  "scripts/ai-status.mjs",
  "scripts/ai-task.mjs",
  "scripts/ai-task-store.mjs",
  "scripts/ai-evidence.mjs",
  "scripts/ai-context.mjs",
  "scripts/ai-state.mjs",
  "scripts/ai-server.mjs",
  ".codex-dev/dashboard.html",
  "skills/ai-dev-workflow-a/SKILL.md",
  "skills/ai-dev-workflow-a/references/audit-checklist.md"
];

function fail(message) {
  process.stderr.write(`FAIL repository policy: ${message}\n`);
  process.exit(1);
}

async function exists(relativePath) {
  try {
    await access(path.join(projectRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

const packageJson = await readJson("package.json");
for (const scriptName of requiredScripts) {
  assert(packageJson.scripts?.[scriptName], `package.json is missing script "${scriptName}"`);
}

const config = await readJson("verification.config.json");
assert(config.version === 1, "verification.config.json must use version 1");
assert(
  JSON.stringify(Object.keys(config.profiles ?? {}).sort()) === JSON.stringify(requiredProfiles),
  "verification.config.json must define exactly fast, full, and nightly profiles"
);
assert(
  config.profiles.full.extends === "fast" && config.profiles.nightly.extends === "full",
  "verification profiles must compose by inheritance instead of duplicated task lists"
);

const workflow = await readFile(path.join(projectRoot, ".gitea", "workflows", "verify.yml"), "utf8");
assert(workflow.includes("npm run verify:full"), "Gitea CI must call npm run verify:full");
assert(workflow.includes("npm run verify:nightly"), "Gitea CI must call npm run verify:nightly");
for (const duplicatedCommand of [/node --test/, /semgrep(?:\s|$)/, /npm audit/]) {
  assert(!duplicatedCommand.test(workflow), `Gitea CI duplicates ${duplicatedCommand}`);
}

assert(await exists("renovate.json"), "Renovate must own dependency update automation");
assert(!(await exists(".github/dependabot.yml")), "Dependabot must not be enabled with Renovate");
assert(!(await exists(".github/dependabot.yaml")), "Dependabot must not be enabled with Renovate");
assert(await exists(".semgrep.yml"), "Semgrep policy file must exist for Gitea/cross-platform SAST");
for (const relativePath of requiredSchemeAFiles) {
  assert(await exists(relativePath), `Scheme A lightweight state layer is missing ${relativePath}`);
}

const agents = await readFile(path.join(projectRoot, "AGENTS.md"), "utf8");
const standardDoc = await readFile(path.join(projectRoot, "docs", "AI_DEVELOPMENT_STANDARD.md"), "utf8");
const toolBoundaryText = `${agents}\n${standardDoc}`;
assert(toolBoundaryText.includes("zvec"), "Project rules must document zvec/RAG as semantic retrieval only");
assert(toolBoundaryText.includes("CodeGraph"), "Project rules must keep CodeGraph ownership explicit");
assert(toolBoundaryText.includes(".codex-dev/state.json"), "Project rules must document .codex-dev/state.json as the lightweight state source");
assert(toolBoundaryText.includes("方案 A"), "Project rules must document Scheme A as the default lightweight workflow");

process.stdout.write("PASS repository policy\n");
