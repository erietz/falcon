// multitask runs a task's dependencies at once instead of one after another.
// Swap it back to task and the same three drills run in order.
//
// Set FALCON_JOBS to cap how many task functions run at a time, like make -j.

import { setTimeout as sleep } from "node:timers/promises";
import { task, multitask, desc, run } from "../dist/index.js";

const start = Date.now();
const log = (msg: string) =>
  console.log(`${String(Date.now() - start).padStart(5)}ms  ${msg}`);

desc("laces up before any drill");
task("warmup", async () => {
  await sleep(100);
  log("warmed up");
});

// All three drills depend on warmup. It still runs once, and all three wait on
// that single run.

desc("drills jabs");
task("jabs", ["warmup"], async ({ target }) => {
  await sleep(300);
  log(`${target} done`);
});

desc("drills kicks");
task("kicks", ["warmup"], async ({ target }) => {
  await sleep(200);
  log(`${target} done`);
});

desc("drills punches");
task("punches", ["warmup"], async ({ target }) => {
  await sleep(400);
  log(`${target} done`);
});

desc("runs every drill at once");
multitask("training", ["jabs", "kicks", "punches"], ({ deps }) => {
  log(`${deps.length} drills complete`);
});

run();
