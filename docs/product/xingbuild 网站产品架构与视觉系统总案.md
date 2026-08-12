# xingbuild 网站产品架构与视觉系统总案

> 状态：正式产品与视觉基线（唯一现行主文档）
> 责任：xingbuild 产品与视觉 task 维护；Engineering 只实现已经确认并进入当前迭代的能力
> 更新时间：2026-08-05
> 适用版本：现有结构持续有效；统一冷白视觉与页面组合增量从 `v0.25.9` 实施
> 说明：本文档不是产品版本号，也不是内容发布版本号。它是网站产品结构、视觉系统、内容对象与能力边界的统一依据。

## 0. 唯一事实源与阅读方式

从本文件发布以后，网站产品结构、页面责任、内容对象、视觉语言、响应式合同和可复用展示能力，只以本文件为现行产品/视觉依据。

本项目的文档职责分开，不互相复制正文：

| 文档或目录 | 责任 | 与本文件的关系 |
| --- | --- | --- |
| `docs/product/xingbuild 网站产品架构与视觉系统总案.md` | 产品目标、信息架构、页面责任、内容对象、视觉系统、展示能力 | 唯一现行产品/视觉主文档 |
| `AGENTS.md` | 项目边界和强制入口 | 只引用本文件，不复制产品/视觉正文 |
| `docs/rules/00-baseline-index.md` | 规则优先级、五层结构和按任务类型读取 | 不复制任何规则正文 |
| `docs/rules/iteration-and-release.md` | 产品版本、Git、部署和回退规则 | 工程发布事实源，不由本文替代 |
| `docs/rules/responsibility-and-workflows.md` | 责任域与内部产品工程流程 | 只维护责任和分流，不由本文替代 |
| `docs/rules/collaboration-workflow.md` | 跨 task 一次性交接和回传 | 只维护协作消息，不由本文替代 |
| `docs/iterations/current.md` | 唯一当前工程迭代指针 | 只记录正在实施的版本 |
| `docs/iterations/candidates/` | 产品设计前的未确认候选入口 | 只保留 pending/DRAFT，不定义 Engineering 授权 |
| `docs/iterations/history/candidates/` | 已转化或已关闭候选的历史归档 | 只保留来源、转化/关闭结果和证据，不参与当前决策 |
| `docs/iterations/history/` | 已完成版本的计划和结果 | 只用于追溯，不重新定义当前产品 |
| `docs/qa/` | 版本或问题的验证证据 | 证明某次验收，不是长期设计源 |
| `docs/operations/` | 日常采集、审核和发布操作合同 | 不存产品视觉正文 |
| `docs/upstream/` | career、Robotaxi 等上游事实快照 | 提供事实，不提供网站 UI 决策 |
| `docs/design/` | 已确认的正式版本方案、视觉系统与验收合同 | 不得存放未确认 DRAFT |

事实冲突时按以下顺序处理：

1. 上游事实仍以 career、Robotaxi 的权威源为准；
2. 网站产品与视觉决策以本文为准；
3. 工程执行和发布门禁以 `docs/rules/iteration-and-release.md` 为准；责任与协作按 `docs/rules/00-baseline-index.md` 路由；
4. 版本实施状态以代码、`current.md`、Git 和真实部署证据为准；
5. 历史方案不得覆盖本文已经确认的当前决策。

任何 task 都不得因为找到了旧方案，就重新引入已被当前基线淘汰的页面结构、视觉规则或图形运行时。

## 1. 产品定位与根本目标

`xingbuild` 是作者主导的个人网站和持续演进的作品集合，不是在线简历，也不是自动工程活动日志。

网站把三类长期内容连接成一个对外阅读入口：

```text
持续观察与判断
        ↓
形成方法、系统和作品
        ↓
用经历、结果和证据说明能够提供的价值
```

网站需要让读者逐步回答：

1. 作者是谁，当前关注什么；
2. 作者能够解决哪些企业经营与数字化问题；
3. 这些判断由哪些经历、作品和事实支持；
4. Robotaxi 等作品的真实边界是什么；
5. 读者应该继续阅读、进入作品，还是查看/下载作者简历。

网站不直接宣称成长、社会价值或长期自我记录等内部解释，而通过持续内容、作品质量和证据让读者自行形成判断。

## 2. 当前产品状态

### 2.1 已经工程化并公开使用

当前公开基线已形成以下稳定能力：

| 能力 | 当前实现 | 内容更新是否需要产品迭代 |
| --- | --- | --- |
| 全站 SiteShell、Header、Footer、sticky 状态 | `LayoutShell`、`SiteHeader`、`SiteFooter`、共享 token | 否 |
| 一级导航与页面路由 | B端产品、经营观察、关于我；集中观察页为上下文入口 | 否 |
| B端产品展示母版 | `ShowcaseLayout`、`PracticePage`、`SystemStage`；v0.25.9 升级为共享 ShowcaseFlow | 增加已批准内容时否 |
| Brief 观察内容 | `ObservationPublication`、schema、rail、集合页、单条文章 | 采集/审核/内容 publish 不进入产品版本；改变内容能力才进入产品版本 |
| 常青长文 | `EvergreenArticlePublication`、`EvergreenArticle`、`RichDocument`、`ReadingTOC` | 内容对象独立发布；新增 block 类型、阅读结构或图形能力才进入产品版本 |
| 富文本受控 block | lead、heading、paragraph、list、definitionList、figure、callout、sources、link | 新增 block 类型需要产品版本 |
| 图形静态内容 | Mermaid/LikeC4 源文件在构建期生成 desktop/mobile SVG，文章用 `picture` 投影 | 增加图或章节不需要；改变渲染能力需要版本 |
| 返回导航 | 共享 `ReturnNavigation`，使用安全站内目标和返回焦点 | 否 |
| 响应式阅读 | 桌面双栏/目录、紧凑单栏、移动折叠目录和自然页面滚动 | 内容增加不需要 |
| 内容与产品责任分离、发布身份分开 | 内容审核、确认与 publish 独立运行；产品结构与能力仍使用产品版本 | 内容使用独立发布身份；不修改产品版本、tag 或产品 current |

