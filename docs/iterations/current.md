# 当前迭代

## 当前唯一版本：`v0.26.26`

父版本：v0.26.25 / `aee49a3a4a6801fc43d82374a37ad99703c35dc9`

contentImpact: compatible
contentImpactReason: 本版本只改 dev-only 内容工作台的选择与编辑体验，并把已存在的内容正文字段纳入同一 target registry；不改页面 IA、线上产品、active ContentSet、审核或发布链路。
affectedTargets: ["page-click-content-selection", "authored-body-text-targets", "minimal-workbench-header", "independent-editor-preview-scroll"]
affectedRoutes: ["/", "/products", "/business-observations", "/observations", "/about"]
affectedFields: ["canonical ignored authored text fields only"]
compatibilityEvidence: 内容预览仍只写 canonical ignored source，使用 source/value hash CAS 与原子替换；active/review/recovery/release/SitePublication/ProductArtifact 只读且不变。

## 正式方案

[docs/design/v0.26.26 内容工作台页面点击选择与正文编辑方案.md](../design/v0.26.26%20内容工作台页面点击选择与正文编辑方案.md)

## 本版本要解决的真实问题

v0.26.25 的页面下拉已有效，但横向字段卡仍让 Xing 先理解技术字段再操作；工作台也只覆盖部分标题/摘要/说明，文章、关于我和观察正文不能从页面直接选中编辑。工作台必须变成“看到页面 → 点击文字 → 左侧编辑 → 右侧即时确认”的单一操作路径。

## 产品范围

- 顶部只保留标题“本地编辑预览工具”和页面下拉；移除可见 targetId、revision、未审核/未发布状态卡及横向字段选择条。运行状态仍保留为屏幕阅读器可读的隐藏 live region，不丢失诊断能力。
- 右侧展示当前页面真实 Web1280/Mobile390 页面。页面内所有已登记、可编辑的内容文字以轻量可点击标记呈现；点击标题、说明、正文、列表项、文章证据文字等内容后，左侧立即进入对应 editor，保留页面语义名称与影响页面提示，不显示技术 targetId。
- 覆盖所有内容事实文字 target：站点字段、B端产品字段、文章/关于我 rich-document 文本块与列表项、观察文章 brief/段落/evidence claim；媒体、路由、schema、组件、CSS、来源和审核字段只读或不进入正文编辑。
- 文章/关于我正文块使用稳定 block/item id；观察的多段正文使用 `content-rich-text-list-v1`，编辑器用换行表达段落，保存时仍写回原有数组结构。此处只增加稳定身份元数据，不改现有可见文字。
- 左侧 editor 独立纵向滚动；右侧预览保持 sticky 且拥有自己的滚动区域，左侧上下移动不会带动右侧页面；右侧占据主要空间。页面下拉始终固定可用。
- 保存仍只写选中 target 的 canonical ignored source；SSE/TargetImpact 只刷新真实受影响 route×viewport，不 full reload、不全站 build、不生成 ProductArtifact/ContentSet/SitePublication。

## 明确不做

- 不修改页面 IA、布局、组件、视觉 token、媒体归属、产品代码文案或页面生命周期。
- 不把 ContentSet、review、recovery、release、ProductArtifact、SitePublication、deployment、EdgeOne 当作预览编辑目标。
- 不新增 CMS、数据库、第二套 target registry、第二套 renderer；正文 target 仍来自同一 registry 与 canonical ignored source。
- 不要求 Xing 编辑 JSON、fieldPath、responsive-text-slot parts 或 breakAfter；Web/Mobile 默认共享文本，只有需要时通过编辑器勾选移动端换行。
- 不以内容编辑触发产品版本、产品 transport 或 content publish；Xing 确认后才交 `elon ops` 走独立内容发布。

## 工程实现边界

Engineering 只扩展 dev-only content-preview：正文 target 枚举与稳定身份、页面标记点击、authoring compiler、rich-text-list 编解码、TargetImpact 局部刷新和零写入发布保护；不改已发布内容事实、不复制页面投影、不把内容编辑逻辑写进网站运行时。

## 验收合同

1. 页面下拉可进入首页、B端产品、经营观察、观察文章、关于我；页面正文详情目标按真实 slug 加载，右侧只显示当前页面的 Web1280/Mobile390。
2. 右侧可点击选择标题、说明、正文段落、列表项、文章 claim/brief；点击后左侧显示语义字段与影响页面，技术 targetId 不在可见界面出现。
3. 修改文章、关于我、观察正文后，只刷新对应 route×viewport；Products intro 的多消费者仍只刷新 `/` 与 `/products`。
4. rich-document 列表、定义列表、文章段落和 observation 段落保持原结构；换行可编辑、保存后页面立即显示，source/value hash 与 CAS 生效。
5. invalid、半写入、恢复、CAS 冲突均保留 last-valid 页面，不白屏；编辑器和预览独立滚动，左侧滚动不改变右侧 scrollTop。
6. active ContentSet、review/recovery/release/SitePublication/ProductArtifact 前后 byte/hash 不变；4317 lease/PID/profile/temp 退出后清理。
7. 只对本次工作台能力做定向 QA 与一次 Xing 实际使用确认；不因每天改内容重复执行全站产品视觉验收。

## 责任与发布边界

`elon` 维护本方案；`elon engin` 实现与本地 QA；Xing 做一次页面点击/正文编辑确认；`elon ui` 只做一次工作台能力验收；`elon ops` 只在 Xing 确认具体内容后执行独立内容发布。产品工程 transport 与内容发布仍然互不触发。
