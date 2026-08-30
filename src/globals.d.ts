declare global {
  /**
   * Sets the description for the next task to be registered.
   */
  var desc: (comment: string) => void;

  /**
   * Registers a task with the given name, optional dependencies, and function.
   */
  var task: {
    (name: string | string[], fn: import("./index.js").TaskFn): void;
    (
      name: string | string[],
      deps: string[] | import("./index.js").TaskFn,
      fn?: import("./index.js").TaskFn,
    ): void;
  };

  /**
   * Registers a task whose dependencies run in parallel.
   */
  var multitask: {
    (name: string | string[], fn: import("./index.js").TaskFn): void;
    (
      name: string | string[],
      deps: string[] | import("./index.js").TaskFn,
      fn?: import("./index.js").TaskFn,
    ): void;
  };

  /**
   * Runs the tasks specified in command line arguments.
   */
  var run: () => Promise<void>;
}

export type { TaskContext, TaskFn } from "./index.js";
