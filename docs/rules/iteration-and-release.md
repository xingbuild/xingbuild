# xingbuild 迭代与发布规则

状态：生效。本文只负责产品工程版本从正式方案到线上证据的生命周期、验证、Git、部署和回退；职责正文见 [`responsibility-and-workflows.md`](responsibility-and-workflows.md)，跨 task 消息见 [`collaboration-workflow.md`](collaboration-workflow.md)，内容和 Ops 见 `docs/operations/`。

## 1. 产品工程闭环

```mermaid
flowchart LR
    A["正式产品方案\ncurrent.md"] --> B["Engineering\n实现 + 自 QA"]
    B --> C["local commit + annotated tag + clean"]
    C --> D["history\n不可变版本事实"]
    D --> E["产品/视觉验收"]
    E -->|有问题| F["下一版本方案\ncurrent.md"]
    F --> B
    E -->|通过| G["既有持续发布授权生效"]
    G --> H["SitePublication Coordinator：串行 transport → 公网验证"]
```

版本号用于可辨识的产品能力、页面结构、内容模型、视觉系统、作品详情、共享展示能力或发布架构变化；局部快速修订可合并后形成一个稳定版本，不为每次对话或未完成试验增加版本。

## 2. 事实源和范围

- 上游事实：career、Robotaxi 的权威事实源；xingbuild 只保存核验后的网站表达快照。
- 产品/视觉事实：`docs/product/xingbuild 网站产品架构与视觉系统总案.md`。
- 当前正式方案：`docs/iterations/current.md`；未确认候选：`docs/iterations/candidates/`；历史版本和候选归档：`docs/iterations/history/`。
- 工程事实：代码、测试、Git commit/tag、构建产物、EdgeOne 部署和公网 manifest，按不同阶段分别记录。
- 内容事实：`docs/operations/内容运营与发布规则.md`；经营观察采集事实：`docs/operations/经营观察信息源与覆盖合同.md`。它们不进入产品版本闭环。

本文不复制上述文件的职责正文。发生冲突时，按 [`docs/rules/00-baseline-index.md`](00-baseline-index.md) 的优先级和 owner 处理；不通过旧 task 消息猜测缺失事实。

## 3. 当前版本和候选入口

唯一当前指针是 `docs/iterations/current.md`。它只记录当前可执行产品方案，不保存 `pending`/`complete`、验收、授权或线上状态字段。

版本开始至少写明：问题、范围、明确不做、页面/对象/工程文件、验收标准和当前正式方案。Engineering 只实现已写入 current 的范围；活动候选不是实现清单。候选文件与版本实现范围分开判定：版本期间新增或修改、且 owner 确认必须保留的 tracked candidate，可以作为 `record-only` 纳入同一版本 commit/history；它仍保持 `DRAFT`，不进入 `current.md`、Engineering、ProductArtifact 或发布范围。未获 owner 收口的外部 dirty candidate 仍阻断 closeout。

候选属于产品设计前阶段：

- 活动目录只保留未确认 `pending`/`DRAFT`；已转化或关闭的候选必须进入 `docs/iterations/history/candidates/` 并保留来源、目标版本、方案路径和理由。
- 当前版本完成后由产品与视觉 task 清点候选；已确认候选先转正式设计方案、写入 current，再在同一动作中归档来源候选。
- 提交后产品/视觉验收问题不走普通候选，直接定义下一 patch/小迭代/大迭代并写入 current；不回写旧版本。

## 4. 本地版本收口

Engineering 按以下顺序形成一个本地提交版本。最终 ProductArtifact 必须绑定提交后的精确 HEAD/tag：

1. `npm run release:prepare` 与分层 QA：项目结构、页面能力、内容兼容性和相关业务检查；
2. 暂存预计范围，执行 `npm run release:closeout-check`；
3. 创建本地 commit 和同名 annotated tag，确认 `HEAD == tag.peeledCommit` 且 tracked clean；
4. 在该精确 HEAD/tag 上执行最终 `npm run release:build`，生成 ignored `dist/client` ProductArtifact；
5. 执行 `npm run release:preflight`，同时校验 Git/版本和 ProductArtifact 三份 manifest 的身份、hash 与确定性；
6. 只有 preflight 通过的同一 ProductArtifact 才能进入与变更影响面匹配的验收分流和 transport。