### 2.2 已确认但不是当前公开运行时的能力

- 企业经营体系的事实模型仍可作为上游模型和迁移证据；当前公开页面以常青长文为主，不再把旧 `FrameworkGraphRuntime` 或 `ArchitectureExplorer` 当作公开产品合同。
- LikeC4 和 Mermaid 已固定为内容构建阶段的开源 adapter；当前文章图形是静态响应式图，不是 LikeC4 原生多视图运行时。
- `?view=digital-implementation` 只作为旧链接兼容入口，解析到文章稳定锚点；不得继续维护第二套局部页面。

### 2.3 已确认的未来能力

未来需要建立统一的“视觉表达能力层”：

```text
内容对象或页面区域
        ↓
VisualExpression（视觉表达对象）
        ↓
VisualizationHost（统一展示控件）
        ↓
Renderer Adapter（LikeC4、Mermaid 等）
        ↓
交互运行时或静态降级
```

它的目标是让架构图、流程图、状态机、生命周期图、概念关系图和 Robotaxi 受控互动空间成为可调用能力，而不是页面专用代码。

页面也统一采用 `PageDefinition → PageComposition → Content Objects + CapabilityHost` 的产品架构。首页、B端产品、独立观察集合、长文、About 和未来互动能力页都是该架构下的不同组合，不再创建互相独立的页面结构。

这是未来产品版本能力，不得在内容 task 中通过私有 JSX、手工坐标或页面 CSS 偷渡实现。

### 2.4 明确不做

- 不把网站变成通用知识图谱、在线白板或自由画布；
- 不为了展示图形而复制 career 或 Robotaxi 的业务事实；
- 不为每一篇文章新建一个页面组件；
- 不用静态截图冒充可运行系统；
- 不在读者界面展示 candidate、sourceTier、claimKind 等治理字段；
- 不通过页面 CSS、手工 SVG 坐标或固定换行持续修补图形；
- 不因为内容增加十张图、子章节或下一级概念就重新开发页面；
- 不在没有产品版本授权时修改 `current.md`、版本、tag、代码或发布规则。

## 3. 事实边界与上游关系

```text
career
  └─ 企业经营、数字化和职业定位概念事实
Robotaxi
  └─ Robotaxi 作品状态、业务对象、运行结果和受控素材
xingbuild
  └─ 网站展示快照、内容对象、视觉、测试和发布状态
EdgeOne
  └─ 生产部署、域名和线上运行事实
```

- career 是企业经营、数字化和职业定位概念的上游事实源；网站只读取批准同步快照，不改写概念定义。
- Robotaxi 是 Robotaxi 业务对象、系统状态、运行证据和素材审批的上游事实源；xingbuild 不复制业务系统，也不把模拟作品表达为真实城市运营。
- xingbuild 可以重组公开表达，但不得提升上游事实的完成状态、商业结果或证据等级。
- 公开内容必须区分规划、建设、上线、可运行模拟、真实使用和实际结果。

## 4. 网站信息架构

### 4.1 一级导航

当前一级导航固定为：

```text
B端产品 / 经营观察 / 关于我
```

对应责任：

| 入口 | 公开责任 | 当前主要对象 | 页面组合 |
| --- | --- | --- | --- |
| `/products` | 展示可运行或受控的产品作品及其状态边界 | Robotaxi运营平台 | `ShowcaseComposition` |
| `/business-observations` | 展示企业经营框架、经营观察和常青长文 | 企业经营体系、Brief rail、Article | `ReadingComposition` / `HybridComposition` |
| `/about` | 展示作者定位、能力、经历和简历制品 | About RichDocument、ResumeArtifactRef | `ReadingComposition` |
| `/observations` | 集中观察集合，不是一级导航 | Brief 与有详情的长文入口 | `CollectionComposition` |
| `/observations/:slug` | 单条观察或文章详情 | `ObservationPublication` | `ReadingComposition` |
| `/` | 只使用一次定位语，并投影真实最新对象 | Robotaxi、企业经营体系和最新观察 | `HomeComposition` |

表中的 `PageComposition` 是已确认的产品组合合同，不表示当前代码已经为每个组合建立独立运行时；实现必须在进入唯一 `current` 后由 Engineering 按组合合同逐项落地。

企业经营体系属于“经营观察”，不是 B端产品；Robotaxi运营平台属于当前 B端产品，不得与企业经营体系互换归属。

### 4.2 首页责任

首页不是第二套内容系统：

1. 只使用一次定位语作为唯一可见 H1；
2. 定位之后固定提供“进入B端产品”和“浏览经营观察”两个动作；
3. 完整投影最新 B端产品对象，当前为 Robotaxi 运营平台，不只显示摘要卡；
4. 最新产品之后投影少量最新短文；
5. 最后直接进入单行 Footer，不增加 About、联系或重复导航收束；
6. 首页投影只改变组合与语义 heading level，不复制内容、字段顺序或事实。

