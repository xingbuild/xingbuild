# 当前迭代

## 当前唯一版本：`v0.26.25`

父版本：v0.26.24 / `4d26a16fc332c3399d9fe5fb15130235a9d44633`

contentImpact: compatible
contentImpactReason: 本版本只改进 dev-only 页面化内容工作台的固定选择区与独立预览滚动；不改变已发布内容 schema、active ContentSet、页面结构或发布链路。
affectedTargets: ["fixed-page-selector", "horizontal-content-selector", "isolated-preview-scroll", "content-preview-authoring"]
affectedRoutes: ["/", "/products", "/business-observations", "/observations", "/about"]
affectedFields: ["canonical ignored content text fields only"]
compatibilityEvidence: content preview writes only canonical ignored source with source/value hash CAS; active/review/recovery/release/SitePublication/ProductArtifact are read-only and unchanged.

## 正式方案

[docs/design/v0.26.25 工作台固定选择区与独立预览滚动方案.md](../design/v0.26.25%20工作台固定选择区与独立预览滚动方案.md)

## 本版本要解决的真实问题

v0.26.24 已实现页面分类、字段选择和真实 Web/Mobile 预览，但页面选择与字段列表占据左侧纵向空间；预览滚动时工作入口容易离开视线，重复切换效率不高。

## 产品范围

- 工作台覆盖 `content/registry/content-targets.json` 中所有 `editable=true` 的文本 target 和模板实例；媒体 target 仍在同一清单中可见但明确只读。页面域包括 `/`、`/products`、`/business-observations`、`/observations`、`/about`。
- Xing 只编辑自然文本；响应式 slot 由内部 authoring compiler 自动生成；Web/Mobile 默认共享一份文本，只有明确选择移动端特殊换行时才生成 profile 断点。
- 工作台以页面分类为第一入口；左侧显示当前页面可编辑字段与状态，右侧显示同一页面的真实 Web/Mobile frame。
- 页面分类改为顶部固定的原生下拉选择；当前页面字段改为其下方固定的横向滚动选择条。
- 下方工作区独立纵向滚动，页面下拉与字段选择不随 Web/Mobile 预览滚动离开；保留左侧编辑与右侧真实预览关系。
- 选中左侧字段时，右侧真实页面区域高亮并显示对应关系线；多消费者 target 显示所有真实受影响页面，避免误改或漏改。
- 写入只允许当前 target 对应的 canonical ignored content source，采用 source-hash CAS 与原子替换；无效值不落盘。
- 目标发生变化时只刷新真实 consumer routes/views；不做 full reload、全站 build、ProductArtifact、ContentSet、SitePublication 或发布。

## 明确不做

- 不改变页面 IA、布局、组件、视觉 token、媒体归属或页面生命周期。
- 不新增 CMS、数据库、第二套 target registry、第二套页面内容源或第二套 renderer。
- 不要求 Xing 直接编辑 JSON；不复制 Web/Mobile 两份完整文案。
- 不写 `src/`、`active.json`、ContentSet、review、recovery、release、ProductArtifact、SitePublication、deployment 或 EdgeOne。
- 不清理历史发布证据，不创建 branch/worktree/automation。

## 工程实现边界

Engineering 只实现正式方案中的 authoring value 编译器、全 target 工作台、source hash CAS 原子写入、响应式断点编辑、TargetImpact 局部刷新和零发布副作用；不得借此修改页面结构或内容发布生命周期。

## 验收合同

1. 顶部下拉可进入首页、B端产品、经营观察、观察文章、关于我；每个页面至少选择一个 target，Xing 能在工作台直接输入自然文本并用回车换行；
2. 页面下方字段选择条可横向滚动；切换字段时左侧字段与右侧真实页面区域存在可见高亮和对应关系线；
3. Web1280/Mobile390 frame 显示编辑结果，Products intro 等多消费者 target 只刷新其受影响页面；
4. Web/Mobile 特殊断点可选且不会形成两份漂移文案；
5. invalid、半写入、恢复、CAS 冲突均可观察，last-valid 页面不白屏；
6. active ContentSet、review/recovery/release/SitePublication/ProductArtifact 前后 byte/hash 不变；
7. 4317 lease/PID/profile/temp 清理通过；
8. `elon ui` 只对工作台能力做一次独立体验验收，日常内容编辑不重复进行全站视觉验收。

## 责任与发布边界

`elon` 维护本方案；`elon engin` 实现与本地 QA；Xing 做一次真实编辑确认；`elon ops` 只在 Xing 确认内容后执行独立内容发布。产品工程 transport 和内容发布仍然互不触发。
