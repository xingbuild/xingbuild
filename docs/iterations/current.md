# 当前迭代

## 当前唯一版本：`v0.26.28`

父版本：v0.26.27 / `e15fa851d2a34f891d254403b0f3559902ad4c93`

contentImpact: compatible
contentImpactReason: 本版本只升级 dev-only 内容工作台的正文表达、目标级差异刷新和一键启动入口；不改变公开页面 IA、产品视觉、active ContentSet、审核事实或线上发布身份。
affectedTargets: ["content-rich-text-list-v1", "content-target-identity", "preview-target-impact", "content-preview-launcher", "preview-workbench-save-state"]
affectedRoutes: ["/", "/products", "/business-observations", "/observations", "/about"]
affectedFields: ["registered content authoring targets only; no active ContentSet write"]
compatibilityEvidence: 旧 string/responsive-text-slot 继续可读；旧 ContentSet、review/recovery/release/SitePublication/ProductArtifact 只读。差异更新只消费 target registry 的 consumerViews，不触发全站 build/reload 或发布。

## 正式方案

[docs/design/v0.26.28 本地内容工作台结构化正文、差异更新与产品化入口方案.md](../design/v0.26.28%20本地内容工作台结构化正文、差异更新与产品化入口方案.md)

## 本版本要解决的真实问题

v0.26.27 已实现右侧真实页面导航、正文点击选择和 TargetImpact，但普通正文回车不能稳定表达为段落，自动保存与手动保存状态容易造成误解，桌面关系线重复，且内容工作台没有可直接发现的一键启动入口。

## 产品范围

- 关于我与经营观察长文正文支持结构化段落编辑；旧字符串只在真正修改后升级为 rich-text-list，不做无意义全量迁移。
- 保存反馈区分无变化、已写入本地源、未审核、未发布，并提供 before/after hash、差异摘要和实际 consumerViews。
- 只更新发生变化的 target 及其登记消费者；不刷新无关 route/frame，不触发全站 build、ProductArtifact、ContentSet、SitePublication 或 EdgeOne。
- 移除工作台关系线，保留页面真实导航、target 高亮、左侧编辑器和受影响页面说明。
- 新增 `./start-content-preview.command` 作为固定 4317 的一键内容工作台入口；现有网站启动和产品/内容发布命令保持原职责。
- 对重复 block/item id 硬失败，不静默写入第一个同名对象；元数据修正由 elon ops 独立处理。

## 明确不做

- 不修改公开页面 IA、路由、组件组合、视觉系统或产品正文事实。
- 不把内容工作台保存直接连接到 approve、ContentSet active、产品 transport、EdgeOne 或线上状态。
- 不通过全站 full reload、全站 build 或第二套发布引擎实现局部预览。
- 不自动修复或重命名既有内容 block/item id；只报告歧义并阻止错误写入。
- 不改变 `./start-xingbuild.command`、`./publish-xingbuild.command`、`./publish-content.command` 的既有职责和门禁。

## 工程实现边界

`elon engin` 只修改 dev-only content-preview、authoring/compiler/decompiler、rich-text-compatible renderer、target identity/impact、启动入口和相应定向测试；产品构建与内容发布链路保持隔离。此前已授权但尚未提交的 task attention marker 规则文档只原样纳入本轮治理收口，不改变其内容。

## 验收合同

1. 双击 `./start-content-preview.command` 可复用正确的 4317 content-preview lease 并自动打开工作台；普通网站启动与三个 publish 入口静态合同仍通过。
2. About 与经营观察正文回车后，Web/Mobile 右侧显示真实段落；重新打开工作台后内容仍存在；string/responsive 旧目标保持兼容。
3. 重复 block/item id 明确报告 ambiguous target，不能写入第一个同名对象。
4. 修改一个 target 后只更新其 consumerViews；无关 frame 的 URL、revision、DOM 与状态不变；不触发全站 reload/build。
5. `targetId`、before/after hash、变化段落/断点和 consumerViews machine evidence 完整；active ContentSet、review/recovery/release、ProductArtifact、SitePublication 和线上状态 hash 不变。
6. Xing 完成一次真实闭环：启动工具 → 页面导航 → 点击正文 → 回车分段 → 右侧确认 → 重新打开确认 → 恢复原文。

## 责任与发布边界

`elon` 维护方案与验收；`elon engin` 实现、测试、版本收口和 ProductArtifact/preflight；`elon ui` 仅在发现实际视觉/可访问性回归时介入；`elon ops` 处理内容 block/item 元数据、审核与独立 ContentSet 发布。产品 transport 与内容发布继续互不触发。
