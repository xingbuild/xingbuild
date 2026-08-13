# 当前迭代

## 当前唯一版本：`v0.26.21`

父版本：v0.26.20 / 3ee065faa1ef3c847e221743052e686cd2e5525b

## 正式方案

[docs/design/v0.26.21 精准内容预览与局部刷新闭环方案.md](../design/v0.26.21%20精准内容预览与局部刷新闭环方案.md)

## 用户目标

1. 修改一个内容 target 后，本地立即显示它在全部真实消费页面中的 Web/Mobile 结果。
2. 不刷新无关页面，不构建、不生成 ContentSet/ProductArtifact、不触碰线上状态。
3. 首页定位和 Robotaxi 说明等已有内容能力均可使用同一预览工具，不建立页面专用预览。

## 正式对象

- `ContentTarget`：现有 registry 中的可编辑字段事实。
- `TargetImpact`：该 target 的完整 consumer routes 与 Web/Mobile views。
- `ContentPreviewSession`：一次聚焦一个 target 的本地 4317 会话。
- `TargetEditEvent`：`valid`、`invalid` 或 `outside-selected-target` 的 dev-only 精准刷新事件。

## 允许范围

- 修正现有 target registry 的真实 `projectionRoutes`，并验证 route/page contentRef 一致性；
- ContentPreviewSession 的完整 TargetImpact、字段 hash、revision 和错误状态；
- Vite dev-only custom event 与受影响 iframe 精准刷新；
- source edit→affected views reload→restore、invalid/recovery、零写入和清理测试；
- v0.26.21 VERSION/package/current/design/history。

## 明确不做

- 不调用 elon ui 做全站视觉验收；
- 不修改正式网站 UI/IA/视觉、组件、tokens 或文案；
- 不新增 consumer registry、内容 schema、CMS、第二套 renderer/content source/publisher；
- 不使用 `full-reload path=*`；
- 不自动复制 active/release/recovery 内容；
- 不修改 active/review/recovery/release/SitePublication；
- 不运行 content publish、product transport 或 EdgeOne；
- 不创建 branch/worktree/task/automation。

## 刷新合同

```text
selected target value changed + valid
→ refresh only target consumer routes × Web/Mobile

same source but selected target unchanged
→ outside-selected-target + no refresh

invalid JSON/slot
→ show error + keep last valid rendered state
```

`products.robotaxi.intro` 的真实 consumer 为 `/` 与 `/products`；Products-only Why 只影响 `/products`；Home positioning 只影响 `/`。

## Home source readiness

elon ops 将 active ContentSet 已核验的 `homeContent` 原样物化为 `.content-workspace/content/home.json`，并证明 adapter/hash 与 active home entry 一致。Engineering 不生成或猜测内容源。

## 验收

- `products.robotaxi.intro` 只生成 `/` 与 `/products` 的 Web1280/Mobile390 views；
- 选中 target 改动只刷新上述 views，无关 route revision 不变；
- 非选中字段改动不刷新并显示明确状态；
- invalid→修复状态闭环，页面不接受无效值；
- `site.home.homeTitle` 可预览且只刷新首页 views；
- 测试恢复 canonical source exact bytes/hash；
- active/ContentSet/reviews/recoveries/releases/SitePublications/ProductArtifact 前后不变；
- check、release:prepare、targeted runtime、closeout、exact build、preflight 和 clean 通过；
- elon 产品/架构验收通过；Xing 完成一次实际本地使用确认。

## 内容兼容声明

```yaml
contentImpact: compatible-metadata-correction
contentImpactReason: correct-target-consumer-routes-and-local-preview-only
affectedTargets: [content-preview-session, target-impact, products.robotaxi.consumer-routes, site.home.source-readiness]
affectedRoutes: [local-only]
affectedFields: []
compatibilityEvidence: no-content-value-or-lifecycle-write-and-no-publication-action
```

## 执行顺序

1. elon 完成 v0.26.21 design/current。
2. elon ops 完成 Home canonical source readiness。
3. elon engin 实现、测试、commit/tag/clean、ProductArtifact/preflight。
4. elon 做产品/架构验收。
5. Xing 进行一次本地实际使用确认；内容仍需以后独立审核和发布。
