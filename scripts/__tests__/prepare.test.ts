import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

type GitMarker = "absent" | "directory" | "file";

type PrepareResult = {
  invocationLog: string | null;
  result: SpawnSyncReturns<string>;
};

function runPrepareFixture(
  gitMarker: GitMarker,
  lefthookStatus = 0,
): PrepareResult {
  const testPath = expect.getState().testPath;
  if (!testPath) throw new Error("Vitest did not expose the current test path");
  const root = join(dirname(testPath), "../..");
  const directory = mkdtempSync(join(tmpdir(), "healthlog-prepare-"));
  temporaryDirectories.push(directory);

  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as {
    scripts: { prepare: string };
  };
  const prepareHelper = join(root, "scripts/prepare.mjs");
  if (existsSync(prepareHelper)) {
    mkdirSync(join(directory, "scripts"));
    cpSync(prepareHelper, join(directory, "scripts/prepare.mjs"));
  }

  if (gitMarker === "directory") {
    mkdirSync(join(directory, ".git"));
  } else if (gitMarker === "file") {
    writeFileSync(
      join(directory, ".git"),
      "gitdir: ../shared/.git/worktrees/fixture\n",
    );
  }

  const binDirectory = join(directory, "bin");
  const invocationLog = join(directory, "lefthook.log");
  mkdirSync(binDirectory);
  const lefthook = join(
    binDirectory,
    process.platform === "win32" ? "lefthook.cmd" : "lefthook",
  );
  writeFileSync(
    lefthook,
    process.platform === "win32"
      ? '@echo off\r\necho %*>>"%FIXTURE_LEFTHOOK_LOG%"\r\nexit /b %FIXTURE_LEFTHOOK_STATUS%\r\n'
      : '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FIXTURE_LEFTHOOK_LOG"\nexit "$FIXTURE_LEFTHOOK_STATUS"\n',
  );
  if (process.platform !== "win32") chmodSync(lefthook, 0o755);

  const result = spawnSync(packageJson.scripts.prepare, {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      FIXTURE_LEFTHOOK_LOG: invocationLog,
      FIXTURE_LEFTHOOK_STATUS: String(lefthookStatus),
    },
    shell: true,
  });

  return {
    result,
    invocationLog: existsSync(invocationLog)
      ? readFileSync(invocationLog, "utf8").replaceAll("\r\n", "\n")
      : null,
  };
}

describe("package prepare hook installation", () => {
  it("enables command-shim execution on Windows only", () => {
    const testPath = expect.getState().testPath;
    if (!testPath)
      throw new Error("Vitest did not expose the current test path");
    const source = readFileSync(
      join(dirname(testPath), "../prepare.mjs"),
      "utf8",
    );

    expect(source).toContain('shell: process.platform === "win32"');
  });

  it("skips hook installation only when Git metadata is absent", () => {
    const { invocationLog, result } = runPrepareFixture("absent");

    expect(result.status, result.stderr).toBe(0);
    expect(invocationLog).toBeNull();
  });

  it.each(["directory", "file"] as const)(
    "installs hooks when .git is a %s",
    (gitMarker) => {
      const { invocationLog, result } = runPrepareFixture(gitMarker);

      expect(result.status, result.stderr).toBe(0);
      expect(invocationLog).toBe("install --force\n");
    },
  );

  it.each(["directory", "file"] as const)(
    "propagates Lefthook failure when .git is a %s",
    (gitMarker) => {
      const { invocationLog, result } = runPrepareFixture(gitMarker, 42);

      expect(invocationLog).toBe("install --force\n");
      expect(result.status).toBe(42);
    },
  );
});
