# XBUILD-CONTENT-STORAGE-ARCHITECTURE-004｜内容数据与增量发布最小架构

状态：`pending-xing-review`

## 一、唯一目标

建立三层分离的内容发布架构：`ProductArtifact` 只承载产品能力，`ContentDataArtifact` 只承载内容数据，`SitePublication` 只保存两者引用和发布结果。不复制整站、不持续堆积过程文件；清理旧数据只是迁移结果，不是本候选的核心目标。

完成后，内容数据与产品能力完全分离：内容更新只产生内容 revision、`ContentDataArtifact` 和 ContentSet 变化，不生成新的 ProductArtifact 或重新构建产品 client；产品能力变化只升级读取/展示能力，不覆盖或篡改内容。每个 `logicalContentId` 保留当前 revision 与前两次 revision，重复发布不重复保存未变化内容、媒体或完整站点构建物；发布和预览仍可重跑。

## 二、当前根因

`publishContentSet()` 当前仍以 `assemble: true` 重新构建完整 client，并把结果写入 `site-publications/`；`releases/`、`base-site-artifacts/` 和 QA 目录又把可重建的 source/client/snapshot/过程证据持久化为多份副本。生命周期逻辑虽已支持 identity、changed-only 和引用记录，但内容运行时读取和物理 materialization 仍未闭合，造成内容小改也触发全站构建和存储增长。

## 三、目标架构

1. **内容数据平面**：独立内容数据平面当前由 canonical `.content-workspace/content` 与 `content-state/active` 实现；每条记录拥有 `logicalContentId`、`revisionId`、`predecessor`、`schemaVersion`、`sourceHash`、`valueHash`、`status` 和时间。active pointer 只指向当前 ContentSet，不等同于内容历史。
2. **内容历史最小保留**：每个 `logicalContentId` 保留当前 revision 与前两次 revision（最多 3 个）；更早 revision 仅在无引用、无迁移/恢复任务且通过 retention 证据后清理。清理旧 revision 不得影响当前内容。
3. **独立 ContentDataArtifact**：由规范化 ContentSet manifest、变化内容对象和 immutable data URLs 组成；产品 client 不内嵌内容事实，运行时按 active data manifest 读取内容。当前规模使用项目内文件/CAS，不新增 CMS 或外部数据仓。
4. **运行时与激活**：`ProductArtifact` 提供唯一内容读取能力；运行时先校验 `ContentDataArtifact` manifest、对象 hash 和 `active` 指针，再读取内容。新数据未完整写入或校验失败时，active 指针保持旧值，不出现半状态；不得把内容重新烘焙回产品 client。
5. **内容-only 发布**：只写新的 `ContentDataArtifact`、active 指针和最小 receipt，复用现有 `ProductArtifact` 的 JS/CSS。若部署平台必须临时组装上传包，只允许使用 ephemeral staging，禁止 `ProductArtifact` rebuild、持久化完整 client 或把临时包变成新的产品身份。
6. **唯一事实**：canonical 产品源、canonical 内容/媒体、active ContentSet、当前 ProductArtifact manifest、当前 ContentDataArtifact、当前发布最小 receipt。
7. **最小追溯**：Git commit/tag/history；当前持久 receipt 固定保留 `schemaVersion`、`version`、`commit`、`productArtifactId/artifactHash`、`contentDataArtifactId/contentDataHash`、`contentSetId/contentSetHash`、`activePointerHash`、`siteSnapshotId/snapshotHash`、`sitePublicationId/state/phase`、`publicationRunId`、`deploymentId`、`publicVerify` 摘要、`failure/recovery` 摘要、时间和来源/证据 hash。历史记录只保留身份、结果和 provenance，不保留完整旧站副本。
8. **逻辑与物理分离**：logicalContentId、ContentSet、ContentDataArtifact、ProductArtifact、SiteSnapshot/SitePublication 是身份/引用；source/client/upload 仅为可重建 materialization。
9. **内容寻址复用**：相同 namespace、logical identity 和字节 hash 只保存一份；hash 不替代逻辑身份、来源和生命周期。
10. **临时物边界**：preview、product build、content staging、upload-root、QA browser profile 和截图默认位于 session/run 临时目录；成功、失败或中断后均清理 lease、进程和临时物。
11. **无历史回滚副本**：默认不为旧错误版本持久化完整 site snapshot/client；稳定 Git tag/history 和最小身份记录保留。如需旧版本恢复，必须由 Xing 另行授权，并从当前可声明的 source、Git/ProductArtifact manifest、ContentDataArtifact 和 active ContentSet 确定性重建临时物。
12. **引用闭合**：长期记录不得指向已删除的本地物化路径；删除物化后只保留必要 hash/来源/外部 deployment 结果，禁止 dangling reference。

