import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".git")) {
  console.log("Skipping Lefthook install: Git metadata is absent");
} else {
  const result = spawnSync("lefthook", ["install", "--force"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`Failed to run Lefthook: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
