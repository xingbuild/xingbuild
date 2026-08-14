# 当前迭代

## 当前唯一版本：`v0.27.0`

父版本：v0.26.32 / `50643e6ea1edac080759e292d30b447aff64b293`

contentImpact: compatible
contentImpactReason: content-lifecycle-and-derived-artifact-governance
affectedTargets: []
affectedRoutes: []
affectedFields: []
compatibilityEvidence: v0.27.0-content-lifecycle-backward-compatible

## 正式方案

[v0.27.0 内容生命周期、变更复用与派生物治理方案](../design/v0.27.0%20内容生命周期、变更复用与派生物治理方案.md)

## 执行范围

完成 `DL-01`～`DL-04`、`CL-01`～`CL-04`，并 record-only 收口活动 task hostId 核验。`CL-05`（保留窗口与物理清理）不进入本版本，需 Xing 单独授权。仅做生命周期/ref 复用、引用 inventory、保留分类和可恢复 dry-run；不改页面、内容事实、active ContentSet、线上状态，不运行 content publish。
