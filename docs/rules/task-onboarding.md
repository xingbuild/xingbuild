# xingbuild 新 Task 入场协议

状态：生效。本文是新 task 的入场与分流说明，不替代 AGENTS.md、规则正文、current.md 或任何内容/发布合同。

适用范围：所有在 xingbuild Project 中新建的产品、视觉、Engineering、内容、Ops、治理、QA 或只读分析 task。

## 一、给新 task 的第一条指令

新 task 启动后，先执行以下顺序：

```text
你是 xingbuild 的新 task。先完整读取：
1. /Users/kingjin/Documents/Builder/xingbuild/AGENTS.md
2. /Users/kingjin/Documents/Builder/xingbuild/docs/rules/task-onboarding.md
3. /Users/kingjin/Documents/Builder/xingbuild/docs/rules/00-baseline-index.md

然后根据你的责任域读取本文件第五节列出的专门规则。
在上述入口之后，所有 task 还必须读取：

`/Users/kingjin/Documents/Builder/xingbuild/docs/rules/xing-workstyle-and-context.md`

该文件记录 Xing 的稳定工作习惯、上下文恢复方式和复杂度控制边界；它不是产品版本方案，也不替代责任域规则。

先报告：你的 task 名称、threadId、责任域、允许范围、禁止范围、待读取事实源。
在责任和写入权限明确前，只做只读检查，不修改文件、不创建 branch/worktree/task、不发布、不轮询等待。
```

本文件的绝对路径是：

`/Users/kingjin/Documents/Builder/xingbuild/docs/rules/task-onboarding.md`

## 二、先区分四个对象

| 对象 | 负责什么 | 是否复制项目文件 | 默认用法 |
| --- | --- | --- | --- |
| Project | 组织相关 task、文件和项目指令 | 否 | 所有 xingbuild task 归入官方 Project |
| Task / Chat | 一段独立对话、责任和回传地址 | 否 | 一个目标一个 task，不混合多个结果 |
| Direct-local | 使用 canonical 项目目录 | 否 | 只读分析、统一决策、串行实现 |
| Branch / Worktree | 独立 Git 分支和 checkout | 是 | 只有并行代码实现或高风险隔离时使用 |

Project、task 和 worktree 不是互相替代的概念。多个 task 可以共享项目规则和文件，但不会自动共享完整聊天记录；需要共享的事实必须写入项目文件，或通过明确的结构化 handoff 交接。

## 三、当前唯一基线与只读初检

长期基线固定为：

```text
canonical cwd: /Users/kingjin/Documents/Builder/xingbuild
canonical branch: main
preview port: 4317
```

新 task 首次只读检查：

```bash
pwd
git status --short --branch
git worktree list --porcelain
git log -1 --oneline --decorate
```

必须把检查结果作为首个 checkpoint 的事实，不把 task 历史、聊天摘要或其他 checkout 当成当前事实源。

## 四、先声明责任域，再决定能否写入

| 责任域 | 可以负责 | 默认禁止 |
| --- | --- | --- |
| elon | 产品判断、产品总案、candidate、current.md、视觉验收边界 | 直接改产品代码、VERSION、tag、内容事实或发布状态 |
| elon engin | 已批准 current.md 的代码、测试、VERSION、history、commit/tag/clean、发布意图 | 自行改变产品目标、擅自创建协作资源、直接调用 EdgeOne |
| elon ui（slug：elon-ui） | 读取本地/公网证据并给出独立 Verdict | 修改代码、方案、版本、内容或发布 |
| elon ops | ContentSet、正文、媒体、审核和内容 transport intent | 改产品 IA、schema、组件、视觉、VERSION 或 tag |
| elon ops 子 task（采集） | 来源、EvidenceCandidate、覆盖证据、运行记录 | 写稿、审核、发布、改产品代码 |
| 只读分析 task | 事实核查、方案比较、风险和验收建议 | 修改任何项目事实 |

同一文件、版本、内容身份、发布动作只有一个 owner。责任不清时停止并报告，不猜测、不替代。

## 五、按责任域的最小必读清单

所有 task 固定读取：

```text
AGENTS.md
docs/rules/task-onboarding.md
docs/rules/00-baseline-index.md
docs/rules/xing-workstyle-and-context.md
```

之后按责任域读取：