内容更新与产品更新的边界：

| 变化 | 数据层动作 | 产品层动作 |
| --- | --- | --- |
| 内容修改/增加 | 新 revision → ContentSet → 内容发布 | 不生成 ProductArtifact |
| 产品组件/读取能力改变 | 保留原内容，必要时增加 adapter 或迁移 revision | 新 ProductArtifact/产品版本 |
| 内容 schema 改变 | 保留来源，执行可验证迁移并记录 predecessor | 新 schema/adapter 能力 |
| 没有内容 | 不创建空占位，补充内容记录 | 不误判为产品故障 |

## 四、必须实现的行为

- 同一 `ProductArtifact + ContentSet + manifest` 重复发布复用 identity，存储不新增完整站点副本。
- 同一输入重复运行复用 `ContentSet/ContentDataArtifact/ProductArtifact/SiteSnapshot` 和 immutable object identity；若明确再次部署，允许产生新的 `PublicationRun/deployment` 执行记录，但不得复制完整 client；未授权部署不生成新的运行事实。
- 内容只更新变化 target/consumerViews；未变化 entry、媒体、route identity/hash 复用，内容局部更新不生成新的 ProductArtifact，也不重新构建产品 client。
- 内容运行时读取 active ContentDataArtifact；内容数据发布只更新内容 manifest/对象、active pointer 和必要 receipt，产品 JS/CSS 保持原 ProductArtifact identity/hash；未通过 manifest/object hash 校验不得切换 active。
- 发布失败、取消或重试清理 outputRoot、lease、profile 和临时上传目录，但保留最小 `failure/recovery` receipt、attemptId、failure code 和必要证据 hash。
- 新发布、预览和验证唯一依赖当前 source、Git/ProductArtifact manifest、active ContentSet 和 ContentDataArtifact，不依赖历史 `SitePublication`、旧 release 目录、旧 dist 或旧 outputRoot。
- 发布结束只留下当前最小 receipt 与必要 manifest；过程证据按明确 retention 保存，不默认永久保存。
- 清理执行前后均有 root/path-set/bytes/hash/reference/lease 对照；清理不得修改 canonical content、active pointer、当前 ContentSet 或当前官网事实。

## 五、保护与非目标

必须保护：canonical content/media、ContentSlotRegistry、active pointer/ContentSet、每个 `logicalContentId` 的 current+2 revision、当前 ProductArtifact 身份、当前官网发布结果、必要 Git 版本记录。更早 revision 只有在满足 retention、无引用和迁移完成证据后才可处理。

本候选不改页面/IA/schema/正文/审核/media，不新增 CMS 或第二发布器，不把内容发布并入产品 Git，不覆盖现行规则。正式实现时必须同步修订与“历史完整副本/失败 evidence 永久保留”冲突的规则条款：稳定 Git tag/history 和最小失败/recovery receipt 保留；历史完整站点默认不保留；旧版本恢复只由 Xing 授权后确定性重建。

## 六、强制验收 checklist

