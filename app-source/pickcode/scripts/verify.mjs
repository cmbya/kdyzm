import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertSafeId,
  readStore,
  taskFingerprint,
  worktreeFingerprint,
  writeEvidence
} from "./ai-task-store.mjs";

const supportedProfiles = ["fast", "full", "nightly"];
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = 1) {
  throw new CliError(message, exitCode);
}

function formatCommand(args) {
  return args
    .map((argument) => (/\s|["']/u.test(argument) ? JSON.stringify(argument) : argument))
    .join(" ");
}

function parseArguments(argv) {
  if (argv[0] === "--list") {
    if (argv.length !== 1) {
      fail("--list does not accept additional arguments", 2);
    }
    return { list: true };
  }

  const profile = argv[0];
  let configPath = null;
  let taskId = null;
  const seen = new Set();

  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--config", "--task"].includes(name)) {
      fail(`Unknown argument: ${name}`, 2);
    }
    if (seen.has(name)) {
      fail(`Duplicate argument: ${name}`, 2);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Missing value for ${name}`, 2);
    }
    seen.add(name);
    if (name === "--config") {
      configPath = path.resolve(value);
    } else {
      assertSafeId(value, "Task id");
      taskId = value;
    }
    index += 1;
  }

  return {
    list: false,
    profile,
    configPath: configPath ?? path.join(taskId ? process.cwd() : projectRoot, "verification.config.json"),
    taskId
  };
}

function resolveTasks(config, profileName, visiting = new Set()) {
  const profile = config.profiles?.[profileName];
  if (!profile) {
    fail(`Profile "${profileName}" is missing from verification.config.json`);
  }
  if (visiting.has(profileName)) {
    fail(`Circular profile inheritance detected at "${profileName}"`);
  }

  visiting.add(profileName);
  const inherited = profile.extends
    ? resolveTasks(config, profile.extends, visiting)
    : [];
  visiting.delete(profileName);
  return [...new Set([...inherited, ...(profile.tasks ?? [])])];
}

function validateConfig(config) {
  if (config.version !== 1) {
    fail("verification.config.json must use version 1");
  }
  for (const profileName of supportedProfiles) {
    if (!config.profiles?.[profileName]) {
      fail(`Required profile "${profileName}" is missing`);
    }
    const budget = config.profiles[profileName].budgetSeconds;
    if (!Number.isFinite(budget) || budget <= 0) {
      fail(`Profile "${profileName}" must define a positive budgetSeconds`);
    }
    for (const taskName of resolveTasks(config, profileName)) {
      if (!config.tasks?.[taskName]) {
        fail(`Profile "${profileName}" references unknown task "${taskName}"`);
      }
    }
  }
}

function shouldSkip(task) {
  return task.whenEnv && !["1", "true", "yes"].includes(
    String(process.env[task.whenEnv] ?? "").toLowerCase()
  );
}

function runProfile(config, profileName, executionRoot) {
  const profile = config.profiles[profileName];
  const taskNames = resolveTasks(config, profileName);
  const startedMilliseconds = Date.now();
  const budgetMilliseconds = profile.budgetSeconds * 1000;
  const checks = [];

  process.stdout.write(
    `Verification profile: ${profileName} (${taskNames.length} tasks, budget ${profile.budgetSeconds}s)\n`
  );

  for (const taskName of taskNames) {
    const task = config.tasks[taskName];
    if (shouldSkip(task)) {
      process.stdout.write(`SKIP ${taskName}: set ${task.whenEnv}=1 to enable\n`);
      checks.push({ name: taskName, result: "skipped", exitCode: null, durationMilliseconds: 0 });
      continue;
    }

    const elapsed = Date.now() - startedMilliseconds;
    const remaining = budgetMilliseconds - elapsed;
    if (remaining <= 0) {
      return {
        result: "fail",
        exitCode: 1,
        error: `Profile "${profileName}" exceeded its ${profile.budgetSeconds}s budget`,
        checks
      };
    }

    process.stdout.write(`RUN  ${taskName}\n`);
    const checkStarted = Date.now();
    const execution = spawnSync(task.command, task.args ?? [], {
      cwd: executionRoot,
      env: process.env,
      stdio: "inherit",
      shell: false,
      timeout: Math.min(remaining, (task.timeoutSeconds ?? profile.budgetSeconds) * 1000)
    });
    const exitCode = execution.status ?? 1;
    checks.push({
      name: taskName,
      command: formatCommand([task.command, ...(task.args ?? [])]),
      result: exitCode === 0 && !execution.error ? "pass" : "fail",
      exitCode,
      durationMilliseconds: Date.now() - checkStarted,
      ...(execution.error ? { error: execution.error.message } : {})
    });

    if (execution.error) {
      return {
        result: "fail",
        exitCode: 1,
        error: `Task "${taskName}" could not run: ${execution.error.message}`,
        checks
      };
    }
    if (execution.status !== 0) {
      return {
        result: "fail",
        exitCode,
        error: `Task "${taskName}" failed with exit code ${execution.status}`,
        checks
      };
    }
  }

  const executedChecks = checks.filter((check) => check.result !== "skipped").length;
  const skippedChecks = checks.filter((check) => check.result === "skipped").length;
  const result = executedChecks === 0
    ? "skipped"
    : skippedChecks > 0
      ? "partial"
      : "pass";
  const durationSeconds = ((Date.now() - startedMilliseconds) / 1000).toFixed(2);
  if (result === "pass") {
    process.stdout.write(`PASS ${profileName} in ${durationSeconds}s\n`);
  } else if (result === "partial") {
    process.stdout.write(`PARTIAL ${profileName}: ${skippedChecks} checks skipped\n`);
  } else {
    process.stdout.write(`SKIP ${profileName}: no checks executed\n`);
  }
  return { result, exitCode: 0, checks };
}

async function createEvidenceContext(taskId) {
  if (!taskId) {
    return null;
  }
  const root = process.cwd();
  const { taskState } = await readStore(root);
  const task = taskState.tasks.find((item) => item.id === taskId);
  if (!task) {
    fail(`Unknown task id: ${taskId}`);
  }
  if (task.status !== "doing") {
    fail(`Cannot create evidence for ${taskId} from status ${task.status}`);
  }
  return {
    root,
    task,
    taskHash: taskFingerprint(task),
    sourceHashBefore: await worktreeFingerprint(root),
    startedAt: new Date().toISOString(),
    startedMilliseconds: Date.now()
  };
}

async function persistProfileEvidence(context, options, outcome) {
  if (!context) {
    return null;
  }
  const finishedAt = new Date().toISOString();
  const id = `${options.taskId}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const commandArgs = [process.execPath, scriptPath, ...process.argv.slice(2)];
  const executedChecks = outcome.checks.filter((check) => check.result !== "skipped").length;
  const skippedChecks = outcome.checks.filter((check) => check.result === "skipped").length;
  const evidence = {
    schemaVersion: 1,
    id,
    taskId: options.taskId,
    kind: "verification-profile",
    profile: options.profile,
    command: formatCommand(commandArgs),
    commandArgs,
    startedAt: context.startedAt,
    finishedAt,
    durationMilliseconds: Date.now() - context.startedMilliseconds,
    exitCode: outcome.exitCode,
    result: outcome.result,
    executedChecks,
    skippedChecks,
    checks: outcome.checks,
    taskHash: context.taskHash,
    sourceHashBefore: context.sourceHashBefore,
    sourceHashAfter: await worktreeFingerprint(context.root),
    ...(outcome.error ? { error: outcome.error } : {})
  };
  await writeEvidence(context.root, evidence);
  process.stdout.write(`Evidence: ${id}\n`);
  return evidence;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.list) {
    process.stdout.write(`${supportedProfiles.join("\n")}\n`);
    return 0;
  }
  if (!supportedProfiles.includes(options.profile)) {
    fail(
      `Unknown verification profile: ${options.profile}. Expected one of: ${supportedProfiles.join(", ")}`,
      2
    );
  }

  const evidenceContext = await createEvidenceContext(options.taskId);
  let outcome;
  try {
    const config = JSON.parse(await readFile(options.configPath, "utf8"));
    validateConfig(config);
    outcome = runProfile(
      config,
      options.profile,
      evidenceContext?.root ?? projectRoot
    );
  } catch (error) {
    outcome = {
      result: "fail",
      exitCode: error.exitCode ?? 1,
      error: `Unable to run verification config at ${options.configPath}: ${error.message}`,
      checks: []
    };
  }

  await persistProfileEvidence(evidenceContext, options, outcome);
  if (outcome.error) {
    process.stderr.write(`${outcome.error}\n`);
  }
  return outcome.exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.exitCode ?? 1;
}
