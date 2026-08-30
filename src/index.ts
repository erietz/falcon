import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import vm from "node:vm";

const isColorSupported =
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR !== undefined || Boolean(process.stdout?.isTTY));

export const colors = {
  bold: (s: string) => (isColorSupported ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isColorSupported ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: (s: string) => (isColorSupported ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s: string) => (isColorSupported ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isColorSupported ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isColorSupported ? `\x1b[33m${s}\x1b[0m` : s),
};

export const FALCONFILE_CANDIDATES = [
  "Falconfile",
  "falconfile",
  "Falconfile.ts",
  "falconfile.ts",
  "Falconfile.js",
  "falconfile.js",
  "Falconfile.mjs",
  "falconfile.mjs",
  "Falconfile.cjs",
  "falconfile.cjs",
  "falcon.ts",
  "falcon.js",
  "falcon.mjs",
  "falcon.cjs",
] as const;

/**
 * The automatic variables make provides inside a recipe, passed to every task
 * function.
 */
export interface TaskContext {
  /** make's `$@`: the name of the task being run. */
  target: string;
  /** make's `$^`: this task's dependencies, in order, without duplicates. */
  deps: string[];
  /** make's `$<`: the first dependency, or undefined if there are none. */
  firstDep: string | undefined;
}

export type TaskFn = (ctx: TaskContext) => void | Promise<void>;

export interface Task {
  name: string;
  fn: TaskFn;
  desc: string | undefined;
  deps: string[];
  parallel: boolean;
  /**
   * The run of this task, memoized so that a task shared by several dependents
   * runs once and every dependent awaits the same run.
   */
  promise: Promise<void> | undefined;
}

const g = globalThis as Record<string, unknown>;

if (!g.__FALCON_REGISTRY__) {
  g.__FALCON_REGISTRY__ = new Map<string, Task>();
}
const registry = g.__FALCON_REGISTRY__ as Map<string, Task>;
let currentDesc: string | undefined;

/**
 * The most task functions to run at once, from `FALCON_JOBS`, like make's `-j`.
 * Anything unparseable or non-positive means no limit.
 */
let jobs: number = (() => {
  const parsed = Number(process.env.FALCON_JOBS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Infinity;
})();
let active = 0;
const waiting: (() => void)[] = [];

/**
 * Sets the concurrency limit for task function execution.
 */
export function setJobs(limit: number): void {
  jobs = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
}

/**
 * Returns current concurrency limit.
 */
export function getJobs(): number {
  return jobs;
}

/**
 * Returns the task registry map.
 */
export function getRegistry(): Map<string, Task> {
  return registry;
}

/**
 * Clears all registered tasks and resets state (useful for tests).
 */
export function clearRegistry(): void {
  registry.clear();
  currentDesc = undefined;
  active = 0;
  waiting.length = 0;
}

/**
 * Runs one task function, waiting for a free job slot first. Only the function
 * itself holds a slot: a task that held one while awaiting its dependencies
 * would deadlock at `FALCON_JOBS=1`, since those dependencies need slots too.
 */
async function withSlot(fn: () => void | Promise<void>): Promise<void> {
  while (active >= jobs) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/**
 * Sets the description for the next task to be registered.
 * @param comment - The description of the task.
 */
export function desc(comment: string): void {
  currentDesc = comment;
}

/**
 * Registers a task with the given name, optional dependencies, and function.
 * Passing several names registers the same dependencies and function under
 * each one, like a make rule with multiple targets. Each name is then its own
 * task, and receives its own name as `ctx.target`.
 * @param name - The name of the task, or several names sharing one function.
 * @param depsOrFn - An array of dependency task names or the task function itself.
 * @param fn - The task function (if dependencies are provided).
 */
export function task(name: string | string[], fn: TaskFn): void;
export function task(
  name: string | string[],
  deps: string[] | TaskFn,
  fn?: TaskFn,
): void;
export function task(
  name: string | string[],
  depsOrFn: string[] | TaskFn,
  fn?: TaskFn,
): void {
  define(name, depsOrFn, fn, false);
}

/**
 * Registers a task whose dependencies run in parallel instead of in order,
 * like rake's `multitask`. Takes the same arguments as {@link task}. Only this
 * task's own dependencies overlap; each of them still runs its own
 * dependencies in order unless it is a multitask too.
 * @param name - The name of the task, or several names sharing one function.
 * @param depsOrFn - An array of dependency task names or the task function itself.
 * @param fn - The task function (if dependencies are provided).
 */
export function multitask(name: string | string[], fn: TaskFn): void;
export function multitask(
  name: string | string[],
  deps: string[] | TaskFn,
  fn?: TaskFn,
): void;
export function multitask(
  name: string | string[],
  depsOrFn: string[] | TaskFn,
  fn?: TaskFn,
): void {
  define(name, depsOrFn, fn, true);
}

function define(
  name: string | string[],
  depsOrFn: string[] | TaskFn,
  fn: TaskFn | undefined,
  parallel: boolean,
): void {
  const rawDeps: string[] = Array.isArray(depsOrFn) ? depsOrFn : [];
  const deps: string[] = Array.from(new Set(rawDeps));
  const taskFn: TaskFn =
    typeof depsOrFn === "function"
      ? depsOrFn
      : typeof fn === "function"
        ? fn
        : () => {};

  for (const target of Array.isArray(name) ? name : [name]) {
    if (registry.has(target)) {
      throw new Error(`Task with name "${target}" is already registered.`);
    }

    registry.set(target, {
      name: target,
      fn: taskFn,
      desc: currentDesc,
      deps,
      parallel,
      promise: undefined,
    });
  }

  currentDesc = undefined;
}

/**
 * Injects DSL functions into globalThis so Falconfiles can run without explicit imports.
 */
export function injectGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  g.task = task;
  g.desc = desc;
  g.multitask = multitask;
  g.run = run;
}

/**
 * Searches for a Falconfile starting at startDir and walking up parent directories.
 */
export function findFalconfile(
  startDir: string = process.cwd(),
  explicitFile?: string,
): string | null {
  if (explicitFile) {
    const resolved = resolve(startDir, explicitFile);
    if (existsSync(resolved)) {
      return resolved;
    }
    throw new Error(`Falconfile not found: ${explicitFile}`);
  }

  let current = resolve(startDir);
  while (true) {
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      // Continue if directory cannot be read
    }

    for (const candidateName of FALCONFILE_CANDIDATES) {
      if (entries.includes(candidateName)) {
        const candidatePath = join(current, candidateName);
        try {
          if (statSync(candidatePath).isFile()) {
            return candidatePath;
          }
        } catch {
          // Continue if unreadable
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * Loads a Falconfile, injecting globals and executing via dynamic import or vm.
 */
export async function loadFalconfile(filePath: string): Promise<void> {
  injectGlobals();
  const resolvedPath = resolve(filePath);
  const ext = extname(resolvedPath).toLowerCase();

  if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts") {
    const fileUrl = pathToFileURL(resolvedPath).href;
    await import(fileUrl);
  } else {
    const content = readFileSync(resolvedPath, "utf-8");
    try {
      vm.runInThisContext(content, {
        filename: resolvedPath,
      });
    } catch {
      const dataUrl = `data:text/javascript;base64,${Buffer.from(content).toString("base64")}`;
      await import(dataUrl);
    }
  }
}

/**
 * Runs the specified task and its dependencies in the correct order. If a task
 * has already been executed, it will not be run again.
 * @param name - The name of the task to run.
 * @param path - The chain of tasks depended upon to reach this one, used to
 * report circular dependencies. Callers should leave it empty.
 */
export async function runTask(
  name: string,
  path: string[] = [],
): Promise<void> {
  const targetTask = registry.get(name);
  if (!targetTask) {
    throw new Error(`Task with name "${name}" is not registered.`);
  }

  if (path.includes(name)) {
    throw new Error(`Circular dependency: ${[...path, name].join(" -> ")}`);
  }

  if (!targetTask.promise) {
    targetTask.promise = execute(targetTask, [...path, name]);
  }

  return targetTask.promise;
}

async function execute(targetTask: Task, path: string[]): Promise<void> {
  if (targetTask.parallel) {
    await Promise.all(targetTask.deps.map((dep) => runTask(dep, path)));
  } else {
    for (const dep of targetTask.deps) {
      await runTask(dep, path);
    }
  }

  await withSlot(() =>
    targetTask.fn({
      target: targetTask.name,
      deps: targetTask.deps,
      firstDep: targetTask.deps[0],
    }),
  );
}

/**
 * Lists all registered tasks with their descriptions.
 */
export function listTasks(): void {
  if (registry.size === 0) {
    console.log("No tasks defined.");
    return;
  }

  console.log("Available tasks:");
  const maxLength = Math.max(
    ...Array.from(registry.keys()).map((name) => name.length),
    0,
  );
  for (const [name, targetTask] of registry.entries()) {
    const paddedName = name.padEnd(maxLength + 2, " ");
    const descStr = targetTask.desc ? `# ${targetTask.desc}` : "";
    console.log(`  ${colors.cyan(paddedName)}${colors.dim(descStr)}`);
  }
}

function getPackageVersion(): string {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function printHelp(): void {
  console.log(`
${colors.bold("falcon")} - A simple task runner. Zero dependencies.

${colors.bold("Usage:")}
  falcon [options] [task...]

${colors.bold("Options:")}
  -T, -l, --list        List all available tasks
  -f, --file <file>     Use specified Falconfile
  -j, --jobs <n>        Limit number of parallel jobs (default: unlimited)
  -C, --dir <dir>       Change directory before searching for Falconfile
      --parallel        Run target tasks in parallel
  -v, --version         Show version number
  -h, --help            Show this help message
`);
}

/**
 * Parses CLI arguments, discovers and loads the Falconfile, and runs requested tasks.
 */
export async function cli(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  g.__FALCON_CLI__ = true;

  const options = {
    list: {
      type: "boolean",
      short: "T",
      default: false,
    },
    "list-alt": {
      type: "boolean",
      short: "l",
      default: false,
    },
    file: {
      type: "string",
      short: "f",
    },
    jobs: {
      type: "string",
      short: "j",
    },
    dir: {
      type: "string",
      short: "C",
    },
    parallel: {
      type: "boolean",
      default: false,
    },
    version: {
      type: "boolean",
      short: "v",
      default: false,
    },
    help: {
      type: "boolean",
      short: "h",
      default: false,
    },
  } as const;

  let parsed: ReturnType<
    typeof parseArgs<{ options: typeof options; allowPositionals: true }>
  >;
  try {
    parsed = parseArgs({
      args,
      options,
      allowPositionals: true,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(colors.red(`Error: ${message}`));
    console.error("Run 'falcon --help' for usage.");
    process.exitCode = 1;
    return;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    printHelp();
    return;
  }

  if (values.version) {
    console.log(`falcon v${getPackageVersion()}`);
    return;
  }

  if (values.dir) {
    try {
      process.chdir(values.dir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        colors.red(
          `Error: Cannot change directory to '${values.dir}': ${message}`,
        ),
      );
      process.exitCode = 1;
      return;
    }
  }

  if (values.jobs !== undefined) {
    const parsedJobs = Number(values.jobs);
    if (!Number.isFinite(parsedJobs) || parsedJobs < 1) {
      console.error(
        colors.red(
          `Error: Invalid value for --jobs: "${values.jobs}". Must be a positive integer.`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    setJobs(parsedJobs);
  }

  // Load Falconfile if not already loaded or if a custom file is specified
  if (values.file || registry.size === 0) {
    let falconfilePath: string | null = null;
    try {
      falconfilePath = findFalconfile(process.cwd(), values.file);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(colors.red(`Error: ${message}`));
      process.exitCode = 1;
      return;
    }

    if (!falconfilePath) {
      console.error(
        colors.red(
          "Error: No Falconfile found in current or parent directories.",
        ),
      );
      process.exitCode = 1;
      return;
    }

    try {
      await loadFalconfile(falconfilePath);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.stack || err.message : String(err);
      console.error(colors.red(`Error loading ${falconfilePath}:`));
      console.error(message);
      process.exitCode = 1;
      return;
    }
  }

  if (values.list || values["list-alt"]) {
    listTasks();
    return;
  }

  if (positionals.length > 0) {
    try {
      if (values.parallel) {
        await Promise.all(positionals.map((target) => runTask(target)));
      } else {
        for (const target of positionals) {
          await runTask(target);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(colors.red(`Error: ${message}`));
      process.exitCode = 1;
    }
  } else {
    if (registry.has("default")) {
      try {
        await runTask("default");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(colors.red(`Error: ${message}`));
        process.exitCode = 1;
      }
    } else {
      listTasks();
    }
  }
}

/**
 * Runs tasks specified in process.argv, or delegates to cli().
 */
export async function run(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (g.__FALCON_CLI__) {
    return;
  }
  await cli();
}
