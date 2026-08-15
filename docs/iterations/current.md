# 当前迭代

## 当前唯一版本：`v0.27.8`

父版本：v0.27.7 / `8605e54dbc251e3012aa80763def1ef16c1c6d11`

contentImpact: compatible
contentImpactReason: version-neutral-lifecycle-evidence-gates
affectedTargets: []
affectedRoutes: []
affectedFields: []
compatibilityEvidence: v0.27.7-scope-path-backward-compatible

## 正式方案

[v0.27.8 版本无关生命周期 evidence 门禁方案](../design/v0.27.8%20%E7%89%88%E6%9C%AC%E6%97%A0%E5%85%B3%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9Fevidence%20%E9%97%A8%E7%A6%81%E6%96%B9%E6%A1%88.md)

## 执行范围

消除 release gate 对 `v0.27.5` lifecycle evidence 的硬编码：所有 gate 按当前版本解析 evidence，历史 evidence 只读兼容，不写旧版本；保持 v0.27.7 路径 classifier、ProductArtifact、ContentSet、SitePublication 与 Content/Ops 边界不变。