### 4.3 B端产品责任

B端产品页使用可复用 `ShowcaseComposition`，Robotaxi 是当前第一个完整内容实例：

```text
LatestUpdateCard（Robotaxi 真实 release 事实）
→ ProductHero + actions
→ ShowcaseModule[]（左说明 + 右独立 MediaStage）
→ ClosingAction
→ SiteFooter
```

- 当前 Robotaxi 有 4 个稳定 module；每个模块独立拥有可选 `mediaId`，未来分别绑定不同媒体；
- 初始可让四个独立模块分别引用同一个批准视频，用于完整页面和视觉验收，但不能建立“继承第一个媒体”的隐式代码逻辑；
- 没有媒体是合法状态，仍保留正常 `empty` fallback 舞台；
- 当前 `/products` 不显示 Brief rail；共享 rail 能力保留给其他组合；
- 页面能力属于共享组件，未来其他作品通过对象和 `modules[]` 配置复用，不新建页面私有 JSX/CSS。

Robotaxi 的互动空间与企业经营架构图是两种不同表达，不共享业务模型。若未来嵌入 Robotaxi 独立系统，必须使用受控、无伪登录、无越权访问记录的公开演示边界；当前批准 action 仍以独立 Robotaxi 网站为准。

### 4.4 经营观察责任

经营观察同时容纳：

- 可信事实驱动的 Brief；
- 有明确来源的 Robotaxi/企业经营观察；
- 可持续更新的企业经营体系常青长文；
- 长文中的受控图形表达。

它不是通用新闻流，也不是工程活动日志。

页面结构保持：`/business-observations` 使用紧凑标题、左侧常青长文和右侧短文；`/observations` 使用短文集合；`/observations/:slug` 使用居中阅读。三者共享全站统一视觉，但不套用 B端产品的大 Hero 或媒体双栏。

### 4.5 About 责任

About 使用与文章相同的 `RichDocument` 受控 block，单列居中表达当前定位、能力、经历和证据边界。初始内容来自 career 已确认简历事实；不增加联系方式、继续阅读或营销收束。

About 提供两个受控动作：

- “查看简历”：打开 xingbuild 托管的已核验 career HTML 简历快照；
- “下载简历”：下载与同一上游身份、hash 和公开状态绑定的 PDF 简历。

简历展示入口不进入一级导航；career 始终是上游事实 owner，xingbuild 只保存公开快照与制品引用。

v0.25.9 初始制品由 Xing 指定为 `金星-Kami简历候选-20260805.html/.pdf`；HTML/PDF 必须分别校验 SHA-256 `453258563a8d51fc150c1ce436549ac8fd94649765cf9e98230f096216734507` 与 `71cf0ece679a415222de8e359f2e11699c832ed2bd3783a803fd3f979868c386`。

### 4.6 页面产品架构与组合合同

页面不是一次性设计的私有组件，而是由统一页面定义选择结构组合：

```text
NavigationEntry（导航入口）
        ↓
PageDefinition（页面定义）
        ↓
PageComposition（页面组合）
        ↓
Content Objects + CapabilityHost
        ↓
Responsive / Interaction / Fallback
```

每个页面定义至少表达：

```text
id
route
navigationEntry?
intent
composition
regions
contentRefs
capabilities?
navigationContext
responsivePolicy
acceptance
```

`PageDefinition` 只定义页面责任与组合，不复制业务事实；内容对象和视觉表达对象仍由各自唯一事实源提供。

标准页面组合：

| 组合 | 责任 | 可选区域 |
| --- | --- | --- |
| `HomeComposition` | 定位语、双动作、最新作品完整投影和最新短文 | `TopBand`、`ActionGroup`、`ShowcaseFlow`、`BriefCollection` |
| `ShowcaseComposition` | B端产品或作品的更新、Hero、模块流与底部行动 | `LatestUpdateCard`、`ProductHero`、`ShowcaseFlow`、`ClosingAction`；rail 仅在页面配置明确启用时出现 |
| `CollectionComposition` | Observation 等内容集合 | 标题、导读、集合、筛选/分页能力、rail |
| `ReadingComposition` | Article、About 和长文阅读 | 紧凑标题、摘要、TOC、RichDocument、来源、可选 ResumeActions |
| `HybridComposition` | 能力展示与长文在同一页面的组合 | `left`、`right`、RichDocument、rail |
| `CapabilityComposition` | 独立的架构、流程、状态或互动能力入口 | CapabilityHost、说明、结果、返回 |

页面组合是可选择的产品结构，不是每个页面一套实现。新增内容优先选择现有组合；只有新增组合、区域责任或共享能力，才进入产品版本。

菜单与页面的关系固定为：

```text
菜单只负责导航目标
页面定义负责页面组合
内容对象负责公开内容
能力控件负责展示、响应式和互动
```

网站名进入 `/`；一级导航进入 `/products`、`/business-observations`、`/about`；“更多观察”进入 `/observations`；单条内容进入 `/observations/:slug`。导航名称不决定页面内部布局，页面内部布局只由 `PageDefinition` 和现有组合合同决定。

## 5. 内容对象与页面投影

### 5.1 ObservationPublication（观察）

```text
ObservationPublication
└─ EvidenceUnit × N
   └─ Source × N
```

