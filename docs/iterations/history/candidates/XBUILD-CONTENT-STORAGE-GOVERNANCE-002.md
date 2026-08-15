# XBUILD-CONTENT-STORAGE-GOVERNANCE-002｜内容派生存储与保留治理

状态：`converted-to-v0.27.3`
目标版本：`v0.27.3`
正式方案：`docs/design/v0.27.3 内容派生存储保留与清理闭环方案.md`
转换理由：Xing 已授权将候选转为下一版本实施计划；候选内容已完整进入 current/design，原候选不再作为活动候选。

## 原候选目标

保留当前官网、active ContentSet、当前内容/媒体和恢复审计；内容小改不复制未变化内容、媒体或持久 SiteSnapshot；ProductArtifact 独立治理，发布时允许临时组装。

## 原候选功能点

- `SG-01`：锁定 active pointer/ContentSet、ContentSlotRegistry+registryRevision、current+2 logicalContent revision、current draft/review/recovery/incident、当前 SitePublication/ProductArtifact source/dist、receipt/lineage、过渡期 package、canonical content/media 保护根。
- `SG-02`：可重跑 inventory/引用图，包含 root manifest、logicalId/objectKind、namespace、source-of-truth、hash、bytes/count、state、owner、refs、lease、`retainUntil`、restorePath、rebuild proof、decision/reason。
- `SG-03`：输出 `keep/review/archive-dry-run/delete-never` 分类、原因、数量和空间，并区分 durable record/provenance 与 materialization。
- `SG-04`：按 namespace 使用 immutable CAS；hash 不替代 logical identity/provenance/lifecycle；支持旧路径双读与回滚。
- `SG-05`：分离 staging、upload-root、persisted outputRoot；成功记录引用化；失败/recoverable 保留 recovery/evidence。
- `SG-06`：每个 logicalContentId 保留 current+2；draft/review、ProductArtifact、ContentSet、releases、publication、audit/recovery、QA/cache 分层保留。
- `SG-07`：清理执行器校验 lease/进程、外部引用、授权 scope、quarantine、restore、retention；先 dry-run，分批授权后归档/删除。

## 原强制验收范围

`AC-01`～`AC-14` 原样转入正式方案，覆盖保护根、官网基线、inventory、引用图、全扫描零写入、CAS/回滚、current+2、临时/持久物、分层保留、清理安全、changed-only、失败幂等恢复、分流回归和最终审计收口。

## 评审记录

- elon1 第一次评估：候选方向正确，补充保护根、引用图、CAS namespace、临时 outputRoot、current+2 和恢复门禁。
- elon1 第二次 Checklist 复核：主链完整；补充现行 `retainUntil`、root manifest、重复运行 digest、draft/review 保护、成功/失败持久记录分流、全扫描根零写入和 N/A 不得绕过门禁。
- 未执行 inventory、清理、迁移、归档、删除、content publish 或 transport。
