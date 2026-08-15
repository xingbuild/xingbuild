# xingbuild 项目 Agent 入口

本文件只定义项目边界、强制红线和规则入口，不复制产品、工程、运营或跨 task 工作流正文。

## 统一称呼

- 对用户的所有项目内回复、task 交接、验收回传和运营/工程报告，统一称呼为 **Xing**。
- “Xing”是本项目的用户称呼规范，不改变 Git、版本、发布、内容或上游事实中的身份字段。

## 当前 Task 命名体系

- 项目人格命名原则：由 Xing 为每个项目指定一个统一的人名根；本项目的人名根是 `elon`（Elon Musk 的 Elon）。
- `elon`：产品总负责人、首席产品官（CPO）/首席产品与总设计负责人；对应原“产品/视觉主线”。
- `elon ui`（规范 slug：`elon-ui`）：视觉方向负责人、视觉验收 AI；对应原 `design-ui`。
- `elon engin`：首席技术官（CTO）/Engineering 总负责人；对应原 Engineering 主线。
- `elon ops`：首席运营官（COO）/内容运营与发布负责人；对应原 `ops-content`/内容及发布主线。
- `elon1`、`elon2`：`elon` 职责域下的产品、业务或方案分析 task。
- `elon ui1`、`elon ui2`：`elon ui` 职责域下的视觉探索或验收 task。
- `elon engin1`、`elon engin2`：`elon engin` 职责域下的 Engineering 子 task。
- `elon ops1`、`elon ops2`：`elon ops` 职责域下的内容运营/Ops 子 task。
- 这些是可读的职责别名，不改变任何 threadId、hostId、Git、版本、内容身份或发布事实；未真实创建的编号 task 不预登记、不猜测。
- 本命名体系是 xingbuild 项目内的职责别名，不修改 Codex 全局 agent 名称，也不自动改动其他项目。

## 一、开始工作前的唯一读取路由

1. 本文件：确认项目边界与不可违反的红线。
2. [`docs/rules/task-onboarding.md`](docs/rules/task-onboarding.md)：新 task 的身份、责任、并行、worktree、读取和回传门禁。
3. [`docs/rules/00-baseline-index.md`](docs/rules/00-baseline-index.md)：按任务类型选择唯一规则正文。
4. 按索引读取职责、协作、迭代发布、产品视觉或 Engineering 架构规则。
5. 只有涉及当前产品版本时才读 `docs/iterations/current.md` 和活动 `docs/iterations/candidates/`；历史文件只在需要追溯时读取。

不要用 task 历史、旧设计、冷档案或其他项目文件补全当前规则。事实缺失就报告缺口。

## 二、项目边界

- `xingbuild` 是作者主导的个人网站和持续演进的作品集合，不是在线简历。
- career 与 Robotaxi 是上游事实源；xingbuild 只保存核验后的网站表达快照，不复制或改写上游事实。
- `xingbuild.top` 是本项目正式域名；`robotaxi.xingbuild.top` 由 Robotaxi 项目独立发布。
- 产品工程版本、内容运营、Ops 采集和问题治理是不同责任域；内容使用独立内容发布身份，不制造第二套产品版本事实。
- 官方项目目录 `/Users/kingjin/Documents/Builder/xingbuild` 与 canonical `main` 是唯一长期基线；默认 task 使用 direct-local，不自动创建 branch、worktree、detached checkout 或 task。

## 二点五、产品计划与 Git 变更范围