读者对象使用统一 `ObservationBlock`：

```text
subject · eventAt
#维度
80–160 个中文等价字符的事实正文，建议 2–3 句、一个段落
来源：...
```

- `subject` 和事件日期帮助识别；
- dimension 当前只表达分类，不是默认可点击筛选；
- 读者页面不展示 `claimKind`、`sourceTier` 或治理标签；
- 有长文时在同一块内嵌 `ArticlePreview`；普通 Brief 不单独创建详情页；
- 来源是末行弱信息，不能被视觉强调掩盖正文。

内容、审核、来源和发布边界遵循 [`docs/operations/内容运营与发布规则.md`](../operations/内容运营与发布规则.md)，产品工程版本边界遵循 [`docs/rules/iteration-and-release.md`](../rules/iteration-and-release.md)；本文不复制操作命令。

### 5.2 EvergreenArticlePublication（常青长文）

当前首个对象：

```text
content/articles/enterprise-operating-system.json
```

受控字段包括：`id`、`slug`、`title`、`summary`、`status`、`updatedAt`、`blocks[]`、`sources[]`。

`RichDocument` 当前允许：

```text
lead | heading | paragraph | list | definitionList
figure | callout | sources | link
```

后续增加章节、定义、来源或十张图，只修改文章对象和图源，经过 article checks 后独立发布，不修改页面组件、产品版本或 tag。新增 block 类型、改变阅读结构或改变图形能力才进入产品版本。

### 5.2.1 内容运营与产品版本边界

内容运营的对象、审核、发布身份和公网内容证据由 `docs/operations/内容运营与发布规则.md` 负责。内容增加或修正文案、事实、来源、媒体、章节和模块说明时，不改变产品版本；只有新增页面组合、路由、schema、组件、交互或共享展示能力时，才进入产品工程版本。

### 5.3 Practice / Robotaxi 作品

Robotaxi 内容对象由上游批准的 `media`、可选 `action` 和内部 `provenance` 组成：

- `media` 是读者可见素材；
- `action` 是可选的独立系统入口；
- `provenance` 保存审批、状态、版本、commit 和哈希，不投影到读者界面；
- 未达到 approved/public 或哈希校验失败的素材不得进入读者页面。
- 每个 module 独立拥有可选 `mediaId`；多个 module 可以显式引用同一批准 asset，但页面不得自动继承其他 module 的媒体；
- `MediaStage` 正常支持 image、video、empty、loading、failed/revoked；没有媒体时不删除槽位；
- 视频默认只在可见区域 `autoplay muted loop playsinline`，无 controls；点击只触发已登记产品入口，不触发播放/暂停；Reduced Motion 下使用静态状态。

### 5.4 Profile / About

About 的公开内容使用受控 `RichDocument`，不在页面 JSX 中写业务正文、私有字号或任意 margin。

简历使用 `ResumeArtifactRef` 关联 career 已确认的 HTML/PDF 制品、hash、来源版本和公开状态；查看与下载必须属于同一上游简历身份。候选或未确认制品不得公开。

### 5.5 VisualExpression（未来统一视觉表达对象）

视觉表达对象不是新的业务事实源，只是内容的表现声明。最小语义包括：

```text
kind: architecture | flow | state | lifecycle | sequence | concept | mindmap | interactive-stage
sourcePath
renderer
mode: static | interactive
initialView?
title?
alt
caption
fallback
provenance
```

内容 task 只声明表达意图和源文件；页面不声明节点坐标、关系路径、字体尺寸或响应式分支。

### 5.5.1 ResponsiveTextSlot（通用内容表达能力）

说明文字、定位语、模块摘要和产品动机都属于内容对象的语义表达，不应因为需要 Web/Mobile 的不同换行而进入页面 JSX 或 CSS。统一使用有界的 `ResponsiveTextSlot`：

```text
ResponsiveTextSlot
├─ parts[]：稳定 id + 纯文本语义片段
└─ projections
   └─ 已登记页面/slot → web/mobile breakAfter（可选）
```

`parts[]` 不是物理屏幕行；同一语义文本只保存一份。页面只能读取自己登记的 projection，所以 Home 与 `/products` 可以读取同一作品说明，却各自拥有独立 IA、容器、页面顺序、生命周期和换行策略。产品能力层负责字体、最大宽度、行高、gutter、关系间距和自然换行；内容运营只负责经审核的文本片段与已登记的换行提示。

该能力禁止 HTML、`<br>`、CSS、DOM selector、页面私有样式和任意投影 key。旧字符串仍由 resolver 解释为单一 legacy part，无提示时沿用自然排版；缺失的可选 slot 不渲染且不产生空白。新增或改变 slot schema、target registry、resolver 或 renderer 属于产品工程版本；在能力已经上线后，文案和 break hints 通过独立 ContentSet Candidate 发布，不递增产品版本。

## 6. 页面模板与布局合同

### 6.1 全局 shell

- 桌面唯一 shell 最大 `1280px`，外边距至少 `32px`；
- 手机 gutter `20px`，窄屏 `16px`；
- 主背景冷白，内容自然流动，不为每个页面创建独立版心；
- Footer 始终位于页面内容自然流的末端；短内容页面也不能让 Footer 悬在内容中部。

### 6.2 ShowcaseLayout

桌面媒体展示模块使用共享双栏：

```text
说明列 240–280px + 48px + MediaStage
```

