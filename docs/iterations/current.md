# 当前迭代

## 当前唯一版本：`v0.27.2`

父版本：v0.27.1 / `cbf832d48ea2483c911f3cd494486a627caf7068`

contentImpact: compatible
contentImpactReason: lifecycle-single-model-and-atomic-change-closure
affectedTargets: []
affectedRoutes: []
affectedFields: []
compatibilityEvidence: v0.27.2-content-lifecycle-backward-compatible

## 正式方案

[v0.27.2 生命周期单一模型与原子变更方案](../design/v0.27.2%20生命周期单一模型与原子变更方案.md)

## 执行范围

收口 `V272-01`～`V272-05`：统一 snapshot 真源、原子 Candidate/ChangeSet、真实 sourceHash、无变化复用和 durable record 硬边界。仅做兼容性工程与证据；不改页面、内容事实、active ContentSet、线上状态，不运行 content publish。
