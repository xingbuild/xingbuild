# 当前迭代

## 当前唯一版本：`v0.26.23`

父版本：v0.26.22 / `6868f0d03a581f1d2a9d6b27e5783b085f958adf`

contentImpact: compatible
contentImpactReason: 本版本只增加 dev-only 内容作者工作台、authoring value 编译与局部预览写入；不改变已发布内容 schema、active ContentSet、页面结构或发布链路。
affectedTargets: ["content-preview-authoring", "all-editable-text-targets"]
affectedRoutes: ["/", "/products", "/business-observations", "/observations", "/about"]
affectedFields: ["canonical ignored content text fields only"]
compatibilityEvidence: content preview writes only canonical ignored source with source/value hash CAS; active/review/recovery/release/SitePublication/ProductArtifact are read-only and unchanged.

## 正式方案

[docs/design/v0.26.23 全页面自然文本内容编辑工作台方案.md](../design/v0.26.23%20全页面自然文本内容编辑工作台方案.md)

## 本版本要解决的真实问题

v0.26.22 已实现按 target 精准刷新，但 Xing 仍必须直接编辑 `parts / projection / breakAfter` 等工程内部结构，无法像普通内容作者一样在页面字段中直接输入文字和回车。这个能力没有完成真正的内容作者工作流。

## 产品范围

- 工作台覆盖 `content/registry/content-targets.json` 中所有 `editable=true` 的文本 target 和模板实例；媒体 target 仍在同一清单中可见但明确只读。页面域包括 `/`、`/products`、`/business-observations`、`/observations`、`/about`。
- Xing 只编辑自然文本；响应式 slot 由内部 authoring compiler 自动生成；Web/Mobile 默认共享一份文本，只有明确选择移动端特殊换行时才生成 profile 断点。
- 工作台提供 target 页面分组、字段选择、文本编辑、Web/Mobile frame、source/value hash、状态和错误提示。
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

1. 每个页面域至少选择一个 target，Xing 能在工作台直接输入自然文本并用回车换行；
2. Web1280/Mobile390 frame 显示编辑结果，Products intro 等多消费者 target 只刷新其受影响页面；
3. Web/Mobile 特殊断点可选且不会形成两份漂移文案；
4. invalid、半写入、恢复、CAS 冲突均可观察，last-valid 页面不白屏；
5. active ContentSet、review/recovery/release/SitePublication/ProductArtifact 前后 byte/hash 不变；
6. 4317 lease/PID/profile/temp 清理通过；
7. `elon ui` 只对工作台能力做一次独立体验验收，日常内容编辑不重复进行全站视觉验收。

## 责任与发布边界

`elon` 维护本方案；`elon engin` 实现与本地 QA；Xing 做一次真实编辑确认；`elon ops` 只在 Xing 确认内容后执行独立内容发布。产品工程 transport 和内容发布仍然互不触发。