closeout 必须按路径、owner 和版本范围核对 tracked dirty：实现变更进入实现范围；已确认保留的 candidate 以 `record-only` 纳入暂存范围并在 history 留下路径、状态和“不进入本版本实现”的说明；未分类或外部 owner dirty 继续硬阻断。`git clean` 表示所有要保留的 tracked 变更都已被明确归类，不表示候选文件不能出现在版本提交中。当前检查器尚未提供 path-level scope lock 时，不得绕过门禁，需先登记治理缺口并由 owner 收口。

Engineering 同一轮一次性更新 `VERSION.md`、`current.md` 和 `docs/iterations/history/v{版本号}.md`；history 记录版本号、commit、annotated tag、clean、父版本、范围和验收合同，提交后不可回写。

生成器 `architecture:views`、`framework:data`、`framework:layout`、`article:figures` 只在源/方案变化后、local commit 前显式运行并把输出纳入同一提交。`build`、`release:prepare`、`release:build`、`release:check` 和 publish 不无条件调用会回写 tracked 输出的生成器；构建后 tracked dirty 是硬阻断。`release:build` 只负责确定性构建与身份产物；`release:qa` 保留 Mermaid/Puppeteer、桌面/手机等环境型 QA，环境 incident 单独记录，不得伪装成产品实现失败。

## 5. 本地预览与验证

- 标准启动入口：`./start-xingbuild.command`；固定预览 `http://127.0.0.1:4317/`。
- 预览资源必须绑定当前 worktree、HEAD、版本、PID 和 task；端口冲突或归属不明时停止，不换端口、不终止未知进程。
- 涉及页面 IA、组件、视觉 token、响应式、交互或可访问性变化时，必须做桌面和手机真实页面验证；纯内容变更只做受影响页面的内容/溢出 smoke，构建通过不等于对应验收通过。
- `npm run release:check` 仅作兼容性/诊断命令，不替代四阶段门禁，不由 transport publish 调用。

## 6. 产品线上发布

入口：

```bash
./publish-xingbuild.command
```

产品 publish 是线上 transport 意图入口，不是版本创建器或业务执行器。它只消费已完成对应验收分流的现有 clean `main` HEAD、annotated tag 和预生成 `dist/client`，不得自动递增版本、写 package/VERSION/current/history、commit、tag、修复脏改或运行网站业务逻辑；整站物理发布统一由 `SitePublication Coordinator` 负责。

transport 顺序固定：

1. 读取 source cwd、`current.md`、`VERSION.md`、package、history、HEAD/tag，确认版本身份一致；
2. 确认官方 direct-local clean `main`，记录 source HEAD；
3. 校验 `dist/client/release.json` 与版本/commit 匹配；
4. 执行 `release:preflight`；
5. Xing 已授予产品闭环持续发布授权；产品/视觉验收通过后，Engineering 直接使用显式 `--authorize-publish` 执行，不再逐次向 Xing 询问；除非 Xing 明确暂停、停止、撤销或要求人工接管，否则自动完成后续 push、deploy、public verify；硬失败仍立即停止；
6. 由协调器将当前 ProductArtifact 与 active `ContentSet` 合并为一个 `SiteSnapshot`，取得站点 lease 后部署到固定 EdgeOne 目标：`name=xingbuild-nochina`、`projectId=makers-ze0f6txvlhco`、`domain=xingbuild.top`；
7. 持久化 machine-readable deployment JSON，按有界退避等待传播，校验 `release.json`、`content-manifest.json`、目标页面/媒体与 active/candidate 集合；
8. 只有 `SitePublication` finalized 才报告线上统一产品和内容结果；Deploy Success、push 或单页 HTTP 200 均不等于完成。

失败立即停止并保留未发布/部分完成事实；不得继续后续阶段或写入完成声明。push 成功而 deploy/verify 失败时，只报告“代码已同步、网站未上线”。EdgeOne 目标合同未来若需调整，必须在新治理版本中同时更新本文件、发布脚本、测试和目标验证；旧目标和历史证据不得静默改写。

