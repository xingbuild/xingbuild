export const expectedOrigin = "https://github.com/Chizheng4/xingbuild.git";
export const FORBIDDEN_VERSION_STATE_FIELDS = ["localSubmission", "productVisualAcceptance", "publishAuthorization", "onlineRelease"];

export function assertNoVersionStateFields(currentText = "") {
  const found = FORBIDDEN_VERSION_STATE_FIELDS.filter((field) => new RegExp(`^${field}:`, "m").test(currentText));
  if (found.length) throw new Error(`current.md must not store lifecycle state fields: ${found.join(", ")}`);
}

export function parseCurrentIterationVersion(currentIteration = "") {
  return currentIteration.match(/## 当前(?:唯一|目标)版本[：:]?\s*(?:\n\s*)?`(v\d+\.\d+\.\d+)`/)?.[1];
}

function normalizedEntries(statusEntries = []) {
  return statusEntries.filter(Boolean).map((entry) => String(entry));
}

export function evaluateProductReleaseReadiness({
  branch,
  statusEntries,
  packageVersion,
  versionRecord,
  currentVersion,
  headTag,
  origin,
  allowReleaseWorktree = false,
  scopeResult = null,
}) {
  const version = `v${packageVersion}`;
  const blockers = [];
  const changes = normalizedEntries(statusEntries);

  if (branch !== "main" && !allowReleaseWorktree) blockers.push(`当前分支是 ${branch || "无"}，应为 main。`);
  if (!scopeResult && changes.length) blockers.push(`工作区仍有 ${changes.length} 项未提交修改。`);
  if (scopeResult && !scopeResult.ready) blockers.push(...scopeResult.blockers);
  if (versionRecord !== version) {
    blockers.push(`VERSION.md 最新版本为 ${versionRecord || "无"}，应为 ${version}。`);
  }
  if (currentVersion !== version) {
    blockers.push(`当前迭代目标为 ${currentVersion || "无"}，应为 ${version}。`);
  }
  if (headTag !== version) {
    blockers.push(`HEAD 标签为 ${headTag || "无"}，应为 ${version}。`);
  }
  if (origin !== expectedOrigin) blockers.push("origin 不是预期的 xingbuild GitHub 仓库。");

  return { ready: blockers.length === 0, version, blockers };
}

export function evaluateCloseoutReadiness({
  branch,
  unstagedEntries,
  untrackedEntries,
  stagedEntries,
  packageVersion,
  versionRecord,
  currentVersion,
  allowReleaseWorktree = false,
  scopeResult = null,
}) {
  const version = `v${packageVersion}`;
  const blockers = [];
  const unstaged = normalizedEntries(unstagedEntries);
  const untracked = normalizedEntries(untrackedEntries);
  const staged = normalizedEntries(stagedEntries);

  if (branch !== "main" && !allowReleaseWorktree) blockers.push(`当前分支是 ${branch || "无"}，应为 main。`);
  if (!scopeResult) {
    if (!staged.length) blockers.push("没有暂存本轮版本变更。");
    if (unstaged.length) blockers.push(`仍有 ${unstaged.length} 项未暂存修改。`);
    if (untracked.length) blockers.push(`仍有 ${untracked.length} 项未追踪文件。`);
  } else if (!scopeResult.ready) {
    blockers.push(...scopeResult.blockers);
  }
  if (versionRecord !== version) {
    blockers.push(`VERSION.md 最新版本为 ${versionRecord || "无"}，应为 ${version}。`);
  }
  if (currentVersion !== version) {
    blockers.push(`当前迭代目标为 ${currentVersion || "无"}，应为 ${version}。`);
  }

  return { ready: blockers.length === 0, version, blockers };
}
