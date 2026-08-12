# xingbuild 项目 Agent 入口

本文件只定义项目边界、强制红线和规则入口，不复制产品、工程、运营或跨 task 工作流正文。

## 统一称呼

- 对用户的所有项目内回复、task 交接、验收回传和运营/工程报告，统一称呼为 **Xing**。
- “Xing”是本项目的用户称呼规范，不改变 Git、版本、发布、内容或上游事实中的身份字段。

## 一、开始工作前的唯一读取路由

1. 本文件：确认项目边界与不可违反的红线。
2. [`docs/rules/00-baseline-index.md`](docs/rules/00-baseline-index.md)：按任务类型选择唯一规则正文。
3. 按索引读取职责、协作、迭代发布、产品视觉或 Engineering 架构规则。
4. 只有涉及当前产品版本时才读 `docs/iterations/current.md` 和活动 `docs/iterations/candidates/`；历史文件只在需要追溯时读取。

不要用 task 历史、旧设计、冷档案或其他项目文件补全当前规则。事实缺失就报告缺口。

## 二、项目边界

- `xingbuild` 是作者主导的个人网站和持续演进的作品集合，不是在线简历。
- career 与 Robotaxi 是上游事实源；xingbuild 只保存核验后的网站表达快照，不复制或改写上游事实。
- `xingbuild.top` 是本项目正式域名；`robotaxi.xingbuild.top` 由 Robotaxi 项目独立发布。
- 产品工程版本、内容运营、Ops 采集和问题治理是不同责任域；内容使用独立内容发布身份，不制造第二套产品版本事实。
- 官方项目目录 `/Users/kingjin/Documents/Builder/xingbuild` 与 canonical `main` 是唯一长期基线；默认 task 使用 direct-local，不自动创建 branch、worktree、detached checkout 或 task。

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
- `current.md` 只保存当前可执行产品方案；Engineering 形成 local commit/tag/clean 后一次性写 history。产品/视觉验收、publish 授权和线上状态是外部事件，不回写已打 tag 的 current/history。
- 提交前的普通工程缺陷由 Engineering 在当前版本内修复；提交后的产品/视觉验收问题直接定义下一版本并写入 `current.md`，不修改旧版本、不重新创建普通候选。
- 活动 candidates 只保存未确认 `pending`/`DRAFT`；候选纳入正式设计方案或关闭时，必须移入 `docs/iterations/history/candidates/`，不能长期保留 `confirmed`。
- 内容正文/媒体默认位于被忽略 `.content-workspace/content`；draft/review/recovery、Ops 运行记录和内容运行事实只写被忽略 `.content-workspace/`，不进入产品版本或产品 bundle。内容构建形成独立 `ContentSet Candidate`；物理站点快照由 Coordinator 读取当前 ProductArtifact 与 active ContentSet 组装，旧 receipts、Registry、lineage、projection 和 `baseSiteArtifact` 仅保留迁移/审计 provenance。
- 产品 publish 只消费已完成产品/视觉验收的现有 clean HEAD/tag 和预生成 `dist/client`；Xing 已授予持续发布授权，验收通过后 Engineering 直接执行；Xing 明确暂停/撤销时立即停止。不得自动递增版本、回写版本文件、commit、tag、修复脏改或运行网站业务逻辑。
- 产品与内容的物理站点发布统一由 `scripts/lib/site-publication-coordinator.mjs` 的 Site Publication Coordinator 负责；`publish-xingbuild.command` 与 `content-release` 只能提交意图，禁止各自直接调用 EdgeOne。Coordinator 以站点 lease 串行部署当前 ProductArtifact + active ContentSet 组成的 SiteSnapshot，保存 deployment JSON，等待传播并完成精确公网验证后才返回成功。
- 生成器只在源/方案变化后显式运行并把生成物纳入同一 local commit；构建后的 tracked dirty、身份不一致或产物缺失必须停止。
- EdgeOne 生产目标固定为 `xingbuild-nochina` / `makers-ze0f6txvlhco` / `xingbuild.top`；目标合同变化必须形成明确治理版本并同步验证，禁止环境变量静默覆盖。
- 任何 branch/worktree、并行 task、automation/cron/scheduled task 都是受控资源；未经用户明确授权不得创建、复制、更新、暂停、删除或替代。经营观察只能复用运营合同登记的唯一 scheduler。
- task 创建、交接、执行、版本推进和 publish 授权是不同动作；本项目产品闭环已获得持续 publish 授权，除非 Xing 明确暂停、停止、撤销或要求人工接管，不因每个版本重复询问并自动完成闭环。找不到已存在的目标 task、身份无法确认、责任不清或回传工具不可调用时，立即报告阻断，不得猜测、替代、创建、轮询或后台等待。
- 跨 task 交接前必须读取并核验 `docs/rules/task-registry.md`；task 归档、重建、宿主或回传地址变化后先更新注册表。注册表未核验不得发送。
- 跨 task 交接必须显式写 `sourceThreadId`、`targetThreadId`、`returnThreadId`；source 只作溯源，目标 task 到里程碑后向精确 return 地址一次回传。
- 预览固定使用 `4317`，必须绑定当前 worktree、HEAD、PID 和 task；不得静默换端口或终止未知进程。

## 五、验证与沟通

- 代码、文档、数据口径、测试和真实运行结果必须形成闭环；完成前执行与风险相匹配的检查。
- 每次责任 task 收口报告本责任域的本地/线上状态、URL、已确定项、未确定项、候选状态、阻断和下一动作；不要把报告写回已打 tag 的事实文件。
- 规则以中文为主；命令、路径、字段、枚举、API 和必要技术名保留英文并在首次出现时给出简短中文含义。
- 与用户交流统一称呼为 Xing；复杂方案和治理文档图形优先，简单事实和命令直接文字。
- task 消息只传候选/方案 ID、正式路径、版本/commit、证据、阻断 ID 和下一动作；消息不能替代项目文件、候选或 history。

详细内容和任务读取矩阵统一以 [`00-baseline-index.md`](docs/rules/00-baseline-index.md) 为准。
