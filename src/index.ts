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

/**
 * Registry holding task definitions and handling dependency resolution,
 * concurrency limiting, and execution.
 */
export class TaskRegistry {
  private tasks = new Map<string, Task>();
  private currentDesc: string | undefined;
  private jobs: number;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor() {
    const parsed = Number(process.env.FALCON_JOBS);
    this.jobs =
      Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Infinity;
  }

  get size(): number {
    return this.tasks.size;
  }

  has(name: string): boolean {
    return this.tasks.has(name);
  }

  get(name: string): Task | undefined {
    return this.tasks.get(name);
  }

  entries(): IterableIterator<[string, Task]> {
    return this.tasks.entries();
  }

  keys(): IterableIterator<string> {
    return this.tasks.keys();
  }

  desc(comment: string): void {
    this.currentDesc = comment;
  }

  task(
    name: string | string[],
    depsOrFn: string[] | TaskFn,
    fn?: TaskFn,
  ): void {
    this.define(name, depsOrFn, fn, false);
  }

  multitask(
    name: string | string[],
    depsOrFn: string[] | TaskFn,
    fn?: TaskFn,
  ): void {
    this.define(name, depsOrFn, fn, true);
  }

  private define(
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
      if (this.tasks.has(target)) {
        throw new Error(`Task with name "${target}" is already registered.`);
      }

      this.tasks.set(target, {
        name: target,
        fn: taskFn,
        desc: this.currentDesc,
        deps,
        parallel,
        promise: undefined,
      });
    }

    this.currentDesc = undefined;
  }

  setJobs(limit: number): void {
    this.jobs =
      Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
  }

  getJobs(): number {
    return this.jobs;
  }

  clear(): void {
    this.tasks.clear();
    this.currentDesc = undefined;
    this.active = 0;
    this.waiting.length = 0;
  }

  private async withSlot(fn: () => void | Promise<void>): Promise<void> {
    while (this.active >= this.jobs) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  async runTask(name: string, path: string[] = []): Promise<void> {
    const targetTask = this.tasks.get(name);
    if (!targetTask) {
      throw new Error(`Task with name "${name}" is not registered.`);
    }

    if (path.includes(name)) {
      throw new Error(`Circular dependency: ${[...path, name].join(" -> ")}`);
    }

    if (!targetTask.promise) {
      targetTask.promise = this.execute(targetTask, [...path, name]);
    }

    return targetTask.promise;
  }

  private async execute(targetTask: Task, path: string[]): Promise<void> {
    if (targetTask.parallel) {
      await Promise.all(targetTask.deps.map((dep) => this.runTask(dep, path)));
    } else {
      for (const dep of targetTask.deps) {
        await this.runTask(dep, path);
      }
    }

    await this.withSlot(() =>
      targetTask.fn({
        target: targetTask.name,
        deps: targetTask.deps,
        firstDep: targetTask.deps[0],
      }),
    );
  }

  formatTaskList(): string {
    if (this.tasks.size === 0) {
      return "No tasks defined.";
    }

    const lines: string[] = ["Available tasks:"];
    const maxLength = Math.max(
      ...Array.from(this.tasks.keys()).map((name) => name.length),
      0,
    );

    for (const [name, targetTask] of this.tasks.entries()) {
      const paddedName = name.padEnd(maxLength + 2, " ");
      const descStr = targetTask.desc ? `# ${targetTask.desc}` : "";
      lines.push(`  ${paddedName}${descStr}`);
    }

    return lines.join("\n");
  }
}

export const defaultRegistry = new TaskRegistry();

/**
 * Sets the description for the next task to be registered.
 */
export function desc(comment: string): void {
  defaultRegistry.desc(comment);
}

/**
 * Registers a task with the given name, optional dependencies, and function.
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
  defaultRegistry.task(name, depsOrFn, fn);
}

/**
 * Registers a task whose dependencies run in parallel.
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
  defaultRegistry.multitask(name, depsOrFn, fn);
}

/**
 * Runs the specified task on the default registry.
 */
export function runTask(name: string): Promise<void> {
  return defaultRegistry.runTask(name);
}

/**
 * Sets concurrency limit on the default registry.
 */
export function setJobs(limit: number): void {
  defaultRegistry.setJobs(limit);
}

/**
 * Returns concurrency limit on the default registry.
 */
export function getJobs(): number {
  return defaultRegistry.getJobs();
}

/**
 * Clears the default registry.
 */
export function clearRegistry(): void {
  defaultRegistry.clear();
}

/**
 * Returns a copy of default task registry map.
 */
export function getRegistry(): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const [k, v] of defaultRegistry.entries()) {
    map.set(k, v);
  }
  return map;
}

/**
 * Injects DSL functions into globalThis so Falconfiles can run without explicit imports.
 */
