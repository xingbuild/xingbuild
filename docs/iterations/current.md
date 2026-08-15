# 当前迭代

## 当前唯一版本：`v0.27.6`

父版本：v0.27.5 / `b28e597066d79fb3f14e13d7b463cf9248c862d8`

contentImpact: compatible
contentImpactReason: release-scope-classifier-and-gate-consistency
affectedTargets: []
affectedRoutes: []
affectedFields: []
compatibilityEvidence: v0.27.5-lifecycle-evidence-backward-compatible

## 正式方案

[v0.27.6 Git范围分类与发布门禁统一方案](../design/v0.27.6%20Git%E8%8C%83%E5%9B%B4%E5%88%86%E7%B1%BB%E4%B8%8E%E5%8F%91%E5%B8%83%E9%97%A8%E7%A6%81%E7%BB%9F%E4%B8%80%E6%96%B9%E6%A1%88.md)

## 执行范围

实现唯一 release scope classifier：将本次全部 tracked 变更分为 `implementation`、`record-only`、`excludedExternal`、`unclassified`，让已确认的实现与项目记录在同一 commit/tag 收口，同时保持 ProductArtifact 只消费 implementation。统一接入 closeout、release-build、preflight、unified-publish；保留 annotated tag/HEAD/ProductArtifact 门禁和 Content/Ops 独立边界；不改 UI/IA/schema/正文/review/active ContentSet，不执行物理清理，不运行 content publish。
