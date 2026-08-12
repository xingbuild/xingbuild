# XBUILD-PRODUCT-WHY-BLOCK-001

状态：已转化为正式方案并归档。

- 目标版本：`v0.26.15`
- 正式方案：`docs/design/v0.26.15 通用响应式内容表达与独立发布能力方案.md`
- 原候选：`docs/iterations/candidates/DRAFT-XBUILD-PRODUCT-WHY-BLOCK-001.md`
- 转化原因：Xing 确认 Why 不是新页面或新页面级模块，而是 `/products` 既有 ProductHero 的可选语义内容；同时要求首页定位、首页作品说明、产品说明和模块说明具备同一类可运营的 Web/Mobile 换行能力。

## 已确认的产品/视觉事实

- `/products` 结构保持：Robotaxi 标题 → 现有作品说明 → “为什么做”及两条原因 → 现有 CTA。
- Why 页眉与两条原因居中；不放到 CTA 下方，不新增路由、H1、卡片、阴影、分割线或页面生命周期。
- Why 缺失时不渲染且不留空白；确认的关系间距为标题→说明 `16px`、说明→Why `12px`、页眉→第一条 `4px`、两条原因 `8px`、原因→CTA `24px`。
- 两条原因的稳定语义身份为 `transferability` 与 `ai-collaboration`；内容文本保持 Xing 已确认原文。
- Mobile 可以按内容合同声明逗号后的换行，但不能把物理屏幕行写成代码或 HTML。

## 转化后的范围变化

原候选仅描述 Why；正式方案将其纳入通用 `ResponsiveTextSlot` 能力，并登记首页定位、首页/产品说明、Why 与作品模块说明等初始内容框。该扩展只增加内容表达与 ContentSet 能力，不改变页面 IA、页面独立投影或产品/内容发布边界。

Engineering 必须保持旧字符串和既有 active ContentSet 兼容，并验证 ContentSet Candidate、prepare/build/reconcile、rollback、ProductArtifact、SiteSnapshot 与 Coordinator 的既有唯一链路。内容 task 只能在产品版本上线并公网验收后发布初始文案与 break hints。

## 责任与边界

- 产品/视觉：定义正式能力、页面关系和独立验收。
- Engineering：实现 `responsive-text-slot-v1`、adapter、target registry、renderer 和测试。
- 内容 task：上线后通过独立 ContentSet Candidate 更新文本与已登记 break hints。
- Coordinator：继续作为唯一物理发布 owner。

该候选不再作为活动 DRAFT；任何新的视觉差异必须登记新的候选或下一正式版本，不回写 v0.26.14。