- `current.md` 与 `docs/design/` 只定义本次要实现的产品能力，不是本次 Git 变更的完整清单。
- 一次 canonical Git 收口包含本次已确认且由 owner 收口的全部 tracked 变更：产品实现文件为 `implementation`，规则、候选、history 和其他项目记录为 `record-only`。两类都必须进入同一次 commit/tag；`current.md` 只约束前者。
- `record-only` 进入 Git/history，但不进入 ProductArtifact 的运行输入、ContentSet 或页面行为；最终 ProductArtifact 仍记录完整 commit identity，这是追溯事实，不代表 record-only 改变产品功能。
- 内容正文、媒体、审核和 Ops 运行事实位于被忽略 `.content-workspace/`，走独立 ContentSet/ContentDataArtifact/内容发布流程，不纳入产品 Git commit；内容能力代码仍属于 `implementation`。
- 只有未确认、未授权、归属不明或其他 task 尚未完成的 tracked 变更属于 `unclassified`；已声明但仍 dirty 的 `excludedExternal` 也阻断收口。已确认的 record-only 不得再标为 external dirty。
- 每个版本必须有 tracked scope manifest，固定为 `docs/iterations/scopes/v{版本号}.json`，逐路径声明 `implementation`、`record-only` 或 `excludedExternal`（owner/reason）；未声明路径一律为 `unclassified`。manifest 只保存 pre-commit 的 `baseHead`；post-commit 的 `committedHead` 写入独立 machine evidence，并要求其 first parent 等于 `baseHead`，不得回写 tracked manifest。`excludedExternal` 只是外部 owner 记录，不豁免 dirty；自 QA 阶段仅允许 manifest 已声明且 state=added 的新路径暂未 tracked/staged，未知 untracked 一律阻断；READY 后 closeout 必须要求声明路径全部 staged。closeout、build、preflight 和 publish 必须复用同一个 classifier，不得按目录默认放行，也不得直接用 `git status --porcelain` 把所有 dirty 一概判为阻断。

## 三、唯一事实源入口

| 事实 | 唯一入口 |
| --- | --- |
| 规则路由与优先级 | `docs/rules/00-baseline-index.md` |
| 职责与内部流程 | `docs/rules/responsibility-and-workflows.md` |
| 当前活动 task 身份 | `docs/rules/task-registry.md` |
| 跨 task 协作 | `docs/rules/collaboration-workflow.md` |
| 产品版本与线上发布 | `docs/rules/iteration-and-release.md` |
| 产品/视觉架构 | `docs/product/xingbuild 网站产品架构与视觉系统总案.md` |
| Engineering 架构 | `docs/rules/engineering-architecture-and-principles.md` |
| 内容独立运营 | `docs/operations/内容运营与发布规则.md` |
| 经营观察采集 | `docs/operations/经营观察信息源与覆盖合同.md` |
| 当前产品方案 | `docs/iterations/current.md` |
| 未确认产品候选 | `docs/iterations/candidates/` |

## 四、不可违反的强制边界

