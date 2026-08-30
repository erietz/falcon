import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  clearRegistry,
  cli,
  desc,
  findFalconfile,
  getRegistry,
  loadFalconfile,
  multitask,
  runTask,
  setJobs,
  type TaskContext,
  task,
} from "../src/index.ts";

describe("Falcon Task Runner", () => {
  beforeEach(() => {
    clearRegistry();
    setJobs(Infinity);
  });

  describe("Task Registration & Metadata", () => {
    it("registers simple task without dependencies", () => {
      task("test", () => {});

      const registry = getRegistry();
      assert.ok(registry.has("test"));
      assert.equal(registry.get("test")?.name, "test");
      assert.deepEqual(registry.get("test")?.deps, []);
    });

    it("registers task with description", () => {
      desc("Runs the test suite");
      task("test", () => {});

      const registry = getRegistry();
      assert.equal(registry.get("test")?.desc, "Runs the test suite");
    });

    it("registers task with dependencies", () => {
      task("build", ["clean", "lint"], () => {});

      const registry = getRegistry();
      assert.deepEqual(registry.get("build")?.deps, ["clean", "lint"]);
    });

    it("registers multiple targets with a single function", async () => {
      const calledTargets: string[] = [];
      task(["up", "down", "status"], ({ target }) => {
        calledTargets.push(target);
      });

      const registry = getRegistry();
      assert.ok(registry.has("up"));
      assert.ok(registry.has("down"));
      assert.ok(registry.has("status"));

      await runTask("up");
      await runTask("down");
      assert.deepEqual(calledTargets, ["up", "down"]);
    });

    it("throws error when registering duplicate task name", () => {
      task("dup", () => {});
      assert.throws(() => {
        task("dup", () => {});
      }, /Task with name "dup" is already registered\./);
    });
  });

  describe("Dependency Execution & Automatic Variables", () => {
    it("runs dependencies in sequential order before target task", async () => {
      const order: string[] = [];

      task("clean", () => {
        order.push("clean");
      });
      task("compile", ["clean"], () => {
        order.push("compile");
      });
      task("bundle", ["compile"], () => {
        order.push("bundle");
      });

      await runTask("bundle");
      assert.deepEqual(order, ["clean", "compile", "bundle"]);
    });

    it("provides automatic variables in task context", async () => {
      let receivedCtx: TaskContext | undefined;

      task("dep1", () => {});
      task("dep2", () => {});
      task("target", ["dep1", "dep2"], (ctx) => {
        receivedCtx = ctx;
      });

      await runTask("target");
      assert.ok(receivedCtx);
      assert.equal(receivedCtx.target, "target");
      assert.deepEqual(receivedCtx.deps, ["dep1", "dep2"]);
      assert.equal(receivedCtx.firstDep, "dep1");
    });

    it("memoizes tasks so shared dependencies run only once", async () => {
      let baseCount = 0;

      task("base", () => {
        baseCount++;
      });
      task("stepA", ["base"], () => {});
      task("stepB", ["base"], () => {});
      task("all", ["stepA", "stepB"], () => {});

      await runTask("all");
      assert.equal(baseCount, 1);
    });

    it("detects circular dependencies", async () => {
      task("a", ["b"], () => {});
      task("b", ["c"], () => {});
      task("c", ["a"], () => {});

      await assert.rejects(async () => {
        await runTask("a");
      }, /Circular dependency: a -> b -> c -> a/);
    });
  });

  describe("Parallel Execution (multitask) & Concurrency Limit", () => {
    it("runs dependencies concurrently with multitask", async () => {
      const order: string[] = [];

      task("slow", async () => {
        await new Promise((r) => setTimeout(r, 60));
        order.push("slow");
      });
      task("fast", async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("fast");
      });
      multitask("parallelTarget", ["slow", "fast"], () => {
        order.push("done");
      });

      await runTask("parallelTarget");
      assert.deepEqual(order, ["fast", "slow", "done"]);
    });

    it("limits concurrent tasks with setJobs", async () => {
      setJobs(1);
      let concurrent = 0;
      let maxConcurrent = 0;

      const makeTask = (name: string) => {
        task(name, async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 30));
          concurrent--;
        });
      };

      makeTask("t1");
      makeTask("t2");
      makeTask("t3");
      multitask("all", ["t1", "t2", "t3"], () => {});

      await runTask("all");
      assert.equal(maxConcurrent, 1);
    });
  });

  describe("File Discovery & Loading", () => {
    const testTempDir = join(tmpdir(), `falcon-test-${Date.now()}`);

    beforeEach(() => {
      mkdirSync(testTempDir, { recursive: true });
    });

    it("finds Falconfile walking up directory tree", () => {
      const subDir = join(testTempDir, "a", "b", "c");
      mkdirSync(subDir, { recursive: true });
      const falconfilePath = join(testTempDir, "falconfile.js");
      writeFileSync(falconfilePath, "task('test', () => {});");

      const found = findFalconfile(subDir);
      assert.equal(found, falconfilePath);

      rmSync(testTempDir, { recursive: true, force: true });
    });

    it("throws when explicit file does not exist", () => {
      assert.throws(() => {
        findFalconfile(testTempDir, "nonexistent.js");
      }, /Falconfile not found: nonexistent.js/);

      rmSync(testTempDir, { recursive: true, force: true });
    });

    it("loads Falconfile with global DSL injection", async () => {
      const falconfilePath = join(testTempDir, "Falconfile");
      writeFileSync(
        falconfilePath,
        `
        desc("Global task");
        task("from_global", () => {});
      `,
      );

      await loadFalconfile(falconfilePath);
      const registry = getRegistry();
      assert.ok(registry.has("from_global"));
      assert.equal(registry.get("from_global")?.desc, "Global task");

      rmSync(testTempDir, { recursive: true, force: true });
    });
  });

  describe("CLI Runner", () => {
    it("runs task specified in CLI arguments", async () => {
      let executed = false;
      task("greet", () => {
        executed = true;
      });

      await cli(["greet"]);
      assert.equal(executed, true);
    });

    it("runs default task when no arguments are given", async () => {
      let defaultRun = false;
      task("default", () => {
        defaultRun = true;
      });

      await cli([]);
      assert.equal(defaultRun, true);
    });

    it("runs multiple positional tasks in order", async () => {
      const executed: string[] = [];
      task("one", () => {
        executed.push("one");
      });
      task("two", () => {
        executed.push("two");
      });

      await cli(["one", "two"]);
      assert.deepEqual(executed, ["one", "two"]);
    });

    it("handles help and version flags gracefully", async () => {
      await cli(["--help"]);
      await cli(["--version"]);
    });
  });
});
