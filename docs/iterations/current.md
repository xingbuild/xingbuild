# 当前迭代

## 当前唯一版本：`v0.27.5`

父版本：v0.27.4 / `b3ceb325f9be96bd3cb617f05ec66d6da8cf3551`

contentImpact: compatible
contentImpactReason: lifecycle-evidence-contract-and-stage-aware-gate
affectedTargets: []
affectedRoutes: []
affectedFields: []
compatibilityEvidence: v0.27.4-storage-governance-backward-compatible

## 正式方案

[v0.27.5 内容生命周期证据与发布门禁纠偏方案](../design/v0.27.5%20内容生命周期证据与发布门禁纠偏方案.md)

## 执行范围

修复 `E-01`～`E-06`，逐项通过 `C-01`～`C-10`：两阶段身份、真实 run/provenance、changed-only/add/no-change、atomic failure、same-publication resume/rollback、deterministic rebuild、current+2/retention、完整 inventory/reference graph 和 stage-aware validator。复用 v0.27.0～v0.27.3 生命周期逻辑；保留官网、active ContentSet、当前内容/媒体和审计恢复事实；不物理删除、不改 UI/IA/schema/正文/review/active ContentSet，不运行 content publish 或 product transport。
