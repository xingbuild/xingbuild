# 当前迭代

## 当前唯一版本：`v0.27.4`

父版本：v0.27.3 / `2cb564c81834ac37e6b28e598113ebff00be91e0`

contentImpact: compatible
contentImpactReason: corrective-evidence-gate-and-inventory-fidelity
affectedTargets: []
affectedRoutes: []
affectedFields: []
compatibilityEvidence: v0.27.3-storage-governance-backward-compatible

## 正式方案

[v0.27.4 内容存储治理证据门禁修复方案](../design/v0.27.4%20内容存储治理证据门禁修复方案.md)

## 执行范围

修复 `E74-01`～`E74-07`，逐项通过 `AC74-01`～`AC74-14`：精确制品绑定、真实 acceptance reducer、full inventory/hash、解析引用图、持久/临时物边界和场景证据。保留官网、active ContentSet、当前内容/媒体和审计恢复事实；不物理删除、不改 UI/IA/schema/正文/review/active ContentSet，不运行 content publish 或 product transport。
