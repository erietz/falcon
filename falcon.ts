import { task, run } from "./src/index.ts";
import { execFileSync } from "node:child_process";

function sh(cmd: string, args: string[] = [], env: Record<string, string> = {}) {
  try {
    execFileSync(cmd, args, {
      env: { ...process.env, ...env },
      stdio: "inherit",
      encoding: "utf-8",
    });
  } catch (error) {
    process.exit(1);
  }
}

task("version", () => {
  const versionChangeTypes = ["major", "minor", "patch"];
  const versionChangeType = process.env.V || "";
  if (!versionChangeTypes.includes(versionChangeType)) {
    console.error(
      `Invalid version change type: V=${versionChangeType}. Must be one of: ${versionChangeTypes.join(
        ", "
      )}`
    );
    process.exit(1);
  }

  sh("npm", ["version", versionChangeType, "-m", `Release v%s`]);
  sh("git", ["push", "origin", "main", "--follow-tags"]);

});

task("publish", () => {
  sh("npm", ["publish", "--access", "public"]);
});

run();