仅当 MediaStage 仍可保持至少 `640px` 有效宽时使用完整双栏；否则转为单栏，不压缩主视觉到不可读。当前 `/products` 不显示 Observation rail。

手机使用单列并保持对象归属：`explanation → MediaStage` 的间距 `20–24px`；不同对象之间 `56–72px`。同一内容对象不得在手机被拆成无法判断归属的两块。

### 6.3 ReadingShell 与 ReadingTOC

- Article 与 About 共用居中 ReadingShell；
- 桌面文章目录约 `160px`，正文约 `768px`，目录和正文间 `24px`；
- 目录只从有稳定 `id` 的 H2/H3 生成；
- sticky 目录必须避开 sticky Header；
- 手机目录使用原生 `details` 展开，跳转后关闭；
- 点击、刷新、直接锚点访问和 Header 偏移必须成立；
- 正文不使用内部滚动容器。

### 6.4 Observation rail

- 只有存在有效 Brief 时才渲染 rail；
- `/products` 当前配置明确关闭 rail；`/business-observations` 保持左长文、右 Brief rail；
- 页面与首页使用相同观察对象和 `ObservationBlock` 投影；
- rail 不展示治理信息；
- 无有效 Brief 时不保留空 rail 或占位空间。

### 6.5 PageComposition 共享区域

所有页面组合共享以下区域语义；区域可声明存在或省略，不以空白占位替代缺失内容：

```text
PageFrame
├─ TopBand
├─ ContentComposition
│  ├─ left?
│  ├─ right?
│  ├─ body?
│  └─ rail?
├─ RichDocument?
└─ ClosingSection?
```

- `TopBand`：页面标题、可选说明和有真实目标的受控 action；首页和 B端产品可使用 ActionGroup，经营观察使用紧凑标题。
- `ContentComposition`：单栏、左右双栏或内容区关闭任一侧；关闭后不留下空 rail，不创建页面私有版心。
- `RichDocument`：使用受控 block 和目录，可以独占页面、进入一个区域或位于展示能力下方。
- `ClosingSection`：居中标题、标题+说明或省略；B端产品中作为全部模块后的产品再次入口，其他页面不自动增加营销 CTA。
- 同一页面在桌面、紧凑宽度和手机只改变顺序、密度和区域折叠，不改变对象语义、导航目标和内容事实。
- 页面内的图片、视频、图形和互动状态由统一能力层负责内容级响应式；不能只缩放外层容器。

标准移动顺序为：

```text
TopBand → title/summary → action or TOC → capability/content → result → ClosingSection
```

## 7. 视觉系统

### 7.1 品牌与颜色

冷白、克制、专业、极简。高级感由统一网格、文字层级、留白、媒体质量和轻微空间深度形成，不靠装饰线、纯黑按钮或页面私有特效。

| 角色 | 当前 token | 责任 |
| --- | --- | --- |
| 主背景 | `--color-canvas: #F8FAFC` | 全站冷白画布 |
| 主表面 | `--color-surface: #FFFFFF` | 媒体、更新卡和必要行动区 |
| 轻表面 | `--color-surface-subtle: #F1F5F9` | 空状态、导读和轻分组 |
| 主文字 | `--color-text: #111827` | 标题和正文；不是纯黑 |
| 辅助文字 | `--color-text-muted: #64748B` | 元数据、来源、边界 |
| 边界 | `--color-border: #E2E8F0` | 必要控件与可见焦点辅助，不作装饰分割线 |
| 强调 | `--color-accent: #1769E0` | 主要按钮、active 和主链接 |
| 强强调/焦点 | `--color-accent-strong: #0F56C7` | hover、pressed、focus 辅助 |
| 媒体阴影 | `--shadow-media: 0 18px 48px rgba(15,23,42,.10)` | 只用于媒体窗口和必要行动区 |

规则：

- 当前只有浅色主题，不自动跟随系统深色模式；
- 正文不使用强调色；
- 不使用纯黑大按钮、暖红/棕色强调、玻璃拟态或发光渐变；
- 媒体窗口允许柔和环境阴影形成高级画布上的轻浮起感；正文和普通卡片不批量加阴影；
- 不用装饰线或分割线建立页面层级；真实控件边界与 focus ring 除外；
- 不采用手绘、水彩、草图、植物、风景和装饰隐喻。

### 7.2 字体角色

```text
Display / Heading / Body / Meta：Noto Sans SC → PingFang SC → Microsoft YaHei → sans-serif
Wordmark：Inter → -apple-system → BlinkMacSystemFont → sans-serif
```

角色顺序固定：

```text
wordmark → 首页定位 → 页面/对象标题 → 模块/章节标题
→ 阅读正文/摘要 → metadata/source
```

桌面和手机共享角色，不因断点整体换字体。中文标题必须先保证词义完整，再讨论行数和几何。

### 7.3 间距与层级

视觉结构固定为：

```text
Page Frame → Section → Content Group → Content Object → Element → Relationship
```

父级 flow 负责同级对象之间的间距；子对象只负责内部结构。不得通过空段落、硬编码 `<br>`、重复 margin 或页面私有 CSS 制造节奏。

关系 token：

```text
bind：8–12px       同组紧密关系
relate：16–24px    标题、摘要、正文关系
object：32–48px    对象内部主要分组
group：48–64px     同栏目对象之间
section：96–128px  栏目之间
```

具体数值可以随模板调整，但不能改变关系语义。

### 7.4 Header、导航、Footer

