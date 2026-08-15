# XBUILD-CONTENT-STORAGE-EVIDENCE-CORRECTION-003

状态：`converted-to-v0.27.5`

目标版本：`v0.27.5`
正式方案：`docs/design/v0.27.5 内容生命周期证据与发布门禁纠偏方案.md`
转换理由：Xing 已授权执行；候选完整内容已进入 `current.md` 与正式方案，原候选不再作为活动候选。

目标：补齐内容生命周期与派生物治理的真实证据门禁；不重复实现已完成的生命周期逻辑，不修改官网数据，不执行清理或发布。

事实基线：`v0.27.0`～`v0.27.4` history、`docs/design/v0.27.4 内容存储治理证据门禁修复方案.md`、`.content-workspace/qa/v0274-storage-governance/evidence.json`。

## 一、原始优化点对照

| 原始项 | 当前判断 | 结论 |
| --- | --- | --- |
| `DL-01` | v0.27.0 已实现 logicalContentId current+2 revision 模型 | 逻辑已实现；补真实 evidence |
| `DL-02` | v0.27.0～v0.27.2 已实现 changed-only、revision/ref 复用 | 逻辑已实现；补真实 evidence |
| `DL-03` | v0.27.1～v0.27.2 已实现引用化 SitePublication 与临时组装边界 | 逻辑已实现；补真实 evidence |
| `DL-04` | deterministic rebuild、atomic failure、resume/rollback、retention 被合并描述 | 必须拆成四个独立可证明结果，不能以“逻辑已实现”代替证据 |
| `CL-01` | v0.27.3～v0.27.4 已有可重跑 inventory | 工具存在；字段与真实证据未完成 |
| `CL-02` | v0.27.3～v0.27.4 已有引用图 | 工具存在；当前 evidence contract 未成立 |
| `CL-03` | v0.27.3～v0.27.4 已有 keep/review/archive-dry-run/delete-never 分类 | 分类存在；真实分类摘要/证据未完成 |
| `CL-04` | v0.27.3～v0.27.4 已有 zero-write/dry-run 路径 | 仍需正向 unleased/unreferenced/reconstructible fixture |
| `CL-05` | 物理归档/删除从未执行 | 保持独立授权，不纳入本候选实现 |

## 二、当前遗漏与错误理解

| ID | 必须修正 |
| --- | --- |
| `E-01` | 身份分两阶段：pre-commit 绑定 base HEAD、未提交 scope/diff digest、fixture/run provenance；`READY_FOR_COMMIT` 后再绑定 exact annotated tag/tagCommit、ProductArtifact、artifactHash、baseSiteArtifactId、rootManifestHash；不能要求 pre-commit 拥有尚不存在的制品 |
| `E-02` | 禁止 placeholder、测试文件路径或 delegated 文本充当 evidence；测试路径只能作为带 runId/commit/digest 的 provenance |
| `E-03` | update/add/no-change 必须有真实 scenario runId、fixture/source hash、before/after source/value hash、identity、changed target、unchanged identity 和实际 ChangeSet/Candidate 结果 |
| `E-04` | atomic failure 与 same-publication resume 分开验证；各自必须记录 PublicationRun、lease、outputRoot、deploymentId、临时物清理、active pointer 和 identity 结果 |
| `E-05` | reducer 只能依据字段 schema、来源证明、identity 和场景结果计算 PASS；显式拒绝 sentinel/placeholder/delegated 字符串、truthy status 和缺失字段 |
| `E-06` | 共享 validator 必须区分 pre-commit 未提交 evidence 与 post-`READY_FOR_COMMIT` exact tag/build/preflight；`allowPending` 不得转成 PASS；`release:prepare`、closeout、preflight 和治理 CLI 均必须调用它 |

## 三、强制验收 checklist

- `C-01`：pre-commit evidence 完整绑定 base HEAD、uncommitted scope/diff digest、fixture/run provenance；post-`READY_FOR_COMMIT` evidence 再完整绑定 exact annotated tag/tagCommit、ProductArtifact、artifactHash、baseSiteArtifactId、rootManifestHash。
- `C-02`：每个 evidence 字段均有本次 run 的 provenance；拒绝 placeholder、sentinel、delegated 文本和路径代替结果。
- `C-03`：update 真实 changed-only；未变化 target identity/hash 保持不变。
- `C-04`：add 真实新增 target；既有 target identity/hash 保持不变。
- `C-05`：no-change 不生成新的 Candidate/ChangeSet/Snapshot/Publication 输入并复用 active identity；同一 ProductArtifact+ContentSet+manifest 可 deterministic rebuild 同一 SiteSnapshot/hash。
- `C-06`：atomic failure 注入前后 path-set/bytes/hash、active pointer、Candidate/ChangeSet、PublicationRun/lease/outputRoot 和临时物状态均有真实 before/after 证据。
- `C-07`：same-publication resume/rollback 复用同一 object/publication/deploymentId；重复执行幂等，deployment 不增加。
- `C-08`：inventory/reference graph 可重跑且 deterministic；每条记录必须有 `logicalId/objectKind/namespace/state/bytes/hashMode/hash/sourceOfTruth/owner/retainUntil/decision/reason`，并输出 `keep/review/archive-dry-run/delete-never` 四类摘要；证明 current+2/retention decision、完整 root/reference graph、zero-action 和正向 unleased/unreferenced/reconstructible archive fixture；未解析引用默认保护。
- `C-09`：SitePublication durable record 与临时 materialization 分离；legacy persisted outputRoot 默认保护；不产生新的长期完整 client 副本，受控临时组装允许。
- `C-10`：pre-commit evidence → `elon` 逐项验收 → `READY_FOR_COMMIT` → commit/tag/build/preflight 两阶段门禁完整；exact-tag 条件只在 post-commit 阶段生效，此前不得提交或发布。

## 四、绝对不变边界

- 保留官网、canonical content/media、ContentSlotRegistry、active pointer/ContentSet、current+2 logicalContent revisions、review/recovery、当前 ProductArtifact source/dist、SiteSnapshot/PublicationRun/SitePublication、deployment/publicVerify、receipt/lineage/incident、lease 和 unknown refs。
- 不物理删除、移动、归档或迁移；不修改 v0.27.4 tag/history；不运行 content publish、product transport 或 EdgeOne。
- 不新增 CMS、第二套发布器或第二套生命周期模型；禁止持久全站复制，允许受控临时组装。

## 五、完成条件

Engineering 先按本 checklist 自 QA 并回传未提交证据；`elon` 逐项复核。任何遗漏回 Engineering 在同一版本修复；全部通过后由 `elon` 回传 `READY_FOR_COMMIT`，再进入提交、构建、preflight 和后续授权发布流程。

## 六、复核记录

`elon1`（threadId=`019ff905-7298-7bf0-b3fb-ba3fc10a40c2`）最终只读复核：`PASS`。确认 DL/CL 逐项映射、pre/post 两阶段身份、deterministic rebuild、current+2/retention、inventory 字段与四类摘要、真实 run/provenance、PublicationRun/lease/deploymentId、正向 archive fixture、legacy outputRoot 保护和两阶段 validator 门禁均无剩余最小缺口。候选仍为 `pending-xing-review`，未进入 `current.md` 或 Engineering。
