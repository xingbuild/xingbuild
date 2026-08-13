# XBUILD-HISTORICAL-DERIVED-ARTIFACT-CLEANUP-001｜历史派生物引用盘点与可恢复清理

候选 ID：`XBUILD-HISTORICAL-DERIVED-ARTIFACT-CLEANUP-001`
类型：治理/Engineering 候选
状态：`pending`
executionAuthorization：`pending`
责任：`elon` 确认保留级别与窗口；`elon engin` 只读盘点、生成 dry-run；获得明确授权后再执行可恢复归档或删除。

## 1. 目的

降低项目中历史过程截图、浏览器运行目录、重复 assembled snapshot 和重复构建产物造成的认知与磁盘负担，同时绝不误删当前线上、恢复链、审核链或可审计证据。

本候选只解决“哪些派生物可以被识别、引用、归档或回收”的治理问题；不是立即删除命令，也不修改当前产品版本、内容事实或发布状态。

## 2. 根本边界

```text
canonical source / active facts / recovery evidence
    → 保留，除非独立迁移方案证明可重建且获授权

session ephemeral / unreferenced derived copy
    → 先证明 owner、无 lease、无引用、可重建，再做 dry-run
```

目录名、文件时间或“看起来是旧截图”不能作为删除依据。必须建立 `path → owner → object identity → hash → references → retainUntil → action` 的 machine-readable inventory。

## 3. 初步分类（仅候选，不是执行结论）

### 3.1 可能可直接清理：仍需自动门禁

- 已结束 preview session 的 lease、PID 记录、browser profile、临时缓存和临时截图；条件是进程不存在、lease 已释放、无当前 task 引用、可由 canonical source 重建。
- 同一 source/hash 且不被 active ContentSet、receipt、lineage、SitePublication、recovery 或 incident 引用的重复派生副本。
- 已被新证据替代、且不属于已登记 QA/Incident 保留范围的临时测试输出。

这类对象只能先 dry-run，再在显式授权下执行可恢复移动到归档区；禁止直接 `rm -rf` 或按目录通配删除。

### 3.2 必须 Xing 确认后才可处理

- `.content-workspace/qa/**` 历史 PNG/JPG、`evidence.json`、`axe-evidence.json`、`interactive.json` 和报告；它们可能是视觉验收、回归、Incident 证据。
- `.content-workspace/qa-browser-runtime/**` 的 run summary、trace、profile/db 等运行记录；需区分最小摘要与可重建缓存。
- `.content-workspace/site-publications/**` 的正式、失败、传播、publicVerify、recovery 记录。
- `.content-workspace/releases/**` 的 source/dist/site-publication/revision/completion 派生物。
- `.content-workspace/base-site-artifacts/**` 的版本构建与发布证明。

处理前必须保留最小 machine-readable summary、hash、来源版本、引用关系和归档位置；不能因为“线上已经正常”就删除失败或恢复证据。

### 3.3 不能删除

- canonical `.content-workspace/content/**`、active ContentSet 及 `active.json/previous` 指针。
- `content-slot-registry`、PublicationLineageBinding、active/released receipt 所指 package、未决或可恢复 `recoveries/**`、失败 SitePublication/PublicationRun/Incident evidence。
- Git tags/history、`current.md`、`VERSION` 和已发布版本事实。
- approved media manifest 所引用的媒体原件与仍被 active 内容使用的资源。

## 4. 必须先完成的只读工作

1. 统计每个候选目录的 bytes/files，并按对象类型拆分 session/QA/release/publication/artifact。
2. 解析 active ContentSet、receipt、registry、lineage、SitePublication、recovery 和 Incident 的引用图。
3. 对重复文件计算 hash，区分同 hash 副本与不同内容的历史证据。
4. 输出 `keep / review / archive-dry-run / delete-never` 四类清单及每项理由。
5. 提供可恢复 dry-run：只生成计划，不移动、不删除、不改 ignored 生命周期文件。

## 5. 非目标

- 不在 v0.26.22 或任何产品版本内执行清理。
- 不修改或迁移 ContentSet、内容正文、review/recovery、SitePublication、ProductArtifact 或线上部署。
- 不把“当前 + 前两个内容历史”的数据模型带入本候选；该方向继续由 `XBUILD-CONTENT-DATA-LIFECYCLE-001` 独立评审。
- 不清理未知 owner、外部 owner 文件或其他 task 的工作区。

## 6. 验收条件

- inventory 可从 canonical source 重跑，包含 path/owner/hash/reference/decision。
- dry-run 对所有 `keep/review` 对象零写入；扫描前后 active/release/recovery/publication/registry 快照一致。
- 可清理对象均有显式无 lease、无引用、可重建证据，并提供恢复路径。
- Xing 明确保留期限、归档位置、失败/Incident 证据政策和删除授权后，Engineering 才能执行下一步。

## 7. 当前状态与下一动作

当前仅登记候选，不读取聊天内容代替正式证据，不执行删除。下一步先由 `elon` 确认保留级别与窗口；再由 `elon engin` 做只读 inventory/dry-run；若出现数据模型迁移需求，转交既有 `XBUILD-CONTENT-DATA-LIFECYCLE-001`，不在此候选中顺手实现。
