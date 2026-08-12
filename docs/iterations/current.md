# 当前迭代

## 当前唯一版本：`v0.26.17`

父版本：`v0.26.16` / `4d6198360cf045bb075751788ea4f0370299d215`

## 正式方案

[`docs/design/v0.26.17 公网运行时验证状态机与恢复闭环方案.md`](../design/v0.26.17%20公网运行时验证状态机与恢复闭环方案.md)

来源 Incident：`CONTENT-PUBLICATION-STATIC-ASSET-ROUTING-WHITE-SCREEN-001`；后续恢复暴露公网 runtime verify timeout/state observability gap。

## 根本问题

v0.26.16 已修复静态资产上传源、MIME、hash、HTML fallback 与基础浏览器挂载门禁，但同一 SitePublication/deployment resume 时，Coordinator 仍把 `networkidle2` 和统一请求失败作为页面完成语义，缺少按阶段/按路由 evidence、可观测进度和中断后的 recoverable 状态。公网页面已经可用时，控制面仍可能长时间无输出并停留在 `propagating + publicVerify=null`，无法安全 finalize。

## 本版本目标

1. 以 DOM/app-ready 替代 network-idle 作为 SPA 页面就绪合同；资产、应用、媒体分阶段验证。
2. 对脚本/样式真实失败、媒体真实失败、媒体取消、console/pageerror、浏览器环境错误进行可解释分类。
3. 持久化按 attempt/phase/route 的 machine-readable evidence 和进度，禁止黑盒等待。
4. timeout、SIGINT、浏览器异常原子进入 `recoverable`，带 failure code/phase/lastEvidence；同一 publication/deployment resume 幂等，不重复部署。
5. 只有完整 evidence identity 与 SitePublication 一致才允许 atomic finalize；不改变内容和页面事实。

## 允许范围

- `scripts/lib/publication-runtime.mjs`、`scripts/lib/qa-browser-runtime.mjs`、`scripts/lib/site-publication-coordinator.mjs`、`scripts/verify-public-release.mjs` 与相关测试。
- Publication evidence envelope、阶段状态、timeout/interruption/recoverable/resume/finalize 合同。
- 复用既有 v0.26.16 SitePublication/deployment 和当前 active ContentSet 做受控恢复；不新建 deployment。

## 明确不做

- 不回写、重试、修改或删除 v0.26.16、`dp3ft6f6df8i`、`dp9g7iu2xbai`、旧 SitePublication、ContentSet、正文、审核、来源、媒体、tag/history。
- 不修改 UI、IA、页面组件、ResponsiveTextSlot、Why、内容 schema 或视觉合同。
- 不把增加等待、sleep、盲目 retry 或手工改状态当作修复；不创建第二套发布器、浏览器 resolver 或 evidence 事实源。
- 不运行 content publish；content task/ops-content 继续冻结，直到产品公网恢复并完成 design-ui 验收。

## 产品—内容兼容声明

```yaml
contentImpact: compatible
contentImpactReason: runtime-verification-state-machine-and-recoverable-observability
affectedTargets: [site-publication-coordinator, public-verify, publication-runtime, publication-evidence]
affectedRoutes: [/, /products, /business-observations, /observations, /about]
affectedFields: []
compatibilityEvidence: v02616-content-enabled-five-route-runtime-and-existing-contentset-identity
```

## 验收标准

- content-enabled staging 五路由在有界时间内完成 app-ready，不依赖 networkidle2；每个 route/phase 有开始、结束、结果和错误证据。
- 真实 JS/CSS/媒体失败、console/pageerror、DOM 未挂载硬失败；已就绪媒体的页面关闭取消不误报为损坏。
- timeout/SIGINT/浏览器异常均记录 `state=recoverable`、`failure.code`、`failure.phase`、`lastEvidence`，不留下 `propagating + publicVerify=null` 的不明状态。
- 同一 SitePublication/deployment resume 不重复 EdgeOne deployment；成功 finalize 只发生一次，active ContentSet 不变。
- `check`、`release:prepare`、runtime/coordinator targeted QA、分层 `release:qa`、`release:closeout-check`、exact `release:build`、`release:preflight`、`git diff --check` 全通过。
- 产品/视觉本地治理验收、公网完整 evidence 和 design-ui 同 deployment 验收均通过后，才解除 content task 冻结。

## 执行顺序

1. Engineering 实现 v0.26.17 并完成 local commit/tag/clean、ProductArtifact/preflight。
2. 产品/视觉独立验收验证语义与 content-enabled staging evidence。
3. Coordinator 仅复用既有 v0.26.16 SitePublication/deployment 执行一次有界 resume；不新建 deployment。
4. 公网 evidence 全部通过并 finalize 后，design-ui 对同一 deployment 做公网验收。
5. 产品公网恢复完成后，才解除 content task 冻结。
