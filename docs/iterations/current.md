# 当前迭代

## 当前唯一版本：`v0.27.9`

父版本：v0.27.8 / `707c22c500b50edf30770c41678126a272e4e421`

contentImpact: compatible
contentImpactReason: governance-cli-process-lifecycle
affectedTargets: []
affectedRoutes: []
affectedFields: []
compatibilityEvidence: v0.27.8-product-content-runtime-unchanged

## 正式方案

[v0.27.9 治理 CLI 资源边界与进程生命周期根治方案](../design/v0.27.9%20%E6%B2%BB%E7%90%86%20CLI%20%E8%B5%84%E6%BA%90%E8%BE%B9%E7%95%8C%E4%B8%8E%E8%BF%9B%E7%A8%8B%E7%94%9F%E5%91%BD%E5%91%A8%E6%A0%B9%E6%B2%BB%E6%96%B9%E6%A1%88.md)

## 执行范围

治理 CLI 先分流参数，再按显式模式执行有预算 inventory；建立流式/分阶段算法、取消与孤儿进程收口、最小 failure receipt 和可复现 evidence。保持 ProductArtifact、ContentSet、SitePublication、内容数据平面和 Content/Ops 边界不变；不执行清理或发布。