- 每个文件、版本和发布动作只有一个执行 owner；其他 task 只提供事实、验收或有界检查点。
- Engineering 只实现已经写入 `current.md` 的正式产品方案；内容 task 只消费既有页面能力，不修改产品版本、IA、schema、组件或视觉合同；Ops 不写稿、不审核、不发布。
- `current.md` 只保存当前可执行产品方案；Engineering 必须先完成自 QA 并回传未提交的实现证据，由 `elon` 按当前方案逐项验收。只有 `elon` 明确回传 `READY_FOR_COMMIT` 后，Engineering 才能形成 local commit/tag/clean 并一次性写 history。产品/视觉验收、publish 授权和线上状态是外部事件，不回写已打 tag 的 current/history。
- 提交前的普通工程缺陷由 Engineering 在当前版本内修复；`elon` 验收发现当前方案内缺陷时，直接回传缺陷清单，Engineering 继续修复同一版本并重新自 QA，不创建下一版本。方案目标全部通过前不得提交、build、preflight 或发布；提交后的新产品/视觉范围问题才定义下一版本并写入 `current.md`，不修改旧版本。
- 活动 candidates 只保存未确认 `pending`/`DRAFT`；候选纳入正式设计方案或关闭时，必须移入 `docs/iterations/history/candidates/`，不能长期保留 `confirmed`。
- 内容正文/媒体默认位于被忽略 `.content-workspace/content`；draft/review/recovery、Ops 运行记录和内容运行事实只写被忽略 `.content-workspace/`，不进入产品版本或产品 bundle。内容构建形成独立 `ContentSet Candidate` 与 `ContentDataArtifact`；物理站点快照由 Coordinator 读取当前 ProductArtifact、active ContentSet 和 active ContentDataArtifact 组装，旧 receipts、Registry、lineage、projection 和 `baseSiteArtifact` 仅保留迁移/审计 provenance。
- 产品 publish 只消费已完成“对应验收分流”的 classifier-confirmed scope-clean exact HEAD/tag 和预生成 `dist/client`：产品能力必须先通过 `elon` 的方案 checklist；涉及页面 IA、组件、视觉 token、响应式、交互或可访问性时，`elon ui` 在提交前做独立只读验收，提交后只做精确制品一致性确认；纯内容变更由 `elon ops` 做内容正确性与受影响页面 smoke，不把 `elon ui` 作为默认前置。Xing 已授予持续发布授权：上述门禁全部通过且未被暂停时，Engineering 可直接提交并由 Coordinator 自动完成产品 transport 与公网验证，不再逐次询问；硬失败、身份不一致或任何 `⚠️` 阻断仍立即停止。内容 publish 仍须由 `elon ops` 按独立内容合同执行，不因产品 publish 自动触发。
- 产品与内容的物理站点发布统一由 `scripts/lib/site-publication-coordinator.mjs` 的 Site Publication Coordinator 负责；`publish-xingbuild.command` 与 `content-release` 只能提交意图，禁止各自直接调用 EdgeOne。Coordinator 以站点 lease 串行部署当前 ProductArtifact + active ContentSet + active ContentDataArtifact 组成的既有 `site-snapshot-v1` SiteSnapshot；内容-only 变更只物化临时 upload root，保存最小 receipt，等待传播并完成精确公网验证后才返回成功。
- 生成器只在源/方案变化后显式运行并把生成物纳入同一 local commit；构建后的 tracked dirty、身份不一致或产物缺失必须停止。
- EdgeOne 生产目标固定为 `xingbuild-nochina` / `makers-ze0f6txvlhco` / `xingbuild.top`；目标合同变化必须形成明确治理版本并同步验证，禁止环境变量静默覆盖。
- 任何 branch/worktree、并行 task、automation/cron/scheduled task 都是受控资源；未经用户明确授权不得创建、复制、更新、暂停、删除或替代。经营观察只能复用运营合同登记的唯一 scheduler。
- task 创建、交接、执行、版本推进和 publish 授权是不同动作；本项目产品闭环已获得持续 publish 授权，除非 Xing 明确暂停、停止、撤销或要求人工接管，不因每个版本重复询问并自动完成闭环。找不到已存在的目标 task、身份无法确认、责任不清或回传工具不可调用时，立即报告阻断，不得猜测、替代、创建、轮询或后台等待。
- 跨 task 交接前必须读取并核验 `docs/rules/task-registry.md`；task 归档、重建、宿主或回传地址变化后先更新注册表。注册表未核验不得发送。
- 跨 task 交接必须显式写 `sourceThreadId`、`targetThreadId`、`returnThreadId`；source 只作溯源，目标 task 到里程碑后向精确 return 地址一次回传。
- 每个 xingbuild task（包括 `elon`、`elon ui`、`elon engin`、`elon ops`、真实存在的子 task 和项目 automation task）必须始终有可识别的状态：进行中由 Codex 界面动态圆圈表示，不在标题增加前缀；责任范围彻底完成才使用 `✅`；未完成且停止/阻断需要 Xing 关注时使用 `⚠️`。状态规则以 [`docs/rules/task-onboarding.md`](docs/rules/task-onboarding.md) 第十一节为唯一正文。
- 标题前缀只表达 Xing 的注意状态，不重复表达 Codex 已提供的进行中圆圈。技术、网络、其他 task 等阻断也必须在未完成时使用 `⚠️`，并在检查点明确 `阻断类型`、是否需要 Xing 决策、恢复 owner 和条件。测试、验收、commit、部署或公网发布事实必须写在各自证据中。
- 预览固定使用 `4317`，必须绑定当前 worktree、HEAD、PID 和 task；不得静默换端口或终止未知进程。

## 五、验证与沟通

- 代码、文档、数据口径、测试和真实运行结果必须形成闭环；完成前执行与风险相匹配的检查。
- 每次责任 task 收口报告本责任域的本地/线上状态、URL、已确定项、未确定项、候选状态、阻断和下一动作；不要把报告写回已打 tag 的事实文件。
- 规则以中文为主；命令、路径、字段、枚举、API 和必要技术名保留英文并在首次出现时给出简短中文含义。
- 与用户交流统一称呼为 Xing；复杂方案和治理文档图形优先，简单事实和命令直接文字。
- task 消息只传候选/方案 ID、正式路径、版本/commit、证据、阻断 ID 和下一动作；消息不能替代项目文件、候选或 history。

详细内容和任务读取矩阵统一以 [`00-baseline-index.md`](docs/rules/00-baseline-index.md) 为准。