- Header 是一个紧凑横向身份组，网站名和一级导航对齐到同一 shell 网格；
- Header 全站 sticky，顶部与冷白画布融合，滚动后只增加中性半透明层、克制 blur 和轻 shadow，不改变高度；
- 一级导航保持 `B端产品 / 经营观察 / 关于我`；
- 手机低于约 `520px` 使用全视口菜单 overlay，锁定背景滚动并恢复焦点；约 `557px` 保留紧凑行内 Header；
- Footer 只显示 `© 年份 xingbuild · 当前产品版本`；作者、地点、更新时间和治理状态不进入全局 chrome；
- 采集、draft、review、recovery 和内容 publish 不进入产品版本；Footer 只显示当前产品版本，不展示内容运营状态。

### 7.5 卡片、链接与返回

- 重复可点击集合使用共享卡片系统；整张卡片是主链接；
- hover 只改变克制表面、蓝色动作或既定阴影，不改变尺寸、不重排；媒体的浮起深度属于静态层级，不依赖 hover 才成立；
- focus-visible 必须清楚且不只依赖颜色；
- `ReturnNavigation` 是全站统一辅助文字链接，主文案为 `← 返回{真实目的地名称}`；
- 它不是描边按钮、浮动工具条或页面私有变体；
- 同页最多一个主返回和一个不重复目标的次级栏目入口；
- 返回目标、origin/returnTo、焦点和必要滚动现场必须在刷新、直接访问和浏览器历史下成立。

### 7.6 页面能力展示的视觉与互动

- 展示空间是页面内容对象的视觉主角，但不改变页面的语义层级；说明、操作、状态、结果和来源保持可辨识顺序。
- 图片、视频、架构图和互动系统都必须有真实的边界、可读尺寸、`alt/caption` 或文本结果；不能用巨大空白、不可读缩放或孤立标签填充空间。
- 桌面支持 hover、focus-visible 和 click；手机支持 tap；键盘 Enter/Space 与触控共享同一状态语义。hover 不能是唯一信息来源。
- image、video、empty、loading、failed/revoked 共享稳定媒体槽位；状态变化只改变必要说明，不改变页面列数、标题位置、比例或滚动上下文。
- 带安全 action 的视频在可见区域自动静音循环播放，无 controls；点击或 Enter 只打开目标产品，不触发播放/暂停；离屏暂停，Reduced Motion 使用静态状态。
- 交互反馈使用克制的边界、颜色和轻量过渡，尊重 `prefers-reduced-motion`；不把复杂滚动动画作为理解内容的前提。
- 统一能力层负责“容器响应式 + 内容投影响应式”：固定桌面图不能仅通过 `width: 100%` 压缩到手机；renderer 必须提供合适投影或可靠降级。

## 8. 视觉表达能力层

### 8.1 三种责任必须分开

| 表达 | 主要问题 | 当前/未来方式 |
| --- | --- | --- |
| LikeC4 多视图架构 | 系统边界、层级、组件和视图下钻 | 未来由统一 host 调用 LikeC4 原生 runtime |
| 文章内局部图 | 当前章节的一个关系、流程或状态 | 当前使用 source-driven 静态 figure；未来由 renderer adapter 选择 |
| Robotaxi 互动空间 | 受控产品演示和独立系统入口 | `InteractiveStage`，遵守登录、权限和访问记录边界 |

### 8.2 当前图形合同

当前公开文章的图形只通过受控 `figure` block 声明：

```text
sourcePath / renderer / layoutPreset / alt / caption
```

构建期由锁定的 Mermaid 或 LikeC4 CLI 生成 desktop/mobile SVG 和校验记录；运行时使用响应式 `picture`，不是手写节点坐标、关系路径或每页专用 SVG。

当前静态图形必须满足：

- source 单一且可编辑；
- 生成失败先清除目标旧产物；
- desktop/mobile 均有可读的图形或文本降级；
- 不把图形治理字段投影给读者；
- 不用图形替代必要的文字解释。

### 8.3 未来统一 host 合同

未来的 `VisualizationHost` 应统一负责：

- 有界响应式展示面；
- renderer 隔离；
- 交互、键盘、触摸和焦点；
- 多视图进入/返回和当前层级；
- 加载、错误、静态和文本降级；
- 无障碍名称、说明和操作；
- 不允许父级 CSS 破坏 SVG/DOM、字体、缩放和溢出。

页面和文章只传入视觉表达对象，不声明坐标、路径、尺寸或移动端特例。LikeC4 runtime 作为架构 adapter，Mermaid 作为流程/状态/生命周期 adapter；D2 仍是未来可选 adapter，未经锁定和专项验收不得声明。

## 9. 当前代码与内容映射

| 产品责任 | 当前代码/内容落点 | 使用边界 |
| --- | --- | --- |
| 路由与全局 chrome | `src/App.jsx`、`src/components/site/` | 共享页面骨架 |
| 页面版心和两栏 | `src/components/site/LayoutShell.jsx` | 不在页面复制版心 |
| B端产品 | `src/pages/ProductsPage.jsx`、`src/pages/RobotaxiPage.jsx`、`src/components/practice/` | 只读取批准 Practice 内容 |
| 观察集合和 rail | `src/content/observationRepository.js`、`src/components/observations/Briefs.jsx` | Brief/Article 共用投影 |
| 常青长文 | `content/articles/*.json`、`src/content/evergreenArticleRepository.js`、`src/components/reading/` | 内容更新不改组件 |
| 企业经营体系 | `content/articles/enterprise-operating-system.json` | 当前公开入口是长文 |
| 图形构建 | `src/architecture/`、`scripts/generate-evergreen-figures.mjs`、`src/content/diagramFigureAssets.js` | 构建期 adapter |
| 文章图形投影 | `src/components/reading/RichDocument.jsx` | 统一 figure，不写业务 JSX |
| 返回导航 | `src/components/navigation/ReturnNavigation.jsx` | 全站共享 |
| 内容发布 | `scripts/content-*`、`scripts/article-*`、发布命令 | 采集/审核数据不进产品版本；正式内容 publish 使用独立内容身份和内容证据 |