| 责任域 | 必读追加文件 | 按需读取 |
| --- | --- | --- |
| 治理/协作 | docs/rules/responsibility-and-workflows.md、docs/rules/collaboration-workflow.md、docs/rules/task-registry.md | 当前 task 证据 |
| 产品/视觉 | responsibility-and-workflows.md、iteration-and-release.md、docs/product/xingbuild 网站产品架构与视觉系统总案.md | docs/iterations/current.md、活动 candidates、相关证据 |
| Engineering | responsibility-and-workflows.md、collaboration-workflow.md、iteration-and-release.md、engineering-architecture-and-principles.md | current.md、相关代码/测试 |
| 内容发布 | responsibility-and-workflows.md、docs/operations/内容运营与发布规则.md、产品总案 | 当前 ContentSet、审核、媒体 manifest |
| Ops 采集 | responsibility-and-workflows.md、docs/operations/经营观察信息源与覆盖合同.md | 来源注册表、EvidenceCandidate |
| 视觉验收 | responsibility-and-workflows.md、产品总案、当前正式方案 | 截图、DOM、axe、公网 manifest |

涉及跨 task 发送或接收时，必须额外读取并核验 docs/rules/task-registry.md。不能从 delegation 的 source_thread_id 推断 targetThreadId 或 returnThreadId。

## 六、并行模型：多个想法可以并行，写入必须串行

推荐结构：

```text
Xing
├─ elon1 / elon2：elon 的产品/业务/方案子 task，只读
├─ elon ui：视觉方向总负责人，只读验收
│  └─ elon ui1 / elon ui2：视觉子 task，只读
├─ elon engin：Engineering 总负责人
│  └─ elon engin1 / elon engin2：Engineering 子 task
├─ elon ops：内容运营与发布总负责人
│  └─ elon ops1 / elon ops2：运营子 task
└─ elon：canonical main 的统一产品/架构 owner
   └─ elon engin：一次只保留一个版本实现写入通道
```

执行规则：

1. 多个想法 task 可以同时存在，但默认只读，不创建 worktree。
2. 每个想法 task 只返回问题、对象、影响范围、方案、风险、验收和未决问题。
3. canonical 产品主线统一评审，决定合并、否决、形成 candidate 或写入 current.md。
4. 只有正式方案进入 current.md 后，Engineering 才能实现。
5. 同一时间不允许两个 task 写 canonical main，也不允许两个 task 同时修改 current.md、VERSION、tag 或 active ContentSet。
6. 内容、产品工程和物理发布可以各自准备，但实际 SitePublication/EdgeOne transport 始终由 Coordinator 串行执行。

## 七、Direct-local 与 Worktree 选择规则

### 默认：Direct-local

适用于只读分析、产品决策、视觉复核、串行 Engineering 和规则核查。优点是没有重复文件、不会出现 stale checkout；前提是 task 不写入共享目录。

### 例外：短生命周期 Worktree

只有以下情况才可以使用：

- Xing 已明确授权并行代码实现；
- 需要高风险实验而不能污染 canonical main；
- Engineering 已记录明确的目的、owner、起始 HEAD 和清理条件。

创建前必须记录：

```text
worktree path
branch
canonical HEAD
责任 task/threadId
允许修改范围
禁止动作（尤其是 content publish/transport）
清理条件
```

Worktree 不能用于“只是讨论”。不得把不同 worktree 的 .content-workspace、dist、缓存、preview 进程或发布证据混在一起；不得从一个 worktree 手工复制 ignored 内容到另一个 worktree 伪造事实。完成、合并或放弃后，先核对 dirty 状态和证据归属，再清理 worktree。

## 八、跨 task handoff 的唯一格式

交接前必须确认注册表中的身份，并一次发送：

```text
交接类型：handoff | ACK | milestone
project：xingbuild
canonical：<绝对路径> / <HEAD>
sourceThreadId：<来源 task>
targetThreadId：<已核验目标 task>
returnThreadId：<已核验回传 task>
事实源：<current/candidate/方案/代码/证据路径>
允许范围：<本次可以做什么>
禁止范围：<本次不能做什么>
验收条件：<完成的可验证定义>
阻断：<无或阻断 ID>
下一动作/授权方：<明确动作>
```

目标 task 到达里程碑后向精确 returnThreadId 回传一次；没有新事件时不轮询、不 sleep、不重复等待。消息不能替代项目文件、candidate、current 或 machine evidence。