## 7. 内容运营边界

内容 Observation、Article、Practice、Profile、Business Observation 和不改变页面能力的 B 端产品内容不进入产品版本；它们使用独立 `ContentSet Candidate`、ignored `.content-workspace/` 和独立运营生命周期。内容 task 不读取当前产品 HEAD/tag 作为内容身份，不创建产品 commit/tag；它提交 ContentSet Candidate 给唯一 `Site Publication Coordinator`，由协调器选择当前稳定 ProductArtifact 并与 active ContentSet 组装 SiteSnapshot，不使用旧产品 dist 作为内容事实。详细阶段、日志和内容事实以内容运营规则为准。

产品与内容可以独立准备，但不能并行 transport：产品 transport 中 ContentSet Candidate 保持 queued；内容 transport 中 ProductArtifact 保持未部署。产品方案必须声明 `contentImpact`、`affectedTargets`、`affectedRoutes`、`affectedFields` 和 `compatibilityEvidence`，缺失或为 breaking/unknown 时发布前形成 Product Incident 并阻断。产品能力只要保持已有 content slot 合同，内容无需重新准备；删除或改变被使用的必需 slot 时，必须先完成产品版本迁移或合法 fallback。

详细内容准备、审核、构建、发布、失败保留 draft/review/recovery 和公网内容验收只以 [`docs/operations/内容运营与发布规则.md`](../operations/内容运营与发布规则.md) 为准。经营观察定时/按需采集只以 [`docs/operations/经营观察信息源与覆盖合同.md`](../operations/经营观察信息源与覆盖合同.md) 为准；内容 task 不得创建、复制或替代 scheduler。

## 8. Publish Incident 故障决策门

任一 prepare、build、closeout、preflight 或 SitePublication transport/verify 阶段失败，立即停止。协调器只提交一份最小故障检查点（可追加到 `docs/qa/`，不回写已打 tag 的 current/history）：

```text
Publish Incident
失败阶段：prepare | build | closeout | preflight | transport-push | transport-deploy | public-verify
事实证据：命令、HEAD/tag、工作区 dirty paths、manifest、远端/EdgeOne/公网响应
根因分类：产品验收问题 | 工程实现 | CLI/工具 | prepare/build | transport | 环境
影响：已完成与未完成的阶段、线上是否变化
方案：可选修复或回退路径
推荐：唯一推荐动作及理由
owner：唯一执行责任人/task
授权：已有授权、缺失授权或需用户重新授权
下一动作：停止条件解除前不得继续发布
```

固定路由：产品验收问题进入下一版本；工程实现问题在当前未提交版本内修复；CLI/工具问题登记候选评审；prepare/build 问题回准备阶段修复；transport 问题修发布执行器；环境问题由环境责任人解除。

## 9. 产品版本状态和报告

产品工程阶段严格区分：实现完成、本地验证完成、本地提交版本完成、可发布、部署完成、域名生效、公网验收完成。前一状态不能替代后一状态。

每次产品/视觉或 Engineering 收口报告：本地版本状态、本地 URL、线上版本状态、线上 URL、已确定项、未确定项、候选状态、阻断 ID、下一动作和授权边界。内容与 Ops 按自己的合同报告内容身份或采集状态，不把运营状态写成产品版本状态。

## 10. Git、域名与回退

- 本地 Git 是差异、历史、回退和稳定版本事实源；GitHub 是远程备份/协作；EdgeOne 是生产部署和公网运行事实源。
- 本地 commit/tag 不等于 push；push 不等于部署；部署不等于公网验收。产品 publish 不创建或移动 tag。
- `xingbuild.top` 是正式主域名，`www.xingbuild.top` 只跳转到主域名，`robotaxi.xingbuild.top` 由 Robotaxi 独立发布；两个项目不共用构建产物、发布脚本或版本号。
- 不删除稳定 tag/history。线上问题优先回退到上一个成功部署，并记录失败版本、现象、影响范围和修复条件；未完成公网验证前不宣称恢复。
