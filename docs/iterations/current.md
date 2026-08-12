# 当前迭代

## 当前唯一版本：`v0.26.19`

父版本：`v0.26.18` / `77a21d61a0a5efc29f7609f1aadbc4805a0f17ff`

## 正式方案

[`docs/design/v0.26.19 发布证据契约与验证闭环方案.md`](../design/v0.26.19%20发布证据契约与验证闭环方案.md)

来源 Incident：v0.26.18 受控 resume 的 phase evidence 聚合与 finalize 契约不一致。

## 根本问题

v0.26.18 已正确拆分 assets/app/media 阶段并通过各阶段验证，但资产生产者返回 `verified=true` 而没有统一 `result=verified`，聚合器把 raw payload 直接放入 phase，finalize 却按另一种 envelope 校验。因此完整证据被错误拒绝。这是共享证据对象模型和端到端闭环缺失，不是媒体、网络或内容问题。

## 本版本目标

1. 用单一 `PublicationPhaseEvidence` v4 envelope 约束 assets/app/media 的生产、聚合、持久化和 finalize。
2. 用唯一 validator/reducer 生成 aggregate，禁止调用方直接拼接 raw phase payload。
3. 用完整正向闭环测试证明 `verify → aggregate → finalize`，并用负向测试覆盖缺字段、缺 phase、schema 混用、identity/CAS drift。
4. 保留 v0.26.18 的 app/media 分离、真实资产 MIME/bytes/hash、recoverable 和同 deployment resume 语义。
5. 只有完整且规范化的 v4 evidence 通过，才允许 finalize；失败继续保持 recoverable/failed，禁止 `propagating + failure`。

## 允许范围

- `scripts/lib/publication-assets.mjs`、`scripts/lib/publication-runtime.mjs`、`scripts/lib/site-publication-coordinator.mjs` 及唯一 publication evidence persistence。
- `publication-runtime-evidence-v4` envelope/validator/aggregate/finalize、现有 v3 只读兼容。
- `tests/v02619-*` 与 runtime/coordinator/assets/release evidence 门禁。
- `VERSION.md`、package、current、design、history（由 Engineering 收口）。

## 明确不做

- 不修改、回写、重试或删除 v0.26.18、v0.26.17、v0.26.16、`dp3ft6f6df8i`、`dp9g7iu2xbai`、旧 SitePublication、ContentSet 或内容事实。
- 不修改 UI、IA、ResponsiveTextSlot、Why、正文、审核、来源、媒体或内容发布工具语义。
- 不创建第二套 resolver、publisher、evidence source；不以 sleep、盲目 retry、手工 JSON 或 finalize 特判代替契约修复。
- 不运行 content publish/ops-content，不直接调用 EdgeOne。

## 产品—内容兼容声明

```yaml
contentImpact: compatible
contentImpactReason: unified-publication-phase-evidence-and-finalize-contract
affectedTargets: [publication-assets, publication-runtime, site-publication-coordinator, publication-evidence]
affectedRoutes: [/, /products, /business-observations, /observations, /about]
affectedFields: []
compatibilityEvidence: v0.26.16-assembled-client-and-contentset-3098040c
```

## 验收标准

- assets/app/media 均由同一 v4 envelope validator 生成，aggregate 只接受三 phase 且 identity 精确一致。
- `verify → aggregate → finalize` 正向测试通过；finalize 不接受 raw/v3 混合或缺 phase evidence。
- 缺 `result`、缺 phase、重复 phase、schema 混用、identity drift、CAS 竞争、失败/中断均在 finalize 前硬失败并保留 recovery evidence。
- v0.26.18 的 app-ready 不误判 lazy media、资产 MIME/bytes/hash、media cancellation、recoverable 和同 deployment resume 回归保持通过。
- `npm run check`、`release:prepare`、targeted v0.26.19 tests、分层 `release:qa`、`release:closeout-check`、exact `release:build`、`release:preflight`、`git diff --check` 全通过。
- 使用现有 v0.26.16 assembled client 做五路由 content-enabled staging；产品/视觉本地验收通过后，才允许在 `dp3ft6f6df8i` 上一次受控 resume。
- 只有同一 deployment 完整公网 v4 assets/app/media evidence 通过并 finalize，才通知 design-ui；此前 content task/ops-content 继续冻结。

## 执行顺序

1. Engineering 实现 v0.26.19，完成 local commit/tag/clean、ProductArtifact/preflight。
2. 产品/视觉独立验收 unified v4 evidence 与现有 content-enabled assembled client。
3. Coordinator 仅在既有 `dp3ft6f6df8i` 上执行一次有界 resume，不新建 deployment。
4. 公网完整 evidence 通过并 finalize 后，design-ui 对同一 deployment 做公网验收。
5. 线上与 design-ui 验收完成后，才解除 content task/ops-content 冻结。
