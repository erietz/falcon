import { desc, run, task } from "../dist/index.js";

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
