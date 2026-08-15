import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitPaths } from "../scripts/lib/release-scope-classifier.mjs";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

test("commitPaths reads raw UTF-8 paths for spaces, quotes, delete and rename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0277-paths-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "scope@test.invalid"]);
  git(root, ["config", "user.name", "Scope Test"]);
  const names = ["中文 文件.txt", "quote\"file.txt", "space name.txt", "delete.txt", "rename.txt"];
  for (const name of names) await writeFile(path.join(root, name), "before\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "base"]);
  await writeFile(path.join(root, names[0]), "after\n");
  await writeFile(path.join(root, names[1]), "after\n");
  await writeFile(path.join(root, names[2]), "after\n");
  git(root, ["rm", "delete.txt"]);
  git(root, ["mv", "rename.txt", "重命名 文件.txt"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "path identities"]);
  const paths = commitPaths(root, git(root, ["rev-parse", "HEAD"]));
  assert.equal(paths.has("中文 文件.txt"), true);
  assert.equal(paths.has("quote\"file.txt"), true);
  assert.equal(paths.has("space name.txt"), true);
  assert.equal(paths.has("delete.txt"), true);
  assert.equal(paths.has("rename.txt"), true);
  assert.equal(paths.has("重命名 文件.txt"), true);
});