- `SA-00`：真实内容数据记录包含 `logicalContentId/revisionId/predecessor/schemaVersion/sourceHash/valueHash/status`；每个 logicalContentId 保留 current+2，超出部分只有在 retention、引用和迁移门禁通过后才可处理。schema/adapter 变化必须有真实 fixture（或明确 N/A）：旧 revision/sourceHash 不覆盖，迁移结果 deterministic，predecessor/source/value hash 与 schemaVersion 可追溯，迁移失败不得改变 active/current revision。
- `SA-01`：列出内容 source-of-truth、当前 active ContentSet、当前 ProductArtifact、当前 ContentDataArtifact、当前公网 deployment；内容身份/hash、数据身份/hash 与产品身份/hash 分别核验且全部一致。
- `SA-02`：首次和重复运行使用同一输入时，ContentSet/ContentDataArtifact/ProductArtifact/SiteSnapshot/immutable object identity 复用；若显式再次部署，新的 PublicationRun/deployment 只增加最小 receipt，不新增完整站点副本。
- `SA-03`：只改一个 target 时，仅生成变化 revision/ChangeSet/ContentDataArtifact 对象和受影响 consumerViews；未变化 entry、媒体、route identity/hash 不变，不生成新的 ProductArtifact，不重新构建产品 JS/CSS。
- `SA-04`：build/staging/upload/preview/QA 均为临时物；成功、失败、SIGINT、超时后无孤立 lease、进程、outputRoot、profile 或临时目录，同时保留最小 failure/recovery receipt、attemptId、failure code 和证据 hash。
- `SA-05`：持久化记录严格符合固定 receipt schema；只含 ProductArtifact、ContentDataArtifact、ContentSet、active pointer、结果、外部 deployment/publicVerify、failure/recovery 摘要和必要证据引用；不含完整 client/source/snapshot；无 dangling reference。
- `SA-06`：物理清理是架构实现后的独立、显式授权迁移阶段。删前 root/path-set/bytes/hash/reference/lease 零写入盘点通过；只允许清理超出 current+2 且 unreferenced、unleased、reconstructible 的内容 revision，或同样条件成立的派生物；unknown/external/current publication/registry/active/current+2 revision/current ProductArtifact/必要 receipts 永久保护。
- `SA-07`：删除旧派生物后，从当前 source + Git/ProductArtifact manifest + active ContentSet + ContentDataArtifact 可重新启动、构建、验证和发布；不依赖旧 SitePublication、旧 releases、旧 dist 或旧 outputRoot。
- `SA-08`：连续三次 identical/partial/no-change 运行分别记录 ContentDataArtifact object count、bytes、hash delta 和 ProductArtifact build count；identical 不新增派生对象或完整站点字节，若显式再次部署仅允许最小 receipt；partial 只增加变化内容对象，且 ProductArtifact build count=0、产品 JS/CSS identity/hash/bytes 不变；no-change 的新增输入和 ProductArtifact build count 均为 0，禁止按 run 线性复制整站。若平台要求上传包，必须证明仅为临时 materialization，持久化派生物增量为 0。
- `SA-09`：内容-only 发布保持 ProductArtifact id/hash、JS/CSS bytes/hash 不变，同时官网五路由、内容 manifest、媒体和关键内容公网验证通过；删除过程不改变线上事实。
- `SA-10`：post-action inventory 输出保留对象、删除对象、bytes、hash、reference、retention 和结果；重复执行清理为安全 no-op，且不删除 failure/recovery receipt 或稳定 Git 追溯记录。
- `SA-11`：浏览器使用未变化 ProductArtifact 读取新的 ContentDataArtifact 后，受影响内容可见更新；ContentDataArtifact 激活失败时 active pointer 保持旧值，产品页面不被半状态数据污染。

## 七、基线同步落点

正式版本实现前必须同步以下基线文件，消除旧的“ProductArtifact + active ContentSet 全站组装”语义：

- `AGENTS.md`：产品发布使用 `ProductArtifact + ContentDataArtifact`；`ContentSet` 是内容数据身份/来源，不是每次发布都复制进完整 client 的构建输入。
- `docs/rules/engineering-architecture-and-principles.md`：ProductArtifact、ContentDataArtifact、SitePublication 的身份和物理边界；内容-only 不重建产品 client。
- `docs/rules/iteration-and-release.md`：产品版本与内容数据版本分离；内容-only 发布不生成 ProductArtifact，发布回执记录两者引用。
- `docs/rules/responsibility-and-workflows.md`：`elon ops` 负责内容数据发布；`elon engin` 只在产品能力/schema/renderer 变化时实现产品版本。
- `docs/product/xingbuild 网站产品架构与视觉系统总案.md`：内容数据层、运行时读取和 ProductArtifact 边界（本候选已同步写入）。

同步后的唯一关系是：`ProductArtifact` 提供读取能力，`ContentDataArtifact` 提供内容数据，`SitePublication` 只保存两者引用和发布结果；不得保留两套相互冲突的发布语义。

## 八、完成边界

Engineering 必须先按 `SA-00..SA-11` 完成未提交自 QA；`elon` 逐项验收并回传 `READY_FOR_COMMIT` 后才可提交版本。任一项不成立，候选目标未完成，不得以“inventory/dry-run 已完成”代替架构完成。

物理清理仅在本方案实现并通过本 checklist 后，作为独立且经 Xing 明确授权的迁移阶段执行；清理范围只针对已证明可重建、无外部引用、无 lease 且不属于保护根的旧派生物。

## 九、计划

1. 实现 ContentDataArtifact、运行时读取、CAS 复用、临时物清理和引用闭合。
2. 用内容-only 更新、相同输入、局部变化、无变化、失败/中断连续运行验证产品 client 不重建和存储边界。
3. 对现有旧派生目录执行只读 inventory 与 dry-run，随后按 Xing 授权分批清理。
4. 清理后完成内容-only 重建、产品能力重建和当前官网公网验证，形成最终 evidence。

## 十、独立复核

本次加入 ContentDataArtifact、运行时内容读取、内容-only 发布和基线同步落点后，需由已登记的 `elon1`（threadId=`019ff905-7298-7bf0-b3fb-ba3fc10a40c2`）重新只读复核；此前任何替代 task 的结论不计入正式验收。候选仍待 Xing 确认，未进入 current.md 或 Engineering。