export function injectGlobals(registry: TaskRegistry = defaultRegistry): void {
  const g = globalThis as Record<string, unknown>;
  g.task = (
    name: string | string[],
    depsOrFn: string[] | TaskFn,
    fn?: TaskFn,
  ) => registry.task(name, depsOrFn, fn);
  g.desc = (comment: string) => registry.desc(comment);
  g.multitask = (
    name: string | string[],
    depsOrFn: string[] | TaskFn,
    fn?: TaskFn,
  ) => registry.multitask(name, depsOrFn, fn);
  g.run = () => run();
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

let loadingCount = 0;

export function isLoadingFalconfile(): boolean {
  return loadingCount > 0;
}

/**
 * Loads a Falconfile, injecting globals and executing via dynamic import or vm.
 */
export async function loadFalconfile(
  filePath: string,
  registry: TaskRegistry = defaultRegistry,
): Promise<void> {
  injectGlobals(registry);
  const resolvedPath = resolve(filePath);
  const ext = extname(resolvedPath).toLowerCase();

  loadingCount++;
  try {
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
  } finally {
    loadingCount--;
  }
}

/**
 * Prints all registered tasks to console.
 */
export function listTasks(registry: TaskRegistry = defaultRegistry): void {
  console.log(registry.formatTaskList());
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

export function getHelpText(): string {
  return `
falcon - A simple task runner. Zero dependencies.

Usage:
  falcon [options] [task...]

Options:
  -T, -l, --list        List all available tasks
  -f, --file <file>     Use specified Falconfile
  -j, --jobs <n>        Limit number of parallel jobs (default: unlimited)
  -C, --dir <dir>       Change directory before searching for Falconfile
      --parallel        Run target tasks in parallel
  -v, --version         Show version number
  -h, --help            Show this help message`;
}

export interface CliOptions {
  stdout?: { write: (str: string) => void };
  stderr?: { write: (str: string) => void };
  cwd?: string;
  registry?: TaskRegistry;
}

/**
 * Parses CLI arguments, discovers and loads the Falconfile, and runs requested tasks.
 * Returns an exit code (0 for success, 1 for error).
 */
export async function cli(
  args: string[] = process.argv.slice(2),
  io: CliOptions = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const registry = io.registry ?? defaultRegistry;

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
    stderr.write(`Error: ${message}\nRun 'falcon --help' for usage.\n`);
    return 1;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    stdout.write(`${getHelpText()}\n`);
    return 0;
  }

  if (values.version) {
    stdout.write(`falcon v${getPackageVersion()}\n`);
    return 0;
  }

  const workingDir = values.dir ? resolve(cwd, values.dir) : cwd;
  if (values.dir && !existsSync(workingDir)) {
    stderr.write(`Error: Directory does not exist: ${values.dir}\n`);
    return 1;
  }

  if (values.jobs !== undefined) {
    const parsedJobs = Number(values.jobs);
    if (!Number.isFinite(parsedJobs) || parsedJobs < 1) {
      stderr.write(
        `Error: Invalid value for --jobs: "${values.jobs}". Must be a positive integer.\n`,
      );
      return 1;
    }
    registry.setJobs(parsedJobs);
  }

  if (values.file || registry.size === 0) {
    let falconfilePath: string | null = null;
    try {
      falconfilePath = findFalconfile(workingDir, values.file);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      stderr.write(`Error: ${message}\n`);
      return 1;
    }

    if (!falconfilePath) {
      stderr.write(
        "Error: No Falconfile found in current or parent directories.\n",
      );
      return 1;
    }

    try {
      await loadFalconfile(falconfilePath, registry);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.stack || err.message : String(err);
      stderr.write(`Error loading ${falconfilePath}:\n${message}\n`);
      return 1;
    }
  }

  if (values.list || values["list-alt"]) {
    stdout.write(`${registry.formatTaskList()}\n`);
    return 0;
  }

  if (positionals.length > 0) {
    try {
      if (values.parallel) {
        await Promise.all(
          positionals.map((target) => registry.runTask(target)),
        );
      } else {
        for (const target of positionals) {
          await registry.runTask(target);
        }
      }
      return 0;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      stderr.write(`Error: ${message}\n`);
      return 1;
    }
  }

  if (registry.has("default")) {
    try {
      await registry.runTask("default");
      return 0;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      stderr.write(`Error: ${message}\n`);
      return 1;
    }
  }

  stdout.write(`${registry.formatTaskList()}\n`);
  return 0;
}

/**
 * Runs tasks specified in process.argv, or delegates to cli().
 */
export async function run(): Promise<void> {
  if (isLoadingFalconfile()) {
    return;
  }
  const exitCode = await cli();
  if (exitCode !== 0 && typeof process !== "undefined") {
    process.exitCode = exitCode;
  }
}
