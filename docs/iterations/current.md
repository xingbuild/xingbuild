# 当前迭代

## 当前唯一版本：`v0.27.3`

父版本：v0.27.2 / `ae0befadc177e049380795c948109ddd31d7c13d`

contentImpact: compatible
contentImpactReason: derived-storage-retention-and-cleanup-governance
affectedTargets: []
affectedRoutes: []
affectedFields: []
compatibilityEvidence: v0.27.3-storage-governance-backward-compatible

## 正式方案

[v0.27.3 内容派生存储保留与清理闭环方案](../design/v0.27.3%20内容派生存储保留与清理闭环方案.md)

## 执行范围

实现 `SG-01`～`SG-07`，逐项通过 `AC-01`～`AC-14`：保护根、可重跑 inventory/引用图、namespace CAS、临时/持久物分离、分层保留、quarantine/restore/清理门禁与失败恢复。保留官网、active ContentSet、当前内容/媒体和审计恢复事实；不自动删除，不改 UI/IA/schema/正文/review/active ContentSet，不运行 content publish 或 product transport。
