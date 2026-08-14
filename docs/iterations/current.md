# 当前迭代

## 当前唯一版本：`v0.26.29`

父版本：v0.26.28 / `7caf8eb66011302e04275cf928da4aa8644bdff4`

contentImpact: compatible

contentImpactReason: 本版本修复本地内容工作台与内容 Candidate 的 source-of-truth 映射，并保持 target 级局部预览/差异更新；不改变公开页面 IA、ContentSet schema、审核事实、active ContentSet 或线上内容身份。

affectedTargets: ["home:home", "practice:robotaxi", "article:enterprise-operating-system", "profile:about", "content-target-identity", "preview-target-impact"]

affectedRoutes: ["/", "/products", "/business-observations", "/about"]

affectedFields: ["canonical ignored content source", "normalized value", "contentHash", "sourcePath", "consumerViews", "ContentSet Candidate entry"]

compatibilityEvidence: 旧 string、content-rich-text-list-v1、responsive-text-slot-v1、TargetImpact、Preview Runtime v2 和现有 ContentSet 继续兼容；预览与发布均不得触发无关 route/frame 的更新或全站 build/reload。

## 正式方案

[docs/design/v0.26.29 内容工作台预览源统一与目标级内容发布方案.md](../design/v0.26.29%20内容工作台预览源统一与目标级内容发布方案.md)

## 本版本要解决的真实问题

Xing 已在本地工作台修改首页、Robotaxi 产品、经营观察和关于我内容。当前预览读取 `.content-workspace/content/home.json`，但 Home Candidate 仍可能读取 `src/content/siteContent.js` legacy fallback；因此预览看到的内容与实际发布内容可能不一致。与此同时，任何内容修改都必须保持 target 级局部刷新，而不是全站重载、全站构建或整套产品产物更新。

## 产品范围

1. Home 内容发布 source 统一为 `.content-workspace/content/home.json`；legacy `src/content/siteContent.js` 仅保留 product-only 本地 fallback，不得作为 Candidate 输入。
2. Home runtime、`home:home` entry、Candidate payload 使用同一个 normalized value 与 `contentHash`，并记录 `sourcePath=content/home.json`、route `/` 和 `consumerViews`。
3. Home、practice、article、profile 的同批变化合并为一个 ContentSet Candidate；未变化 target 复用 active identity，不生成重复 deployment。
4. 延续 Preview Runtime v2 的 target→consumerViews 精准刷新、invalid/半写入 last-valid、重复 ID/未登记 target 硬失败和 session/lease cleanup。
5. 保存/记录阶段只写 ignored `.content-workspace` 证据；不写 active.json、review approval、ContentSet、ProductArtifact、SitePublication 或线上状态。
6. 本轮产品能力完成并公网验证后，由 `elon ops` 单独执行已记录内容的 review → ContentSet Candidate → Coordinator publish；产品 transport 不自动等同内容发布。

## 明确不做

- 不修改 v0.26.28 或任何已发布 SitePublication/deployment/tag/history。
- 不手工复制首页到 `src/content/siteContent.js`，不保留两套可写 Home 事实。
- 不用全站 full reload、全站 build、ProductArtifact 或 SitePublication 实现即时预览。
- 不改变公开页面 IA、视觉 token、媒体安全属性、内容审核和 active ContentSet 事实。
- 不自动 approve、active、publish；不创建第二套 content publish engine 或第二个 deployment。
- 不做与本次 source mapping/target impact 无关的视觉重审；只有发现实际视觉/可访问性回归才交 `elon ui`。

## Engineering 实现边界

`elon engin` 负责 Home adapter、content target/Candidate 统一校验、normalized hash/source/consumer evidence、同批 Candidate 合并、Preview Runtime v2 回归保护、CLI 门禁和定向测试。现有 `start-content-preview.command`、`start-xingbuild.command`、`publish-xingbuild.command`、`publish-content.command` 保持原职责。

Engineering 不得修改内容事实、active/review/recovery/release/SitePublication，不得绕过 Coordinator/preflight，不得依据聊天内容扩大版本范围。

## 验收合同

1. `home.json` 与 `src/content/siteContent.js` 故意不同，Home prepare 仍从 `home.json` 生成 Candidate，source/hash/value/route 精确一致；缺失/非法/未登记/不一致在写入前硬失败且零落盘。
2. 四个 target 同批变化只形成一个 Candidate；未变化 entryId/contentHash 不变。
3. 修改一个 target 只增加其 `consumerViews` 的 frame revision；无关 route/frame 的 URL、revision、DOM、滚动上下文不变。
4. invalid、半写入、恢复、重复 ID 均保留 last-valid，不发生全站 reload/build。
5. 预览和 Candidate 前后 active ContentSet、review/recovery/release、ProductArtifact、SitePublication 与线上状态零变化。
6. Xing 能完成：启动工作台 → 页面导航 → 编辑并即时局部预览 → 恢复/确认原文；产品能力完成后产品 transport；公网 product verify 后 `elon ops` 按同一 source/hash 发布内容。
7. 任何 prepare/build/closeout/preflight/transport/publicVerify 失败立即停止并保留 machine evidence；不得把未完成阶段报告为上线成功。

## 责任与收口顺序

- `elon`：维护本方案、边界与产品验收。
- `elon engin`：实现、定向 QA、版本/VERSION/history、commit/tag/clean、ProductArtifact/preflight。
- `elon ui`：仅在真实视觉/可访问性回归时独立验收。
- `elon ops`：先记录本次四个 target 的 before/after/hash；产品上线后独立走内容审核与发布。
- Xing：完成一次实际工作台闭环确认；现有持续产品发布授权继续有效，除非 Xing 明确暂停。
