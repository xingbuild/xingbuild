# XBUILD-CONTENT-AUTHORING-LIFECYCLE-REMAINING-001

状态：`archived-transformed`
归档原因：`R31-01`～`R31-07` 已进入 v0.26.31；`DL`/`CL` 保留为独立活动候选。

## 目的

收口当前内容工作台、简历制品引用、内容生命周期和历史派生物治理；保持内容、产品代码、预览和发布边界独立。

## 未完成项

### A. v0.26.30 验收阻断与内容制品边界

| 编号 | 必须完成 |
| --- | --- |
| `R31-01` | 简历改为可验证的 `ResumeArtifactRef` 内容引用；页面功能只消费 resolver 结果，不在代码中写死 PDF 路径、hash 或旧制品身份。 |
| `R31-02` | 只使用 career 已确认 PDF（SHA-256=`1a8a8bc55fc25cc7dd168f9e68814a7f91ea2969fe0dd54c16448e1800897e5f`）；查看/下载同一字节，下载名为 `金星简历YYYYMMDDHHmm.pdf`，不公开 HTML、Kami 或内部文件名。 |
| `R31-03` | 简历制品注册、受保护源证明、PDF hash、公开状态和发布资产可独立校验；源文件只能由 Xing 修改，工作台不能上传或覆盖。 |
| `R31-04` | 产品总案删除旧 Kami 制品事实，并与 career 的单 PDF合同一致。 |
| `R31-05` | 内容预览/target evidence 必须绑定当前 exact HEAD/tag；证据身份不一致或过期时硬失败。 |
| `R31-06` | 完成一次真实工作台闭环：页面选择→编辑→仅受影响 consumerViews 更新→恢复原值；无关页面不刷新，受保护事实零写入。 |
| `R31-07` | 对 v0.26.30 实际改变的首页节奏与可选投影做变更范围内 `elon ui` 验收；不做无关全站重审。 |

### B. 内容数据生命周期（保留原编号）

| 编号 | 必须完成 |
| --- | --- |
| `DL-01` | 每个 `logicalContentId` 保留 current + 前两个历史状态。 |
| `DL-02` | 未变化内容、媒体和静态资源按 hash/稳定引用复用。 |
| `DL-03` | SitePublication 只保留 ProductArtifact、ContentSet、manifest、deployment、publicVerify 等引用事实。 |
| `DL-04` | 建立迁移、重建、回滚和保留窗口的可验证路径。 |

### C. 历史派生物治理（保留原编号）

| 编号 | 必须完成 |
| --- | --- |
| `CL-01` | 生成 path、owner、object、hash、reference、retainUntil inventory。 |
| `CL-02` | 交叉 active、receipt、lineage、SitePublication、recovery 引用。 |
| `CL-03` | 输出 keep、review、archive-dry-run、delete-never 清单。 |
| `CL-04` | 仅对无 lease、无引用、可重建对象生成可恢复 dry-run。 |
| `CL-05` | Xing 明确保留窗口和授权后，才执行归档或物理清理。 |

## 已完成，不重复纳入实现

- 页面导航选择、target 编辑、consumerViews 局部刷新和零写入预览边界。
- Home source mapping、long-form-document-v1、正文回车/列表、可选投影自动收紧。
- P30-04 首页父级节奏实现；最终视觉验收仍由 `R31-07` 负责。
- 内容发布与产品发布分离；DL/CL 未进入任何已发布版本。

## 版本建议

1. `v0.26.31`：完成 `R31-01`～`R31-07`，修复简历制品引用、产品总案、exact-tag evidence，并完成实际使用与变更范围视觉验收。
2. `v0.27.0`：合并完成 `DL-01`～`DL-04` 与 `CL-01`～`CL-04`，只做生命周期模型、引用 inventory 和可恢复 dry-run。
3. 物理清理不自动进入版本；`CL-05` 需 Xing 单独授权后执行。

## 禁止

- 不修改或回写 v0.26.30、已发布 SitePublication、active ContentSet 或 career 受保护源。
- 不用聊天内容替代本候选；不创建第二套预览或发布引擎。
- 不以全站 reload、全站 build 或复制整站快照实现局部内容更新。
