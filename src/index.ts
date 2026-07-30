export type TaskFn = () => void | Promise<void>;

interface Task {
  name: string;
  fn: TaskFn;
  desc: string | undefined;
  deps: string[];
  executed: boolean;
}

const registry: Map<string, Task> = new Map();
let currentDesc: string | undefined;

/**
  * Sets the description for the next task to be registered.
  * @param comment - The description of the task.
  */
export function desc(comment: string): void {
  currentDesc = comment;
}


/**
  * Registers a task with the given name, optional dependencies, and function.
  * @param name - The name of the task.
  * @param depsOrFn - An array of dependency task names or the task function itself.
  * @param fn - The task function (if dependencies are provided).
  */
export function task(name: string, fn: TaskFn): void;
export function task(name: string, deps: string[] | TaskFn, fn?: TaskFn): void;
export function task(name: string, depsOrFn: string[] | TaskFn, fn?: TaskFn): void {
  const deps: string[] = Array.isArray(depsOrFn) ? depsOrFn : [];
  const taskFn: TaskFn = typeof depsOrFn === 'function' ? depsOrFn : typeof fn === 'function' ? fn : () => { };

  if (registry.has(name)) {
    throw new Error(`Task with name "${name}" is already registered.`);
  }

  registry.set(name, {
    name,
    fn: taskFn,
    desc: currentDesc,
    deps,
    executed: false,
  });

  currentDesc = undefined; // Reset the description after registering the task
}

/**
 * Runs the specified task and its dependencies in the correct order. If a task
* has already been executed, it will not be run again.
 * @param name - The name of the task to run.
 */
export async function runTask(name: string): Promise<void> {
  const task = registry.get(name);
  if (!task) {
    throw new Error(`Task with name "${name}" is not registered.`);
  }

  if (task.executed) {
    return;
  }

  for (const dep of task.deps) {
    await runTask(dep);
  }

  await task.fn();
  task.executed = true;
}

/**
 * Lists all registered tasks with their descriptions.
 */
function listTasks(): void {
  console.log('Available tasks:');
  const maxLength = Math.max(...Array.from(registry.keys()).map(name => name.length), 0);
  for (const [name, task] of registry.entries()) {
    const paddedName = name.padEnd(maxLength + 2, ' ');
    console.log(`  ${paddedName} # ${task.desc || ''}`);
  }
}

/**
 * Runs the tasks specified in the command line arguments. If no arguments are
 * provided, it lists all available tasks.
 */
export async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    for (const arg of args) {
      await runTask(arg);
    }
  } else {
    listTasks();
  }
}