`src/components/framework/` 中的旧架构运行时和投影代码属于迁移/历史实现，不是当前公开产品合同。未经新的产品版本方案确认，不得在新页面重新引用它们，也不得以删除遗留代码替代产品设计验收。

## 10. 责任分工与迭代门禁

### 产品与视觉 task

- 维护本文；
- 决定产品目标、信息架构、内容对象、页面责任、视觉、响应式和验收合同；
- 对 Engineering 已形成的本地提交版本执行产品与视觉验收；验收发现产品、视觉、对象边界或验收合同问题时，直接定义下一个 patch/小迭代/大迭代并写入 `current.md`，不把该验收问题重新放入普通候选队列；
- 每次收口必须报告本地版本状态、线上版本状态、本地/线上 URL、已确定项、未确定项、候选状态和下一动作；无候选时也必须明确报告等待用户下一步；
- 不参与日常选题、写稿、事实审核和逐条内容发布；
- 负责确定产品版本合同、产品发布能力边界和内容运营边界；正式内容 publish 属于独立内容运营，采集与审核数据不触发产品版本。

### 内容与发布 task

- 按现有 schema 写 Brief、Article 和视觉表达声明；
- 调整公开结构和可读性，但不得改变上游事实、来源性质或证据边界；
- 只执行内容事实和 schema 检查，按统一发布命令提交已批准内容；
- 不修改本文、页面组件或视觉 token；不得修改产品版本、创建产品 tag 或绕过内容运营合同。

### Ops task

- 只产出可信证据候选、去重和覆盖记录；
- 不写公开标题、摘要、正文，不决定发布；
- 不把内部台账或治理标签投影到读者界面。

### Engineering task

- 只实现已经确认并进入唯一 current 的能力合同；
- 在当前合同内完成实现与自 QA；本地提交后交产品与视觉 task 验收，不自行改变产品目标、对象边界或视觉合同；
- 不复制或改写 career/Robotaxi 业务事实；
- 不为页面方便建立专用数据、坐标、路径或视觉特例；
- 形成一个本地提交版本后，分别报告本地版本状态与线上版本状态、本地/线上 URL、已确定项、未确定项、候选状态和下一动作；publish 后再报告线上统一版本证据。

### 产品版本与内容更新判定

| 变化 | 是否产品版本 |
| --- | --- |
| 新增 Brief、文章章节、来源、图源或现有 block 内容 | 内容运营独立发布，不进入产品版本 |
| 新增十张同类型图，仍使用现有 figure 合同 | 内容运营独立发布，不进入产品版本 |
| 新增 block 类型、页面层级或新的内容对象 | 是 |
| 改变共享 Layout、Header、Footer、返回、目录或视觉 token | 是 |
| 新增或改变 VisualizationHost/renderer adapter | 是 |
| 修改 Robotaxi 嵌入安全、权限或公开演示能力 | 是 |

产品方案、串行交接和发布命令按 `docs/rules/00-baseline-index.md` 路由：候选和产品设计遵守职责规则，跨 task 遵守协作规则，版本收口和发布遵守迭代规则。产品方案可以并行形成 `DRAFT`，但不能修改当前版本或合入主线；当前版本收口后由产品 task 检查候选入口并交 Engineering。

## 11. 产品变化的分流原则

本文件只维护“网站产品应该是什么”。项目通用的规则按 [`docs/rules/00-baseline-index.md`](../rules/00-baseline-index.md) 路由：职责与候选分流以 `responsibility-and-workflows.md` 为准，跨 task 以 `collaboration-workflow.md` 为准，版本启动、验证、提交/tag、发布和资源以 `iteration-and-release.md` 为准；活动候选以 `docs/iterations/candidates/` 为准；转化/关闭记录以 `docs/iterations/history/candidates/` 为准；当前实施状态以 `docs/iterations/current.md` 为准。

产品侧只保留以下分流：

- 新增内容对象、章节、来源或现有类型图形：按内容合同运营；不得创建产品版本或产品 tag；
- 新页面但复用已有组合：使用已确认的 `PageDefinition` 能力；当前尚未实现时排入相应版本；
- 新页面组合、内容 block、共享视觉、响应式或 renderer：形成活动候选记录；产品 task 启动版本时综合形成正式设计方案，写入 `current.md`，并立即归档来源候选；
- 上游事实继续由 career/Robotaxi 和 Ops 事实合同维护；Engineering 实施中的跨范围问题、工具缺陷或新的产品优化统一登记到 `docs/iterations/candidates/`，由产品与视觉 task 评审；已提交本地版本的产品与视觉验收问题直接定义下一版本，不在运营文档或 task 私有文件中另建问题入口；
- 任何新产品方案都必须回到本文确认，不得在 task、页面组件或旧设计文件中形成第二份网站主架构。

