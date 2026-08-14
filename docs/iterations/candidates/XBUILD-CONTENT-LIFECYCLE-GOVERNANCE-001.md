# XBUILD-CONTENT-LIFECYCLE-GOVERNANCE-001

状态：`DRAFT`；下一正式方案候选；未进入 `current.md`。

## 内容数据生命周期

| 编号 | 必须完成 |
| --- | --- |
| `DL-01` | 每个 `logicalContentId` 保留 current + 前两个历史状态。 |
| `DL-02` | 未变化内容、媒体和静态资源按 hash/稳定引用复用。 |
| `DL-03` | SitePublication 只保留 ProductArtifact、ContentSet、manifest、deployment、publicVerify 等引用事实。 |
| `DL-04` | 建立迁移、重建、回滚和保留窗口的可验证路径。 |

## 历史派生物治理

| 编号 | 必须完成 |
| --- | --- |
| `CL-01` | 生成 path、owner、object、hash、reference、retainUntil inventory。 |
| `CL-02` | 交叉 active、receipt、lineage、SitePublication、recovery 引用。 |
| `CL-03` | 输出 keep、review、archive-dry-run、delete-never 清单。 |
| `CL-04` | 仅对无 lease、无引用、可重建对象生成可恢复 dry-run。 |
| `CL-05` | Xing 明确保留窗口和授权后，才执行归档或物理清理。 |

## 边界

- 不删除或迁移现有内容、active ContentSet、SitePublication、recovery、历史证据或 career 源。
- 不把生命周期模型带入产品页面、预览或内容发布功能；不创建第二套发布引擎。
- 先完成 DL 模型和引用 inventory，再决定 CL 的可恢复归档；物理清理必须单独授权。
