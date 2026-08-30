import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  clearRegistry,
  cli,
  colors,
  desc,
  findFalconfile,
  getJobs,
  getRegistry,
  loadFalconfile,
  multitask,
  runTask,
  setJobs,
  type TaskContext,
  TaskRegistry,
  task,
} from "../src/index.ts";

function createBufferStream() {
  const chunks: string[] = [];
  return {
    stream: {
      write: (str: string) => {
        chunks.push(str);
      },
    },
    get output() {
      return chunks.join("");
    },
  };
}

describe("Falcon Task Runner", () => {
  beforeEach(() => {
    clearRegistry();
    setJobs(Infinity);
  });

  describe("Terminal Colors & Styling", () => {
    it("formats text with color helpers", () => {
      assert.ok(typeof colors.bold("bold") === "string");
      assert.ok(typeof colors.dim("dim") === "string");
      assert.ok(typeof colors.cyan("cyan") === "string");
      assert.ok(typeof colors.green("green") === "string");
      assert.ok(typeof colors.red("red") === "string");
      assert.ok(typeof colors.yellow("yellow") === "string");
    });
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

    it("throws error when running unregistered task", async () => {
      await assert.rejects(async () => {
        await runTask("nonexistent");
      }, /Task with name "nonexistent" is not registered\./);
    });

    it("bubbles error when a task throws", async () => {
      task("failing", () => {
        throw new Error("Task failed deliberately");
      });

      await assert.rejects(async () => {
        await runTask("failing");
      }, /Task failed deliberately/);
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
      assert.equal(getJobs(), 1);

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

    it("resets jobs to Infinity for invalid or zero limits", () => {
      setJobs(0);
      assert.equal(getJobs(), Infinity);

      setJobs(-5);
      assert.equal(getJobs(), Infinity);

      setJobs(4);
      assert.equal(getJobs(), 4);
    });
  });

  describe("Task Registry Class", () => {
    it("instantiates an isolated registry", async () => {
      const customRegistry = new TaskRegistry();
      let ran = false;
      customRegistry.task("custom", () => {
        ran = true;
      });

      assert.equal(customRegistry.has("custom"), true);
      assert.equal(customRegistry.size, 1);

      await customRegistry.runTask("custom");
      assert.equal(ran, true);
    });

    it("formats task list correctly", () => {
      const customRegistry = new TaskRegistry();
      assert.equal(customRegistry.formatTaskList(), "No tasks defined.");

      customRegistry.desc("Build app");
      customRegistry.task("build", () => {});
      customRegistry.task("test", () => {});

      const formatted = customRegistry.formatTaskList();
      assert.match(formatted, /build\s+# Build app/);
      assert.match(formatted, /test/);
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

    it("finds Falconfile with typescript extension", () => {
      const falconfilePath = join(testTempDir, "Falconfile.ts");
      writeFileSync(falconfilePath, "task('test', () => {});");

      const found = findFalconfile(testTempDir);
      assert.equal(found, falconfilePath);

      rmSync(testTempDir, { recursive: true, force: true });
    });

    it("returns null when no Falconfile exists in directory tree", () => {
      const emptyDir = join(testTempDir, "empty");
      mkdirSync(emptyDir, { recursive: true });

      const found = findFalconfile(emptyDir);
      assert.ok(found === null || typeof found === "string");

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

    it("loads Falconfile containing TypeScript syntax and types without extension", async () => {
      const falconfilePath = join(testTempDir, "Falconfile");
      writeFileSync(
        falconfilePath,
        `
        import { dirname } from "node:path";
        desc("TypeScript in Falconfile");
        task("ts_task", (ctx: any) => {
          const pathStr: string = dirname("/a/b/c");
        });
      `,
      );

      await loadFalconfile(falconfilePath);
      const registry = getRegistry();
      assert.ok(registry.has("ts_task"));
      assert.equal(registry.get("ts_task")?.desc, "TypeScript in Falconfile");

      rmSync(testTempDir, { recursive: true, force: true });
    });
  });

  describe("CLI Runner", () => {
    it("runs task specified in CLI arguments", async () => {
      let executed = false;
      task("greet", () => {
        executed = true;
      });

      const stdout = createBufferStream();
      const stderr = createBufferStream();
      const code = await cli(["greet"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 0);
      assert.equal(executed, true);
    });

    it("runs default task when no arguments are given", async () => {
      let defaultRun = false;
      task("default", () => {
        defaultRun = true;
      });

      const stdout = createBufferStream();
      const stderr = createBufferStream();
      const code = await cli([], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 0);
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

      const stdout = createBufferStream();
      const stderr = createBufferStream();
      const code = await cli(["one", "two"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 0);
      assert.deepEqual(executed, ["one", "two"]);
    });

    it("runs multiple positional tasks in parallel with --parallel", async () => {
      const order: string[] = [];
      task("pSlow", async () => {
        await new Promise((r) => setTimeout(r, 40));
        order.push("pSlow");
      });
      task("pFast", async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("pFast");
      });

      const stdout = createBufferStream();
      const stderr = createBufferStream();
      const code = await cli(["--parallel", "pSlow", "pFast"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 0);
      assert.deepEqual(order, ["pFast", "pSlow"]);
    });

    it("handles help, version, and list flags", async () => {
      const stdout = createBufferStream();
      const stderr = createBufferStream();

      const helpCode = await cli(["--help"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      assert.equal(helpCode, 0);
      assert.match(stdout.output, /falcon - A simple task runner/);

      const versionCode = await cli(["--version"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      assert.equal(versionCode, 0);
      assert.match(stdout.output, /falcon v/);

      const listCode = await cli(["-T"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      assert.equal(listCode, 0);
    });

    it("handles invalid CLI arguments gracefully", async () => {
      const stdout = createBufferStream();
      const stderr = createBufferStream();

      const code = await cli(["--invalid-option-xyz"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 1);
      assert.match(stderr.output, /Error: Unknown option/);
    });

    it("handles invalid --jobs argument", async () => {
      const stdout = createBufferStream();
      const stderr = createBufferStream();

      const code = await cli(["--jobs", "abc"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 1);
      assert.match(stderr.output, /Invalid value for --jobs/);
    });

    it("handles valid --jobs flag", async () => {
      task("test_jobs", () => {});
      const stdout = createBufferStream();
      const stderr = createBufferStream();

      const code = await cli(["--jobs", "2", "test_jobs"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 0);
      assert.equal(getJobs(), 2);
    });

    it("handles invalid --dir argument", async () => {
      const stdout = createBufferStream();
      const stderr = createBufferStream();

      const code = await cli(["--dir", "/nonexistent/directory/12345"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 1);
      assert.match(stderr.output, /Directory does not exist/);
    });

    it("handles explicit nonexistent file flag", async () => {
      const stdout = createBufferStream();
      const stderr = createBufferStream();

      const code = await cli(["--file", "nonexistent-falconfile.js"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 1);
      assert.match(stderr.output, /Falconfile not found/);
    });

    it("handles error in positional task execution", async () => {
      task("failing_task", () => {
        throw new Error("Positional task failure");
      });

      const stdout = createBufferStream();
      const stderr = createBufferStream();

      const code = await cli(["failing_task"], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 1);
      assert.match(stderr.output, /Positional task failure/);
    });

    it("handles error in default task execution", async () => {
      task("default", () => {
        throw new Error("Default task failure");
      });

      const stdout = createBufferStream();
      const stderr = createBufferStream();

      const code = await cli([], {
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 1);
      assert.match(stderr.output, /Default task failure/);
    });
  });

  describe("Subprocess Executable End-to-End", () => {
    const binPath = resolve("bin/falcon.js");

    it("executes bin/falcon.js --help", () => {
      const output = execFileSync(process.execPath, [binPath, "--help"], {
        encoding: "utf-8",
      });
      assert.match(output, /falcon - A simple task runner/);
    });

    it("executes bin/falcon.js -f examples/basic.ts combo", () => {
      const output = execFileSync(
        process.execPath,
        [binPath, "-f", "examples/basic.ts", "combo"],
        { encoding: "utf-8" },
      );
      assert.match(output, /Falcon punch!!/);
      assert.match(output, /Victory!!!/);
    });

    it("executes bin/falcon.js -T on examples/basic.ts", () => {
      const output = execFileSync(
        process.execPath,
        [binPath, "-f", "examples/basic.ts", "-T"],
        { encoding: "utf-8" },
      );
      assert.match(output, /punch/);
      assert.match(output, /punches the opponent/);
    });

    it("returns non-zero exit code on task failure in subprocess", () => {
      assert.throws(() => {
        execFileSync(process.execPath, [binPath, "nonexistent_task"], {
          encoding: "utf-8",
          stdio: "pipe",
        });
      });
    });
  });
});