## 12. 文档整理与保留规则

### 12.1 当前唯一入口

后续产品/视觉 task 必须从本文开始读取。`docs/README.md` 只指向本文，不再把多个旧设计文件列为当前基线。

### 12.2 必须保留

- `docs/iterations/history/`：版本追溯和发布证据；
- `docs/qa/`：真实运行验收证据；
- `docs/upstream/`：上游事实快照；
- `docs/operations/`：内容运营和发布合同；
- `docs/design/assets/`：仍被历史 QA 或设计证据引用的资产。

这些文件不是当前设计入口，但删除会损害可追溯性。

### 12.3 历史设计方案

`docs/design/v*.md` 是对应版本的设计决策和实施输入，应保留用于追溯；它们不再拥有当前产品/视觉权威。若未来需要物理归档，只能在检查所有引用、更新链接并保留可恢复历史后单独执行，不能在本次主文档建立时批量删除。

`docs/design/xingbuild Visual System v1.md` 和 `docs/design/视觉系统与交互原则.md` 的有效内容已经吸收到本文。前者保留为历史视觉快照，后者只作为兼容入口，不得继续追加新规则。

企业经营体系多视图方案已在 `docs/design/v0.22.0 企业经营体系多视图架构阅读能力方案.md` 正式落点；本总案仍是长期产品/视觉事实源，版本方案只承载本次实施范围与验收，不形成第二份网站总架构。

### 12.4 删除门禁

只有同时满足以下条件，文件才可以删除：

- 不是版本历史、QA、上游事实或运营合同；
- 没有被代码、脚本、current、README、AGENTS 或历史证据引用；
- 有效决策已完整进入本文或对应唯一责任文档；
- 删除后可以通过链接、文档和 Git diff 检查；
- 删除范围已在变更说明中列出并得到产品责任确认。

## 13. 验收合同

每次产品/视觉迭代至少检查：

### 产品结构

- 页面入口、上层与返回目标符合本文 IA；
- 内容对象没有被复制成第二份事实源；
- 首页投影与来源页共用同一内容对象；
- Brief、Article、Practice、About 的责任边界没有混合。

### 视觉与响应式

- 视觉验收是产品发布硬门禁，不以构建成功、DOM 存在或自动化测试通过替代真实页面判断；
- 先验收 Web 1600×1067 的全站构图和视觉质量，通过后再验收 Mobile 390×844；320/375/768/1280 只做稳健性补充；
- Header、Footer、冷白画布、sans-led 字体、蓝色动作、共享网格和返回导航保持统一合同；任何页面残留暖白/棕红、黑色大按钮、装饰线或页面私有版心都视为未通过；
- 对齐、文字层级、阅读宽度、段落节奏、section 间距、媒体比例、轻浮起阴影、空状态和按钮密度必须与已确认视觉稿保持同一视觉语言；
- 使用真实当前内容和长文本增长检查；不得只用短占位文本掩盖布局问题；
- 桌面、紧凑宽度、手机均无横向溢出和无意义内部滚动；
- hover、focus、click、tap 不改变布局几何或造成页面晃动；
- 文字、关系线、图形和说明在真实尺寸下可读；
- 目录、锚点、焦点和直接访问成立；
- 图形不是截图式占位，不把线条与无关组件边缘重合。
- `/products` 四个模块的说明/媒体归属清楚；video/empty/loading/failed 状态不改变构图，视频自动播放和点击跳转合同成立；
- 首页、经营观察、集合/详情与 About 的页面职责不同，但视觉底层、网格、字体、按钮、媒体和状态必须一致。

### 内容与事实

- 文章/图形只读取批准源；
- 图形 alt、caption、正文和来源互不替代；
- 不把模拟、计划、公司表述或推断写成已验证经营事实；
- 读者界面不泄露内部治理字段。

### 工程与发布

- 构建失败不得复用旧图形产物；
- 通过项目、内容、文章和 Sites 检查；
- 产品能力使用产品版本身份；内容提交和线上内容发布使用独立内容身份；采集与审核数据保持运营内部边界。
- 实现、验证、提交/tag、push、部署和公网验收分别记录；
- 浏览器验证结束后释放服务和资源。

## 14. 当前待确认事项

当前已确认事项是 `v0.25.9` 全站统一视觉系统与结构化页面组合方案，并已进入 `current.md`。其他新的产品、视觉、页面或公开发布能力优化，仍必须先登记活动候选；内容 task、Ops 和 Engineering 不得自行扩大 v0.25.9 范围。

## 15. 变更记录

| 日期 | 变化 | 责任 |
| --- | --- | --- |
| 2026-08-01 | 首次建立统一产品架构、内容对象、视觉系统、展示能力和文档治理主文档 | 产品与视觉 task |
| 2026-08-01 | 补充 `PageDefinition → PageComposition` 页面产品架构、共享区域和能力展示互动合同；候选 DRAFT 改为只保留未确认能力细节 | 产品与视觉 task |
| 2026-08-02 | 统一候选入口、current/history 和规则索引；roadmap 不再作为活动事实源 | 产品与视觉 task |
| 2026-08-05 | 将全站视觉底层升级为冷白、sans-led、轻浮起和蓝色动作系统；定稿首页、B端产品、经营观察、About 页面组合、独立媒体槽位、正常 fallback、Robotaxi release reference 与 career 简历制品能力 | 产品与视觉 task |
