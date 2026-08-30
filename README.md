<p align="center">
  <img src="assets/banner.png" alt="Falcon" width="400">
</p>

<h1 align="center">falcon</h1>

<p align="center">A simple task runner for TypeScript and JavaScript. Zero dependencies.</p>

## Install

```sh
npm install falcon
```

Or install globally / run directly via `npx`:

```sh
npx falcon --help
```

---

## Quick Start

Create a `Falconfile` (or `Falconfile.ts`, `falconfile.js`, etc.) in your project root:

```ts
// Falconfile.ts
desc("punches the opponent");
task("punch", async () => {
  console.log("Falcon punch!!");
});

desc("kicks the opponent");
task("kick", async () => {
  console.log("Falcon kick!!");
});

desc("left jabs opponent");
task("leftjab", async () => {
  console.log("Left jab!");
});

desc("right jabs opponent");
task("rightjab", async () => {
  console.log("Right jab!");
});

desc("performs a combo attack");
task("combo", ["leftjab", "rightjab", "punch", "kick"], async () => {
  console.log("Victory!!!");
});

// Default task alias
task("default", ["combo"]);
```

> **Zero Boilerplate**: Global functions `task`, `desc`, `multitask`, and `run` are injected automatically. You don't even need `import` statements! (Explicit imports via `import { task, desc } from "falcon"` are also supported).

### CLI Usage

List the tasks:

```sh
$ falcon -T
Available tasks:
  punch      # punches the opponent
  kick       # kicks the opponent
  leftjab    # left jabs opponent
  rightjab   # right jabs opponent
  combo      # performs a combo attack
  default    # 
```

Run a task:

```sh
$ falcon combo
Left jab!
Right jab!
Falcon punch!!
Falcon kick!!
Victory!!!
```

Run multiple tasks in sequence:

```sh
$ falcon leftjab rightjab
Left jab!
Right jab!
```

Dependencies run first, in order, and each task runs at most once.

---

## CLI Options

```
Usage: falcon [options] [task...]

Options:
  -T, -l, --list        List all available tasks with descriptions
  -f, --file <file>     Use specified Falconfile
  -j, --jobs <n>        Limit number of parallel jobs (default: unlimited)
  -C, --dir <dir>       Change directory before searching for Falconfile
      --parallel        Run target positional tasks in parallel
  -v, --version         Show version number
  -h, --help            Show this help message
```

---

## File Discovery & Resolution Order

When invoked without `-f`, `falcon` searches the current directory and walks up parent directories until it finds:

1. `Falconfile`
2. `falconfile`
3. `Falconfile.ts` / `falconfile.ts`
4. `Falconfile.js` / `falconfile.js`
5. `Falconfile.mjs` / `falconfile.mjs`
6. `Falconfile.cjs` / `falconfile.cjs`
7. `falcon.ts` / `falcon.js`

---

## Standalone Script Execution

You can also run task files directly with Node:

```ts
// examples/basic.ts
import { task, desc, run } from "falcon";

desc("punches the opponent");
task("punch", async () => {
  console.log("Falcon punch!!");
});

run();
```

```sh
$ node examples/basic.ts punch
Falcon punch!!
```

---

## Multiple targets

Pass an array of names to define them all with one function, the way a Makefile rule can list several targets. Each name is still its own task, and each one gets its own name back as `target`, like make's `$@`:

```ts
// examples/dbmate.ts
import { execFileSync } from "node:child_process";
import { task, desc, run } from "falcon";

const DBS = (process.env.DB ?? "core analytics").split(/\s+/);
const ENV = process.env.ENV ?? "dev";

desc("runs the matching dbmate command against every database");
task(["up", "down", "status", "create", "drop", "load"], ({ target }) => {
  for (const db of DBS) {
    console.log(`==> ${db}`);
    execFileSync("dbmate", [
      "--env-file", `.env.${ENV}`,
      "--no-dump-schema",
      "-d", `migrations/${db}`,
      "-s", `schema/${db}.sql`,
      target,
    ], { stdio: "inherit" });
  }
});

run();
```

