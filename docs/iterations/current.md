# 当前迭代

## 当前唯一版本：`v0.28.0`

父版本：v0.27.9 / `7374b75a7a611217cfa0199e2d81ec7964dc3386`

contentImpact: breaking
contentImpactReason: content-data-plane-runtime-and-content-only-publication
affectedTargets: [home, products, business-observations, observations, about]
affectedRoutes: [/, /products, /business-observations, /observations, /about]
affectedFields: [contentDataArtifact, activeTuple, runtimeContentManifest, contentOnlyPublication]
compatibilityEvidence: requires-v0.28.0-content-migration-and-runtime-evidence

## 正式方案

[v0.28.0 内容数据平面与内容增量发布架构方案](../design/v0.28.0%20%E5%86%85%E5%AE%B9%E6%95%B0%E6%8D%AE%E5%B9%B3%E9%9D%A2%E4%B8%8E%E5%86%85%E5%AE%B9%E5%A2%9E%E9%87%8F%E5%8F%91%E5%B8%83%E6%9E%B6%E6%9E%84%E6%96%B9%E6%A1%88.md)

## 执行范围

实现 ContentDataArtifact、运行时内容读取、CAS/changed-only 复用、原子 active tuple、内容-only 增量发布、临时 materialization、最小 receipt、失败回退和 SA-00..SA-11 验收。保持 ContentSet/Ops 身份边界；不在本版本执行物理清理、迁移、transport 或 content publish。
