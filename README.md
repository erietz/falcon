<p align="center">
  <img src="assets/banner.png" alt="Falcon" width="400">
</p>

<h1 align="center">falcon</h1>

<p align="center">A simple task runner for TypeScript. Zero dependencies.</p>

## Install

```sh
npm install falcon
```

## Use

Write a task file:

```ts
// examples/basic.ts
import { task, desc, run } from "falcon";

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

run();
```

List the tasks:

```sh
$ node examples/basic.ts
Available tasks:
  punch      # punches the opponent
  kick       # kicks the opponent
  leftjab    # left jabs opponent
  rightjab   # right jabs opponent
  combo      # performs a combo attack
```

Run one:

```sh
$ node examples/basic.ts combo
Left jab!
Right jab!
Falcon punch!!
Falcon kick!!
Victory!!!
```

Dependencies run first, in order, and each task runs at most once.

## Multiple targets

Pass an array of names to define them all with one function, the way a Makefile
rule can list several targets. Each name is still its own task, and each one
gets its own name back as `target`, like make's `$@`:

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
$ ENV=prod node examples/dbmate.ts status
==> core
[X] 20260115202511_create_users.sql
==> analytics
[X] 20260228141002_create_events.sql

$ node examples/dbmate.ts drop create up
```

The same Makefile rule needs a shell loop, `$$db` escaping, line continuations
and `|| exit 1`. Here a thrown error stops the loop and the run, so later
targets are skipped.

## Automatic variables

Every task function receives one context object, holding the make automatic
variables that mean something without file targets:

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

## API

That's it. Three functions:

- `desc(text)`: description for the next task
- `task(name, [deps], fn)`: register a task, where `name` is one name or an
  array of them, and `fn` receives `{ target, deps, firstDep }`
- `run()`:  run the tasks named in `process.argv`, or list them all

## Notes

Running `.ts` files directly needs Node 22.18+ or 24+ (native type stripping).
Older versions work too just compile first, or use `tsx`.
