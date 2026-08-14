# 当前迭代

## 当前唯一版本：`v0.27.1`

父版本：v0.27.0 / `2e4c72a1c5bfc04501b758b4c70b30d42d5ecdfe`

contentImpact: compatible
contentImpactReason: content-lifecycle-real-chain-closure
affectedTargets: []
affectedRoutes: []
affectedFields: []
compatibilityEvidence: v0.27.1-content-lifecycle-backward-compatible

## 正式方案

[v0.27.1 内容生命周期真实链路收口方案](../design/v0.27.1%20内容生命周期真实链路收口方案.md)

## 执行范围

收口 `V271-01`～`V271-04`：把 v0.27.0 生命周期模型接入真实 ContentSet/SitePublication 链，修正保守引用分类与版本记录事实。仅做兼容性工程与证据；不改页面、内容事实、active ContentSet、线上状态，不运行 content publish。
