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

## API

That's it. Three functions:

- `desc(text)`: description for the next task
- `task(name, [deps], fn)`: register a task
- `run()`:  run the tasks named in `process.argv`, or list them all

## Notes

Running `.ts` files directly needs Node 22.18+ or 24+ (native type stripping).
Older versions work too just compile first, or use `tsx`.
