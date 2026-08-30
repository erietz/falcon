import { task, run } from "./src/index.ts";
import { execFileSync } from "node:child_process";

function sh(cmd: string, args: string[] = [], env: Record<string, string> = {}) {
  execFileSync(cmd, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
    encoding: "utf-8",
  });
}

task("version", () => {
  const versionChangeTypes = ["major", "minor", "patch"];
  const versionChangeType = process.env.V || "";
  if (!versionChangeTypes.includes(versionChangeType)) {
    throw new Error(
      `Invalid version change type: V=${versionChangeType}. Must be one of: ${versionChangeTypes.join(
        ", "
      )}`
    );
  }

  sh("npm", ["version", versionChangeType, "-m", `Release v%s`]);
  sh("git", ["push", "origin", "main", "--follow-tags"]);

});

task("publish", () => {
  sh("npm", ["publish", "--access", "public"]);
});

run();