## 九、标准收口回传

每个 task 结束时只报告自身责任域：

```text
名称（threadId=...）
责任域：...
本地身份/HEAD：...
线上或内容身份：...
已完成证据：...
未完成/阻断：...
候选/current 状态：...
未执行动作：...
下一动作/授权方：...
```

必须区分：已分析、已确认、已实现、已测试、已验收、已提交、已部署、已公网验证。HTTP 200 或 deployment success 不能单独称为发布成功。

## 十、统一停止条件

遇到以下情况立即停止越界动作并报告：

- 事实源缺失、规则冲突或 owner 不明；
- 目标 task、threadId、hostId 或 returnThreadId 无法核验；
- 需要创建/删除 task、branch、worktree、automation 或 scheduler；
- 需要修改旧版本、已发布内容、active ContentSet 或线上状态；
- 需要绕过 clean/preflight/Coordinator/publicVerify 门禁；
- 需要用户作出产品、破坏性清理或外部授权决定。

“待用户授权”是明确停止事实，不是后台等待。条件解除后由新的用户指令或正式检查点恢复。

## 十一、Task 注意状态标记

任务标题前缀是 Xing 在 Codex 任务列表中判断“是否需要介入”的唯一可见标记；它不替代本文件、`task-registry.md`、current、candidate、machine evidence 或发布状态。

| 状态 | 标记 | 使用条件 |
| --- | --- | --- |
| 正在执行或可继续 | 不加前缀 | 由 Codex 界面动态圆圈表达进行中，不重复增加标题标记 |
| 责任范围彻底完成 | `✅` | task 的全部约定交付已完成，没有未完成项或恢复条件 |
| 未完成/阻断需关注 | `⚠️` | task 停止在完整交付之前；必须同时写明阻断类型和是否需要 Xing 决策 |

强制规则：

1. 每个实际存在的 xingbuild task（含项目 automation task）都必须始终维护自己的状态；开始/恢复移除 `✅`/`⚠️`，由 Codex 动态圆圈表示进行中；只有责任范围彻底完成才改为 `✅`；任何未完成的停止或阻断改为 `⚠️`。进行中无标题前缀不是无状态，而是使用 Codex 原生状态。
2. 标题只能有一个状态前缀；更新时保留职责别名和原有语义，不把整段 delegation、版本事实或错误摘要塞进标题。
3. `⚠️` 表示“责任范围尚未完成且当前停止/阻断”，不等于一定需要 Xing 决策；检查点必须写明 `阻断类型=user-decision|technical|network|external-task|scope`、是否需要 Xing 决策、证据和恢复 owner。
4. `✅` 不等于测试通过、产品验收、commit、部署或公网发布；它只表示该 task 自身约定交付已彻底完成，这些工程事实仍必须在各自证据中记录。
5. 标记只维护 Codex task 标题，不写入 `current.md`、版本 history、ContentSet、SitePublication 或内容事实；`task-registry.md` 继续只维护身份、通信地址和 active/archived 生命周期。
6. 跨项目同步只能迁移这套“注意力表达目的”和状态含义，不复制其他项目的事实、标题或规则正文。

### 11.1 强制状态转换与阻断分类

状态转换是 task 的收口动作，不是可选的文字习惯：

| 事件 | task 标题动作 | 回传必须补充 |
| --- | --- | --- |
| 开始/恢复执行 | 移除 `✅`/`⚠️` | 当前目标与下一里程碑；由 Codex 动态圆圈表示进行中 |
| 仍可继续处理 | 保持无前缀 | 已完成/未完成与下一动作 |
| 责任范围彻底完成 | 添加 `✅` | 已完成证据、未执行动作、下一触发条件 |
| 未完成且停止/阻断 | 添加 `⚠️` | `阻断类型`、是否需要 Xing 决策、证据、恢复 owner/条件 |

每个 task 必须在以下节点执行一次自检并更新标题：首次开始、恢复、交接后、用户新指令改变范围、阻断、最终回传。源 task 发送一次交接后必须结束当前回合，不通过轮询维持“进行中”；目标 task 在里程碑回传时自行更新标题。状态前缀只能有一个，不能叠加或保留旧状态；无前缀仅在 task 正在运行并由 Codex 动态圆圈可见时有效。