```sh
$ ENV=prod falcon -f examples/dbmate.ts status
==> core
[X] 20260115202511_create_users.sql
==> analytics
[X] 20260228141002_create_events.sql

$ falcon -f examples/dbmate.ts drop create up
```

The same Makefile rule needs a shell loop, `$$db` escaping, line continuations and `|| exit 1`. Here a thrown error stops the loop and the run, so later targets are skipped.

---

## Automatic variables

Every task function receives one context object, holding the make automatic variables that mean something without file targets:

| field | make | value |
| --- | --- | --- |
| `target` | `$@` | the name of the task being run |
| `deps` | `$^` | its dependencies, in order, without duplicates |
| `firstDep` | `$<` | the first dependency, or `undefined` |

```ts
task("release", ["build", "test", "publish"], ({ target, deps, firstDep }) => {
  console.log(`${target} ran ${deps.length} deps, starting with ${firstDep}`);
});
```

Ignore the argument and nothing changes, so `() => {}` is still a task.

---

## Parallel dependencies

`multitask` takes the same arguments as `task` but starts its dependencies all at once instead of one after another, the way rake's `multitask` does:

```ts
// examples/parallel.ts
desc("laces up before any drill");
task("warmup", async () => { await sleep(100); log("warmed up"); });

desc("drills jabs");
task("jabs", ["warmup"], async ({ target }) => { await sleep(300); log(`${target} done`); });
// ...kicks (200ms) and punches (400ms), both also depending on warmup

desc("runs every drill at once");
multitask("training", ["jabs", "kicks", "punches"], ({ deps }) => {
  log(`${deps.length} drills complete`);
});
```

```sh
$ falcon -f examples/parallel.ts training
  101ms  warmed up
  306ms  kicks done
  407ms  jabs done
  505ms  punches done
  506ms  3 drills complete
```

The drills overlap, so the run takes as long as the slowest one instead of the sum of all three. Only `training`'s own dependencies overlap: each drill still runs its own dependencies in order unless it is a `multitask` too. Swap `multitask` back to `task` and the same three drills go one at a time.

Tasks still run at most once, however many dependents ask for them at the same time. All three drills depend on `warmup`, so it runs once and all three wait on that single run.

A dependency cycle raises `Circular dependency: a -> b -> c -> a`, naming the path, rather than hanging.

Tasks named on the command line always run in order, so `falcon drop create up` runs sequentially. Pass `--parallel` to run positional CLI targets concurrently: `falcon --parallel test build`.

### Limiting jobs

`FALCON_JOBS` or `-j` / `--jobs` caps how many task functions run at once, like make's `-j`:

```sh
$ falcon -f examples/parallel.ts -j 1 training
  102ms  warmed up
  407ms  jabs done
  610ms  kicks done
 1013ms  punches done
 1014ms  3 drills complete
```

Leave it unset for no limit. The cap counts task functions only, so a task never holds a slot while waiting on its dependencies.

---

## API

The Falcon engine provides:

- `desc(text)`: description for the next task
- `task(name, [deps], fn)`: register a task, where `name` is one name or an array of them, and `fn` receives `{ target, deps, firstDep }`
- `multitask(name, [deps], fn)`: the same, but the dependencies run in parallel
- `run()`: run the tasks named in `process.argv` (or list them all if none given)
- `cli(args)`: CLI argument parser and task runner
- `findFalconfile(startDir, file)`: locates Falconfile candidate up directory tree
- `loadFalconfile(filePath)`: loads Falconfile and injects global DSL
- `runTask(name)`: programmatically run a registered task and its dependencies
- `setJobs(limit)` / `getJobs()`: control task concurrency limit
- `clearRegistry()`: resets task registry

---

## Notes

- Running `.ts` files directly uses Node 22.18+ or 24+ native type stripping.
- A failed dependency stops the run, but siblings already underway are not cancelled since JavaScript execution is non-preemptive. They finish, and then the error surfaces.
- Tasks running concurrently write to stdout as output is produced.
