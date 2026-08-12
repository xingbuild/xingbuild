# 当前迭代

## 当前唯一版本：`v0.26.18`

父版本：`v0.26.17` / `734c71ca5fcdf0e9a11b259d70816c93db397b8d`

## 正式方案

[`docs/design/v0.26.18 发布运行时媒体阶段与原子恢复方案.md`](../design/v0.26.18%20发布运行时媒体阶段与原子恢复方案.md)

来源 Incident：v0.26.17 受控 resume 的媒体阶段误判与中断状态覆盖。

## 根本问题

v0.26.17 已将 `networkidle2` 替换为 app-ready，并增加了 evidence 与 recoverable 记录，但仍把路由挂载和媒体 readyState 放在同一 route 检查中。页面 `root/main/h1` 已正常时，懒加载视频的 `readyState=0` 被误判为失败；同时 `onEvidence` 的 recoverable 写入会被传播观察回调覆盖成 `state=propagating`，导致 `phase=recoverable`、`failure` 与顶层 state 不一致。

## 本版本目标

1. 将 app-ready、媒体资产和可选浏览器媒体探针拆成独立阶段；路由挂载不再要求视频 readyState。
2. 让 content manifest 中的媒体路径进入统一 asset manifest，公网验证 status/MIME/非 HTML/bytes/hash。
3. 由唯一 Coordinator state reducer 原子写入顶层状态；evidence/observation 只能追加证据，不能互相覆盖状态。
4. timeout、SIGINT、SIGTERM、browser error 和 media timeout 均收口为 `recoverable`；任何 failure 存在时禁止顶层 `propagating`。
5. 同一 v0.26.16 SitePublication/deployment 可从一致 checkpoint 幂等恢复，不新建 deployment；verified identity/evidence 才能 finalize。

## 允许范围

- `scripts/lib/publication-runtime.mjs`、`scripts/lib/publication-assets.mjs`、SitePublication asset manifest 组装、`scripts/lib/site-publication-coordinator.mjs` 与相关测试/evidence。
- `publication-runtime-evidence-v3` phase/route/media envelope、原子 transition、timeout/interruption/recoverable/resume/finalize 合同。
- 复用既有 v0.26.16 SitePublication/deployment `dp3ft6f6df8i` 与 active ContentSet 做后续一次受控恢复。

## 明确不做

- 不回写、重试、修改或删除 v0.26.17、v0.26.16、`dp3ft6f6df8i`、`dp9g7iu2xbai`、旧 SitePublication、ContentSet、正文、审核、来源、媒体、tag/history。
- 不修改 UI、IA、页面组件、ResponsiveTextSlot、Why、内容 schema 或视觉合同。
- 不把增加等待、sleep、盲目 retry 或手工改状态当作修复；不创建第二套发布器、浏览器 resolver 或 evidence 事实源。
- 不运行 content publish/ops-content；内容 task 继续冻结，直到产品公网恢复并完成 design-ui 验收。

## 产品—内容兼容声明

```yaml
contentImpact: compatible
contentImpactReason: separate-media-readiness-and-atomic-publication-state
affectedTargets: [publication-runtime, publication-assets, site-publication-coordinator, publication-evidence]
affectedRoutes: [/, /products, /business-observations, /observations, /about]
affectedFields: []
compatibilityEvidence: existing-v02616-content-enabled-assembled-client-and-contentset-identity
```

## 验收标准

- app-ready 在有界时间内完成，不使用 `networkidle2`；懒加载 `readyState=0` 不误判。
- JS/CSS/console/pageerror、HTML fallback、真实媒体 MIME/hash 错误分别有明确失败分类；媒体取消不冒充应用失败。
- 每个 phase/route/media 都有开始、结束、结果和 lastEvidence；v3 evidence 可恢复读取。
- SIGINT、SIGTERM、route timeout、media timeout 后顶层必为 `recoverable`，不得出现 `propagating + failure` 或未知 `propagating + publicVerify=null`。
- 同一 SitePublication/deployment resume 不重复 EdgeOne deployment；finalize 只接受完整且 identity 精确一致的 evidence。
- `npm run check`、`release:prepare`、targeted runtime/coordinator/assets tests、分层 `release:qa`、`release:closeout-check`、exact `release:build`、`release:preflight`、`git diff --check` 全通过。
- 产品/视觉本地验收、公网完整 evidence 和 design-ui 同 deployment 验收均通过后，才解除 content task 冻结。

## 执行顺序

1. Engineering 实现 v0.26.18，完成 local commit/tag/clean、ProductArtifact/preflight。
2. 产品/视觉独立验收既有 content-enabled assembled client 与 runtime evidence。
3. Coordinator 仅在既有 `dp3ft6f6df8i` 上执行一次有界 resume，不新建 deployment。
4. 公网资产、app、媒体 evidence 完整通过并 finalize 后，design-ui 对同一 deployment 做公网验收。
5. 产品公网恢复完成后，才解除 content task/ops-content 冻结。
