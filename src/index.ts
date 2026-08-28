import { parseArgs } from "node:util";

const options = {
  parallel: {
    type: "boolean",
    default: false,
    short: "j",
  },
} as const;

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

interface Task {
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

const registry: Map<string, Task> = new Map();
let currentDesc: string | undefined;

/**
 * The most task functions to run at once, from `FALCON_JOBS`, like make's `-j`.
 * Anything unparseable or non-positive means no limit.
 */
const jobs: number = (() => {
  const parsed = Number(process.env.FALCON_JOBS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Infinity;
})();
let active = 0;
const waiting: (() => void)[] = [];

/**
 * Runs one task function, waiting for a free job slot first. Only the function
 * itself holds a slot: a task that held one while awaiting its dependencies
 * would deadlock at `FALCON_JOBS=1`, since those dependencies need slots too.
 */
async function withSlot(fn: () => void | Promise<void>): Promise<void> {
  // Waiting in a loop, not an if: a woken task rechecks in case another one
  // took the slot first, rather than pushing the count past the limit.
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

  currentDesc = undefined; // Reset the description after registering the task
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
  const task = registry.get(name);
  if (!task) {
    throw new Error(`Task with name "${name}" is not registered.`);
  }

  if (path.includes(name)) {
    throw new Error(`Circular dependency: ${[...path, name].join(" -> ")}`);
  }

  if (!task.promise) {
    task.promise = execute(task, [...path, name]);
  }

  return task.promise;
}

async function execute(task: Task, path: string[]): Promise<void> {
  if (task.parallel) {
    await Promise.all(task.deps.map((dep) => runTask(dep, path)));
  } else {
    for (const dep of task.deps) {
      await runTask(dep, path);
    }
  }

  await withSlot(() =>
    task.fn({
      target: task.name,
      deps: task.deps,
      firstDep: task.deps[0],
    }),
  );
}

/**
 * Lists all registered tasks with their descriptions.
 */
function listTasks(): void {
  console.log("Available tasks:");
  const maxLength = Math.max(
    ...Array.from(registry.keys()).map((name) => name.length),
    0,
  );
  for (const [name, task] of registry.entries()) {
    const paddedName = name.padEnd(maxLength + 2, " ");
    console.log(`  ${paddedName} # ${task.desc || ""}`);
  }
}

/**
 * Runs the tasks specified in the command line arguments. If no arguments are
 * provided, it lists all available tasks.
 */
export async function run(): Promise<void> {
  const { values, positionals } = parseArgs({
    options,
    allowPositionals: true,
  });

  if (positionals.length > 0) {
    if (values.parallel) {
      await Promise.all(positionals.map((p) => runTask(p)));
    } else {
      for (const p of positionals) {
        await runTask(p);
      }
    }
  } else {
    listTasks();
  }
}
