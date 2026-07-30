// One rule, many targets, like a Makefile. Each task name is passed back to
// the function as ctx.target and used as the dbmate subcommand.
//
// Needs dbmate on PATH, plus migrations/<db>/ and schema/<db>.sql for each
// database in DB.

import { execFileSync } from "node:child_process";
import { task, desc, run } from "../dist/index.js";

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
