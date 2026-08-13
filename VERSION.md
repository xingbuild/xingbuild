## v0.26.22 — 内容预览运行时 v2 与局部刷新闭环

父版本：`v0.26.21` / `3bde62d80a1bb666ee5846e30dd10fa631fbf29f`

- 建立独立 content-preview runtime v2：绑定 session、selected target、TargetImpact 与显式 SSE 事件通道；不依赖 Vite HMR 或全站 reload。
- `products.robotaxi.intro` 只刷新 `/` 与 `/products` 的 Web1280/Mobile390 frame；`invalid` 保留 last-valid，`outside-selected-target` 不刷新。
- 处理原子保存/半写入的有界校验与恢复，并在退出时清理固定 4317 lease/进程。

## 验证合同

- `npm run check`、内容/target 定向测试、固定 4317 真实浏览器编辑→局部更新→invalid→恢复→零写入证据、`git diff --check`。
- 预览只读，不修改 ContentSet、审核/恢复/发布状态、ProductArtifact、SitePublication 或线上状态；不执行 content publish/product transport。

## v0.26.21 — 精准内容预览与局部刷新闭环

父版本：`v0.26.20` / `3ee065faa1ef3c847e221743052e686cd2e5525b`

- 建立 TargetImpact：以现有 ContentTarget 注册的 projectionRoutes 为影响面事实，并与 PageDefinition/contentRefs 做一致性校验；`products.robotaxi.intro` 覆盖 `/` 与 `/products`，Why 仅 `/products`，首页定位仅 `/`。
- 内容预览工作台按一个 target 展示所有真实消费者的 Web1280/Mobile390 frame；通过 dev-only `xingbuild:content-target-update` 事件局部刷新，禁止 ignored JSON 触发全站 full reload。
- 提供 valid-updated、invalid、outside-selected-target 状态与 revision/hash 证据；无效源保留上个有效页面，预览只读、不生成构建物或发布状态。

## 验证合同

- 覆盖 target route/page contentRef、Home source readiness、局部事件 reducer、invalid→修复、同源非选中字段、四 frame 影响面与全站 reload 禁止门禁。
- `npm run check`、`npm run release:prepare`、targeted content-preview tests、`npm run release:closeout-check`、exact `npm run release:build`、`npm run release:preflight`、`git diff --check`。
- 不修改内容值、ContentSet、审核/恢复/发布状态、正式 UI/IA/视觉；未执行 content publish/product transport。

## v0.26.20 — 本地内容预览工作台与 Task 入场治理

父版本：`v0.26.19` / `36dcffa097455fc6747555751f1861ae26b7227f`

- 新增唯一 `content:preview:site` dev-only 入口，复用固定 `4317` preview lease，以 `content-preview` mode 绑定当前 HEAD、task、registered target、绝对 source、projection routes/keys 与 active ContentSet 只读基线。
- 新增 ContentPreviewSession 与 Vite 内容预览工作台：使用 canonical ignored content、既有 page composition/ResponsiveTextSlot/media，提供 Web `1280` 与 Mobile `390` 真页面 iframe、HMR 和“本地内容预览 · 未审核 · 未发布”状态；不提供 approve/publish/deploy/active 切换。
- 启动前拒绝未注册 target、unsafe source override、缺失/非法 JSON、非 projectionKeys 注册的 responsive slot；预览只读 active ContentSet，不写 active/review/recovery/release/SitePublication/线上 manifest。
- 固化 AGENTS、task-onboarding、baseline index、task registry 的 elon 职责与 direct-local 入场边界；不改变 ContentSet/target registry/ResponsiveTextSlot schema、页面 IA/视觉或发布链路。

## 验证合同

- registered target/source/route/baseline、unknown/unsafe/missing source、responsive projection、content/product lease 隔离、workbench dev-only/无发布控制、零写入与 preview runtime 回归。
- `npm run check`、`npm run release:prepare`、内容检查、`npm run release:closeout-check`、exact `npm run release:build`、`npm run release:preflight`、`git diff --check`；保留既有环境/内容 fixture failures 分层，不修改内容事实。
- 本版本只形成本地 Engineering checkpoint；待 elon 产品/架构与 elon ui 本地 Web→Mobile 独立验收，未执行 product transport 或 content publish。

## v0.26.19 — 发布证据契约与验证闭环

父版本：`v0.26.18` / `77a21d61a0a5efc29f7609f1aadbc4805a0f17ff`

- 建立唯一 `publication-runtime-evidence-v4` `PublicationPhaseEvidence` envelope、validator、factory、reducer 与 aggregate；assets/app/media 只能经统一工厂产出规范 phase，v3 仅只读兼容。
- `finalize` 只接受同一 publication identity/attempt 的完整 assets → app → media v4 aggregate；缺 phase/result、raw/v3 混用、重复、identity/CAS drift 和失败/中断均在 finalize 前硬失败。
- 保留 v0.26.18 app-ready/媒体分离、资产 MIME/bytes/hash、recoverable、状态 CAS 与同 deployment resume 语义；不修改 UI、ContentSet、内容事实或旧 SitePublication/deployment。

## 验证合同

- 正向 `verify → aggregate → finalize` 与负向 missing result/phase、schema mix、duplicate、identity drift、raw evidence 回归；保留 v0.26.17/v0.26.18 runtime/coordinator/assets 测试。
- `npm run check`、`release:prepare`、targeted `v0.26.19` tests、分层 `release:qa`、`release:closeout-check`、exact `release:build`、`release:preflight`、`git diff --check`。
- 使用现有 v0.26.16 assembled client/content-enabled staging 做五路由与 Robotaxi media 验证；本地 Engineering checkpoint 后待产品/视觉独立验收，未执行 transport/content publish。

## v0.26.18 — 发布运行时媒体阶段与原子恢复

父版本：`v0.26.17` / `734c71ca5fcdf0e9a11b259d70816c93db397b8d`

- 将公网校验拆为 assets → app → media 三个独立阶段；app-ready 只验证 DOM 挂载、文本、`main`/`h1` 和脚本/CSS/页面错误，不把懒加载媒体 `readyState=0` 判为失败。
- 统一使用 `publication-runtime-evidence-v3`，持久化 phase、route、media、attempt、lastEvidence 与可恢复结果；媒体资产沿 asset manifest 校验 status/MIME/bytes/hash，浏览器媒体 probe 明确记录 `not-probed`。
- 新增唯一 `transitionSitePublication` 状态 reducer 与 `stateRevision` CAS；evidence/propagation 只能追加事实，SIGINT/SIGTERM/timeout/browser/media failure 原子收口为 recoverable，禁止 `propagating` 与 failure 并存。
- 保持 v0.26.16 既有 SitePublication/deployment 与 active ContentSet 只读兼容；不修改页面、内容事实、旧 tag/history，不执行 transport/content publish。

## 验证合同

- app-ready 与媒体 readyState 分离、媒体 MIME/hash/取消/超时分类、evidence-v3、状态 reducer/CAS、resume 幂等和失败不污染 active 回归。
- `npm run check`、`release:prepare`、targeted runtime/coordinator/assets QA、分层 `release:qa`、`release:closeout-check`、exact `release:build`、`release:preflight`、`git diff --check`。
- 已完成 Engineering local implementation；待产品/视觉独立验收，未执行 v0.26.18 transport。

## v0.26.17 — 公网运行时验证状态机与恢复闭环

父版本：`v0.26.16` / `4d6198360cf045bb075751788ea4f0370299d215`

- 将公网浏览器验证改为 `domcontentloaded` + app-ready 合同，按路由、资产、媒体分阶段记录证据；媒体取消与真实媒体失败分离。
- 新增 `publication-runtime-evidence-v2`，持久化 publication/product/content identity、attempt、phase、route、错误、媒体和资产摘要。
- timeout、SIGINT、浏览器异常进入 recoverable 并保留 lastEvidence；同一 SitePublication/deployment resume 幂等，不创建第二 deployment。
- 不修改 UI、ContentSet、正文、审核、来源、媒体事实或 v0.26.16 旧 deployment。

## 验证合同

- app-ready、脚本/CSS/媒体错误分类、媒体 cancellation、五路由 runtime、timeout/SIGINT/recoverable、resume/finalize CAS 回归。
- `npm run check`、`release:prepare`、runtime/coordinator targeted QA、分层 `release:qa`、`release:closeout-check`、exact `release:build`、`release:preflight`、`git diff --check`。
- 待产品/视觉独立验收，未执行 v0.26.17 transport。

## v0.26.16 — 发布资产传输与运行时验证闭环

父版本：`v0.26.15` / `222b6a93f3bae8e7c1a87b86c62d61e563add904`

- 建立不依赖隐藏 workspace、symlink、当前目录或目录 fallback 的可移植 SitePublication upload root，并生成逐项资产 hash/MIME manifest。
- Coordinator 在部署前校验 index/assets，传播后校验公网 JS/CSS 状态、MIME、正文完整性，并复用唯一 qa-browser-runtime 验证五路由真实挂载、文本、console/pageerror 与资产请求。
- 资产或浏览器门禁失败只保留 blocked/recoverable 状态；同一 publication/deployment resume 幂等，不污染 active ContentSet，不重试 v0.26.15 坏 deployment。
- 不修改 UI、ContentSet、正文、审核、来源、媒体事实或旧 SitePublication。

## 验证合同

- 正确资产、HTML fallback、错误 MIME、缺失资产、路径越界、symlink、传播旧响应、白屏、resume/rollback 回归。
- `npm run check`、`release:prepare`、asset/runtime targeted QA、分层 `release:qa`、`release:closeout-check`、exact `release:build`、`release:preflight`、`git diff --check`。
- 待产品/视觉独立验收，未执行 v0.26.16 transport 或 content publish。

## v0.26.15 — 通用响应式内容表达与独立发布能力

父版本：`v0.26.14` / `375f0c885ddec940be6859336b4db94bc5654256`

- 新增有界 `responsive-text-slot-v1`：稳定语义 parts、已登记 projectionKeys 与 web/mobile breakAfter；拒绝 HTML/CSS/DOM、未知投影、非法断点和空文本。
- Practice/Home adapter、ContentSet/ChangeSet prepare/build/reconcile/rollback 与共享 renderer 兼容 slot；旧字符串和既有 active ContentSet 不迁移即可读取。
- 首页定位与 Robotaxi 作品说明支持独立页面 projection；`site.home.description` 仅做 slot 兼容，不新增首页可见 block；Home 与 Products 保持独立 IA/CTA/ClosingAction/lifecycle。
- 不修改现有 active ContentSet、正文/审核/source/media、SitePublication/Coordinator 语义；不执行 content publish。

## 验证合同

- 旧字符串/38-entry active ContentSet、合法 slot round-trip/rollback、未知 projection 零落盘、页面独立投影和分层 release gates。
- 待产品/视觉独立验收；尚未 product transport。

## v0.26.14 — QA 浏览器供应链与安装副作用治理

父版本：`v0.26.13` / `62ab89f49771dde0bb6388add9874b83515d2299`

- 新增唯一项目级 Puppeteer install policy：root、Chrome、Chrome Headless Shell 与 Firefox 均 `skipDownload=true`，cacheDirectory 隔离到 ignored QA workspace；`preinstall` guard 拒绝全局 cache、executable 和下载开关环境覆盖。
- 新增 `qa:browser:install-policy`，通过真实 `puppeteer.configuration()` API、静态配置、cache snapshot、进程 snapshot 与重复检查证明无安装下载副作用。
- 保留 v0.26.13 `qa-browser-runtime` 唯一 resolver、显式受控 Chrome、临时 profile、runId 与生命周期回收；不修改页面、ContentSet、内容事实、Content CLI、SitePublication 或 EdgeOne。

## 验证合同

- 安装策略 API/静态/环境覆盖/配置漂移/重复运行测试；v0.26.13 runtime 四种生命周期与 Mermaid 同 runtime 回归；既有 retained failures 分层记录。
- `npm run check`、`npm run release:prepare`、`npm run qa:browser:install-policy`、`npm run qa:browser:check`、`npm run release:qa`、`npm run release:closeout-check`、exact `release:build`、`npm run release:preflight`、`git diff --check`。
- 未执行 content publish 或 product transport；待产品/视觉独立验收。

## v0.26.13 — QA 浏览器运行时生命周期与残留治理

父版本：`v0.26.12` / `e20335a79109c6dee1e3632a2e0ccba8ac649420`

- 建立项目级唯一 `qa-browser-runtime` resolver，所有 Puppeteer 与 Mermaid 入口使用显式受控 Chrome、headless 临时 profile、runId manifest 和生命周期回收。
- 启动前拒绝 Chrome for Testing、Puppeteer/Playwright 自动下载缓存与非受控路径；正常、失败、信号和超时均执行本次 run 的进程/profile 残留核验。
- 新增 `qa:browser:check` 静态/运行前门禁；不修改页面、ContentSet、内容事实、Content CLI、SitePublication 或 EdgeOne。

## 验证合同

- resolver identity、禁止路径、headless/profile/run manifest、正常/失败/SIGTERM/timeout、重复运行和 Mermaid 同 runtime 测试。
- `npm run check`、`npm run release:prepare`、`npm run qa:browser:check`、`npm run release:qa`、`npm run release:closeout-check`、exact `release:build`、`npm run release:preflight`、`git diff --check`。
- 既有 retained content fixture、历史断言和环境失败分层记录，不隐藏、不修改内容事实。

## v0.26.12 — 共享 ActionGroup 可用宽度与窄屏安全边界

父版本：`v0.26.11` / `cba8406d707a5ec8c8e2a83096965973c3d47766`

- 为共享 equal-width `ActionGroup` 建立实际 inline-size container 预算；classic scrollbar 下自动进入共享安全模式。
- `/products` `320px` 最长 CTA 保持等宽、单行，并通过共享窄屏 token 保留至少 `4px` 文字安全边界。
- 不修改页面 gutter、文案、ContentSet、正文、审核、来源、媒体、content CLI、Coordinator 或 SitePublication 语义。

## 验证合同

- overlay/classic scrollbar 双环境记录 `innerWidth/clientWidth`、ActionGroup/button rect、文字 Range、safe inset、`scrollWidth`。
- 五路由 × `1600×1067`、`1280×1067`、`390×844`、`320×844`；Home/普通页入口、Products 卡片→标题、ClosingAction、视频、外链、axe、键盘和 Reduced Motion 回归。
- `npm run check`、`npm run release:prepare`、双滚动条 QA、`npm run release:build`、`npm run release:closeout-check`、`npm run release:preflight`、`git diff --check`；既有 retained failures 分层保留。

## 状态

Engineering local implementation checkpoint；待产品/视觉独立验收，尚未 product transport。

## v0.26.11 — 公网视觉差异收口

父版本：`v0.26.10` / `253d1d964338bb6f0bb9a53ac272a955f2e2ecb8`

- 收口 `/products` 版本卡→ProductHero 的单一 `24px` 关系 owner，移除移动端重复 ProductHero 上内边距。
- 将普通页面入口共享 token 固定为 Web `48px`、Mobile/窄屏 `32px`；首页独立 `64/40px` 保持不变。
- 共享 ActionGroup 在 `320px` 使用窄屏 action token，最长 Robotaxi CTA 保持等宽、单行并保留至少 `4px` DOM Range 安全边界。
- 不修改 ContentSet、正文、审核、来源、媒体、content CLI、Coordinator 或 SitePublication 语义。

## 验证合同

- 五路由 × `1600×1067`、`1280×1067`、`390×844`、`320×844`；Products/Observations/About 的入口与 CTA 计算几何、viewport、overflow、console、axe、键盘、Reduced Motion、媒体行为。
- `npm run check`、`npm run release:prepare`、视觉/交互 QA、`npm run release:build`、`npm run release:closeout-check`、`npm run release:preflight`、`git diff --check`；既有 retained failures 分层保留。
- 提交后 exact HEAD `release:build` 生成并校验 ProductArtifact；未执行 content prepare/build/transport/finalize。

## 状态

Engineering local implementation checkpoint；待产品/视觉独立验收，尚未 product transport。

## v0.26.10 — 全站垂直节奏与 ProductHero 密度

父版本：`v0.26.9` / `13119436d2a6f0a07f2a3316c3a81c23efd28c4c`

- 以语义 spacing token 和单一父级 flow owner 收口首页首屏、经营观察页眉、ShowcaseModule→ClosingAction 与 `/products` ProductHero 密度。
- 保持 Home/Products 独立 IA、ContentSet、媒体、正文、审核、来源和发布协调器边界不变。

## 验证合同

- `npm run check`、`npm run release:prepare`、内容检查、视觉 spacing、viewport/interactive/axe QA、`npm run release:closeout-check`、`npm run release:preflight`、`git diff --check`。
- 五路由 Web/Mobile/窄屏几何、键盘、Reduced Motion、视频与无障碍证据；提交后 exact HEAD `release:build` 生成 ProductArtifact；未执行 product transport 或 content publish。

## 状态

Engineering local implementation checkpoint；待产品/视觉独立验收，尚未 product transport。

## v0.26.9 — ClosingAction 浅色表面对比度收口

父版本：`v0.26.8` / `ae3820f45b6cddad57bc2301f318f0faf10ce396`

- 新增 `--color-text-muted-on-subtle: #526277` 语义 token，仅供浅色 ClosingAction summary 使用；全站 `--color-text-muted: #64748B` 保持不变。
- 保留 v0.26.8 的 B-01/B-02、页面独立投影、CTA、媒体与内容发布边界，不修改内容事实或发布架构。

## 验证合同

- `npm run check`、`npm run release:prepare`、视觉/axe 专项、`npm run release:closeout-check`、`npm run release:preflight`、`git diff --check`。
- 五路由 Web/Mobile/窄屏对比度与布局回归；提交后 exact HEAD `release:build` 生成 ProductArtifact；未执行 product transport 或 content publish。

## 状态

Engineering local implementation checkpoint；待产品/视觉独立验收，尚未 product transport。

## v0.26.8 — 首页作品锚点与 Product Presentation Closing Action

父版本：`v0.26.7` / `763861c57b9047b863841300c8d9acb4aa05bedf`

- 修正首页“最新作品”标签自身锚点，使其与 Robotaxi 标题左起点一致并保持 4px 紧邻；Robotaxi 标题与说明继续居中。
- 为 Home 与 `/products` 分别建立独立 Product Presentation Closing Action：Home 使用作品集语义与已登记 Robotaxi 操作，Products 使用既有 Robotaxi closing summary；两页均不显示默认“继续进入”。
- 不修改 ContentSet、正文、审核、来源、媒体、内容发布工具或 Site Publication 架构。

## 验证合同

- `npm run check`、`npm run release:prepare`、页面独立性/视觉专项、`npm run release:closeout-check`、`npm run release:preflight`、`git diff --check`。
- Web `1600×1067`、`1280×1067`、Mobile `390×844`、窄屏 `320×844`；五路由无溢出、H-02 几何、Closing Action 文案/独立投影、CTA/视频/键盘/Reduced Motion 回归。
- 提交后 exact HEAD `release:build` 生成并校验 ProductArtifact；未执行 product transport 或 content publish。

## 状态

Engineering local implementation checkpoint；待产品/视觉独立验收，尚未 product transport。

## v0.26.7 — 首页 CTA 共享尺寸回归修复

父版本：`v0.26.6` / `098499040449aadd8f4bdc14a11bd9fd9df10889`

- 将 Home ActionGroup 的对齐责任移到独立 Home 容器，恢复共享 `--measure-action-group` 等宽尺寸；桌面两个按钮约 218px，整体与 Hero 主轴居中。
- 保留 HomeProductProjection/ProductsShowcase 独立页面组合、CTA 文案/目标、H-02、视频和安全交互；不修改 ContentSet、正文、审核、来源、媒体或发布架构。

## 验证合同

- `npm run check`、`npm run release:prepare`、页面/视觉专项、`npm run release:closeout-check`、`npm run release:preflight`、`git diff --check`。
- Web `1600×1067`、`1280×1067`、Mobile `390×844`、窄屏 `320×844`；五路由无溢出、CTA/视频/H-02/经营观察回归。
- 提交后 exact HEAD `release:build` 生成并校验 ProductArtifact；未执行 content publish。

## 状态

Engineering local implementation checkpoint；待产品/视觉独立验收，尚未 product transport。

## v0.26.6 — 视觉验收收口与经营观察页面投影

父版本：`v0.26.5` / `8f219394c25a4527cd128c6b9b0d2cee873fcf7f`

- 收口 Home Hero 主轴与 ActionGroup、最新作品标签锚点；保留 Robotaxi 标题/说明居中并保持移动端 4px 绑定。
- 将经营观察 H1 提升到双栏前整行，建立左右同基线栏目标题；文章标题降级并关闭摘要、架构图投影，保留源字段、图片文件和正文 block。
- 保存具体 axe selector/node/HTML/颜色对比证据并收口 `color-contrast` serious violations=0；不修改 ContentSet、正文、审核、来源、媒体或发布架构。

## 验证合同

- `npm run check`、`npm run release:prepare`、分层 `release:qa`、视觉/交互 QA、`npm run release:closeout-check`、`npm run release:preflight`、`git diff --check`。
- Web `1600×1067`、Mobile `390×844`、窄屏 `320×844` 五路由 viewport-only 证据；页面独立性、键盘焦点、Reduced Motion、媒体行为和 axe 证据。
- 提交后 exact HEAD `release:build` 生成并校验 ProductArtifact；未执行 product transport 或 content publish。

## 状态

Engineering local implementation checkpoint；待产品/视觉独立验收，尚未 product transport。

## v0.26.5 — 页面独立内容接入与兼容重构

父版本：`v0.26.4` / `d5795b64a2a65bd13fe755e1ae4cc199c9384969`

- 首页与 `/products` 改为各自持有页面内容组合、CTA、媒体槽位与 ClosingAction；共享层只保留内容对象读取、无页面语义 primitives、tokens 与媒体安全能力。
- 移除 `ShowcaseFlow → PracticePresentation` 的页面级统一投影耦合，保留兼容入口与页面中立的模块槽位 helper；`pageDefinitions` 改为独立内容投影契约。
- 不修改 ContentSet、正文、审核、来源、媒体、ProductArtifact、SiteSnapshot、SitePublication、Coordinator 或既有内容身份。

## 验证合同

- 页面独立性回归：同一 Robotaxi 对象可由首页与 `/products` 分别读取，但一页结构/CTA/ClosingAction 变化不影响另一页。
- `npm run check`、`npm run release:prepare`、分层 QA、`npm run release:closeout-check`、`npm run release:preflight`、`git diff --check` 与提交后 exact HEAD `release:build`。
- Web `1600×1067`、Mobile `390×844`、窄屏 `320×844` 五路由每页一个 H1、无横向溢出、无 console/page error；保留 v0.26.4 的视觉与内容兼容合同。

## 状态

Engineering local implementation checkpoint；待产品/视觉独立验收，尚未 product transport。

## v0.26.4 — H-02 首页产品内容区标签位置

日期：2026-08-07

- 将首页 `最新作品` 从全页 Hero 眉题投影为产品内容区左上角结构标签，与 `Robotaxi运营平台` 标题保持 `--space-1`（4px）紧邻并共享左起点。
- 保留首页 Hero 的个人定位、说明和双 CTA；`/products` 不新增该标签，既有 OA-01～OA-05 保持不变。
- 不修改 ContentSet、正文、审核、来源、媒体、产品发布架构或既有内容身份。

## v0.26.3 — Baseline 2 视觉验收差异收口

日期：2026-08-07

- 首页主 CTA 与产品页 CTA 按页面语义分离；共享 Hero ActionGroup 提供桌面/移动等宽按钮能力。
- ShowcaseModule 隐藏重复 group/label；ProductHero 与 ClosingAction 收紧当前产品的 boundary、默认 eyebrow 和重复摘要。
- MediaStage 保留单层低扩散轻阴影；内容、About、简讯和行动区不复用媒体阴影。
- 不修改 ContentSet、正文、审核、来源、媒体、ProductArtifact、SiteSnapshot、SitePublication、Coordinator 或既有页面事实。

## v0.26.2 — 全站视觉 Baseline 1→2 差异与组件契约

日期：2026-08-07

- 在既有 PageComposition、ShowcaseModule、ObservationRail、RichDocument、ClosingAction 与 tokens 上收敛 Baseline 1→2 的局部视觉差异。
- 首页补齐最新作品、产品 ClosingAction 与最新观察简讯；经营观察分离页面 H1 与右侧最新简讯；产品页收紧空槽位并保留 NEW、真实版本和已登记动作。
- 手机端 ShowcaseModule 保持说明在上、媒体在下，ClosingAction 改为等宽纵向动作；阅读内容保持近乎平面的冷白表面，辅助文字统一为 `#64748B`。
- 不修改 ContentSet、正文、审核、来源、媒体、ProductArtifact、SiteSnapshot、SitePublication、Coordinator 或既有页面事实。

## v0.26.1 — ProductArtifact 规范化身份与 SiteSnapshot 契约

日期：2026-08-06

- 建立唯一 ProductArtifactIdentity 适配器，将 release、content-manifest、base-site-artifact 规范化为稳定扁平身份四元组与 hash。
- SiteSnapshot、ContentSet manifest、PublicationRun、SitePublication 和 Coordinator 只消费规范化身份；未规范化对象、缺字段和身份漂移在组装前硬失败。
- 复用 v0.26.0 已迁移的 35-entry active ContentSet，不修改内容正文、审核、媒体、页面或视觉事实。
- 当前上线状态：Engineering 本地实现与门禁进行中，尚未推送 GitHub 或发布 EdgeOne。

## v0.26.0 — 发布内核与 ContentSet 架构重构

- 建立 `ContentSet v1` 作为全部公开内容（含 Home 首页入口）的唯一运行 active 身份，使用不可变集合文件与原子 `active.json` 指针；旧 receipt、Registry、lineage、projection 和 package 仅保留迁移/审计用途。
- 建立 `ProductArtifact`、`SiteSnapshot`、`PublicationRun` 三对象闭环；产品与内容独立准备，Site Publication Coordinator 串行执行一次 deployment、传播验证、原子 active 切换与整站 rollback。
- 现有产品/内容 publish 入口统一委托 Coordinator；最终 commit/tag/clean 后才生成并校验精确绑定 HEAD/tag 的 ProductArtifact，保留既有 UI、IA、schema、正文、审核、媒体和视觉事实。

## v0.25.19 — 内容收据与活动站点投影单一身份

- 保持不可变 `ContentReleaseReceipt.receiptHash` 为 package receipt 身份，新增确定性的 `ActiveContentProjection.projectionHash` 作为 Registry、lineage binding 与 ProductArtifact 组合后的活动投影身份。
- `readActiveContentReleases`、`createActiveContentSet`、manifest、SitePublication assembly、Coordinator publicVerify/finalize/resume 统一消费同一个 projection resolver；旧 projection 只能隔离兼容，不能与新 projection 混组。
- 覆盖真实 34 active corpus、Robotaxi replacement、About recoverable package、resume 幂等、projection/binding/ProductArtifact drift、CAS 竞争及失败不污染 active；不修改页面、内容正文、审核、媒体或既有身份。

## v0.25.18 — ContentSlotRegistry 权威边界与一次性 Legacy 迁移

- 将 ContentSlotRegistry 读取拆分为 authoritative read 与显式 legacy bootstrap；权威 Registry 建立后，日常 prepare/build/transport/resume 不再扫描旧 package corpus。
- 保留缺失或 legacy Registry 的严格迁移门禁：缺 predecessor、多个 active leaf、冲突、schema/迁移证明 hash drift 与 CAS drift 均硬失败，不猜测 active。
- Coordinator、ContentLifecycleAdapter、reconcile、resume 和 SitePublication active projection 继续复用同一 Registry、PublicationLineageBinding、lease、bounded publicVerify 与 atomic finalize；不创建第二套 lifecycle/coordinator。
- 使用真实 v0.25.17 corpus 验证 authoritative+历史冲突可运行，缺失/legacy bootstrap 仍阻断；不修改 UI、IA、schema、视觉、正文、审核、媒体或既有 contentReleaseId。

## v0.25.17 — 不可变 Revision 与 Registry Lineage Binding

- 新增不可变 `PublicationLineageBinding` sidecar，以 `ContentSlotRegistry` 的真实 active receipt、registry revision 和 binding hash 固化 replacement predecessor。
- 既有 `revision-9bb22df0f30845e8` resume 只读 Registry，自动绑定 `practice-robotaxi-d67fcedd760acc5a`；不回写旧 package/revision、正文、媒体、ChangeSet 或 hash。
- SitePublication、Coordinator finalize、receipt/completion projection 统一消费 binding；binding drift、Registry CAS 竞争、传播失败保留旧 active，同一 publication resume 不重复 deployment。
- 保留 v0.25.16 的 UI/IA/schema/视觉、34 active 内容和独立内容身份；本版本仅完成 Engineering 能力，不执行内容或产品 transport。

## v0.25.16 — 内容活动槽位注册表与原子替换发布

- 建立版本化 `ContentSlotRegistry`，从真实 finalized receipt/released package corpus 迁移唯一 active slot；冲突、漂移和无法解析的 lineage 硬失败，不猜测覆盖。
- 跨 kind 由 registry 解析 `predecessorReceiptId`；immutable ContentRevision 保留 before/after、ChangeSet、review/provenance 与 recovery，candidate 不得自填或自指 predecessor。
- SitePublication 从 ProductArtifact、registry active set 与 candidate 生成唯一 snapshot；精确公网验证后用 predecessor compare-and-swap 原子推进 active，同 publication resume 幂等且不重复 deployment。
- 兼容现有 Practice 四槽 package/revision 与 34 条 active 内容；不修改正文、审核、媒体、UI/IA/schema 或既有内容身份，本版本不执行内容或产品 transport。

## v0.25.15 — 内容类型生命周期适配与 Package 证明式 Reconcile

- 按内容 kind 建立唯一 `ContentLifecycleAdapter` registry；Practice 使用 products canonical、Practice review、media approval/provenance 与 package recovery，不再要求通用 `drafts/robotaxi.json` 或 `recoveries/robotaxi.json`。
- immutable package 保存/兼容读取 before/after snapshot、ChangeSet、review envelope 与 recovery envelope；reconcile 校验 canonical before + 确定性 operations 得到 package after/contentHash，只重新绑定 ProductArtifact。
- public verify 后由同一 adapter 原子推进 Practice canonical after，保留 before recovery，失败不污染旧 active；Observation、Article、Profile、BusinessObservation 保持各自生命周期合同。
- 保留 v0.25.14 的视觉、五路由、34 active 内容、四槽媒体与独立内容身份；本版本仅完成 Engineering 能力，不执行内容或产品 transport。

## v0.25.14 — 内容首次发布与修订发布时间分层

- 将 logical content 的 `firstPublishedAt` 与 package revision 的 `revisionReleasedAt` 分离；`publishedAt` 继续只投影首次公开时间。
- 旧 receipt 的 `publishedAt` 只读兼容为 `firstPublishedAt`；replacement candidate 的空 revision 时间合法，显式首次发布时间漂移硬失败。
- receipt、completion、package/public projection、reconcile 与 Coordinator finalize 复用统一生命周期时间解析；保留 v0.25.13 的视觉、34 active 内容、四槽和五路由边界，不执行内容 transport。

## v0.25.13 — 多字段内容变更与稳定逻辑身份

- 将稳定 `logicalContentId` 与变化中的 `contentHash`、物理 `packageRevisionId` 分层；同一内容对象的后继 revision 不再因 hash 更新被误判为新逻辑对象。
- ChangeSet 支持确定性 `operations[]`：四个 Robotaxi `mediaId` 槽位可一次原子 staging，逐项校验 before/after hash、注册目标、媒体 approval/provenance；旧单字段输入归一为一项。
- receipt、completion、package lineage 与整站 projection 保存 logical identity、changeSetId、完整 changedTargets；replacement 按 logical slot 选择，失败不污染旧 active。
- 保留 v0.25.12 的页面、视觉、34 个 active 内容与发布边界；本版本仅完成 Engineering 能力与本地验证，不执行内容或产品 transport。

## v0.25.12 — 产品内容兼容合同单一枚举与前置门禁

- 将 `contentImpact` 收敛为 `none`、`compatible`、`migration-required`、`breaking`、`unknown` 封闭枚举，并以独立 `contentImpactReason` 保存说明。
- `npm run check`、`release:closeout-check`、`release:preflight` 与 SitePublication Coordinator 复用唯一兼容性 validator；非法枚举、缺字段和缺证据在 transport 前硬失败。
- 保留 v0.25.11 已验收的视觉、响应式、视频、五路由与 34 个 active 内容事实；不执行内容 transport。

## v0.25.11 — Showcase 间距单一责任与视觉验收收口

- 保留 v0.25.10 已通过的页面、媒体与内容边界，只移除 Showcase 新旧样式的责任冲突。
- `.showcase-module` 唯一负责说明列、媒体列及 copy→media 间距；`.practice-module-list` 唯一负责 module→module 间距。
- 新增 Web 1600/1280 与 Mobile 390 的 computed geometry 回归，禁止旧 `.practice-module` 覆盖或 sibling margin 重复计距。
- 产品/视觉独立验收通过前不执行产品或内容 transport。

## v0.25.10 — Web 视觉定稿几何与完整展示验收修正

- 保留 v0.25.9 VisualSystem、PageComposition 与 MediaAction，只把 Header、更新卡、ProductHero、首页中心轴和媒体浮起收口到已确认 Web 几何。
- 更新卡公开内容收敛为最新更新、Robotaxi 真实版本和查看最新版；commit 与核验状态只保留内部证据。
- 增加显式 QA fixture 证明四个独立 mediaId 槽可引用同一批准媒体，并独立保留 empty fallback；不改变正式内容事实。
- 产品/视觉验收通过前不执行产品或内容 transport。

## v0.25.9 — 全站统一视觉系统与结构化页面组合

- 全站页面组合改用共享冷白、sans-led VisualSystem，统一 shell、版心、间距、按钮、焦点、媒体比例与空/错误状态。
- `/products` 使用共享 `ShowcaseFlow`、`ProductHero`、`ShowcaseModule`、`MediaStage`、`ClosingAction`；Robotaxi release 版本通过同源白名单 adapter 投影，媒体入口保持安全跳转。
- 首页、经营观察、观察集合、About 使用统一页面组合；About 提供经 career 核验的 HTML/PDF `ResumeArtifact`，不新增联系方式或继续阅读。
- 本地产品能力版本；保留独立内容正文、审核、媒体 provenance、hash 与 contentReleaseId，产品/视觉验收前不执行内容 transport。

## v0.25.8 — ContentReleaseReceipt 投影一致性与 active 快照

- 单条 `ContentReleaseReceipt`（`content-release.json` + `completion.json`）成为 logical release 唯一事实源；finalized package 的派生 projection 只校验自身 identity，不再承担全局 active 集合。
- 新增规范化 `ActiveContentSet`，由全部 finalized receipts 与 candidate 生成唯一 `activeContentReleaseIds`、slug、practice、media 和 receipt projection，再物化整站 SitePublicationSnapshot。
- Didi finalized 的缺失/旧 package 全局字段不会丢失 active；保留唯一 lease、同 publication/deployment resume、整站 publicVerify 与 atomic finalize 边界，不修改正文、审核、hash、IDs 或历史版本。

## v0.25.7 — SitePublication 传播恢复与内容决策边界

- bounded propagation 将完整但暂不一致的公网身份视为 recoverable，逐次保存 expected/observed identity、attempt、时间与 deploymentId；部分 manifest、hash、target、source、review 或 base 漂移仍硬失败。
- 同一 SitePublication 通过同一 lease 和 deploymentId resume，传播收敛后执行精确整站 publicVerify 与原子 finalize；超出有界窗口才保留 recovery 并形成 Incident，不污染既有 active 内容。
- 覆盖传播延迟、永久漂移、重复 resume 和 active 保留回归；不修改内容正文、审核、媒体事实、既有 contentReleaseId、产品 UI/IA/schema/视觉或 v0.25.6 tag/history。

## v0.25.6 — 内容发布替换 revision 与 active 生命周期

- logical identity 与 immutable `ContentPackageRevision` 分离；Coordinator 依据 `supersedesPackageId`、revision tuple 和 lineage 将合法 replacement 放入唯一 active slot。
- replacement 在组装前校验正文 hash、kind、target、source lifecycle、approved review 与当前 ProductArtifact；任何漂移硬失败且不污染旧 active。
- SitePublication identity 显式包含 replacement revision，重复 resume 复用同一 snapshot/deployment；公网 manifest 精确校验 revision receipt 与 lineage。
- 三个既有 Brief revision 已在 v0.25.5 ProductArtifact 上完成本地 replacement 快照验证；不修改正文、审核、媒体、发布时间或既有 `contentReleaseId`，不执行内容 transport。

## v0.25.5 — 内容发布站点快照身份与可恢复发布

- `content-release.json` 与 `completion.json` 组成 `ContentReleaseReceipt`，成为 active 生命周期唯一事实；旧 dist 投影缺失基座字段不再导致内容静默丢失。
- Coordinator 从当前 ProductArtifact、全部 active receipt 与 candidate 原子生成完整 manifest，绑定 sitePublicationId、snapshotHash、target 集合、媒体与 receipt hash。
- 全站单一 lease、同快照 deployment resume、全量页面/媒体/manifest 公网验证和恢复状态阻止重复部署与失败污染 active。
- 产品构建继续隔离独立内容；本版本不修改正文、审核、媒体事实或既有内容身份，不执行内容发布。

## v0.25.4 — 全站视觉结构与媒体交互

- Home、Showcase、Reading、Collection 页面组合统一使用共享视觉结构、文本增长、焦点、空状态和媒体降级合同。
- MediaAction 复用既有媒体与登记 action：整块媒体安全跳转 Robotaxi，视频不自动播放、不显示 controls，键盘与 accessible name 完整。
- 无 action 媒体保持只读展示；媒体缺失或失败提供同源可读 fallback，Reduced Motion 关闭非必要过渡。
- 产品能力版本；不修改或重发独立内容。

## v0.25.3 — Practice 页面能力与媒体投影修复

- `/products` Practice Hero 居中并使用受控文本换行，保持移动端无溢出。
- runtime reader 由既有 manifest `directory` 登记关系解析 Practice 身份，使已审核 Robotaxi 视频投影到首个模块，其余模块 media 为空。
- CTA 仅接受已登记的安全 HTTPS 产品域名，并与视频 controls 分离，保持键盘可达。
- 产品模式继续关闭独立内容读取；本地产品能力版本，不执行内容发布。

## v0.25.2 — 内容发布包身份重建与幂等恢复

- 在同一逻辑 `ContentReleaseIntent` 下生成由 content/source/base/contract tuple 决定的 immutable `ContentPackageRevision`，保留旧包、recovery 与 lineage。
- `--reconcile` 在 prepare 前校验 canonical/draft/recovery、approved review、hash、target 与 immutable base artifact；同 tuple 幂等复用 revision 与 `ContentBatchPlan`。
- active 读取按逻辑 release 去重，失败 revision 不污染既有集合；released revision 才替代旧物理包，resume 与 SitePublication 绑定 revision 身份。
- 本地产品能力版本；不执行内容 transport 或产品 publish，待产品/视觉验收。

## v0.25.1 — 内容批次发布与 active 身份一致性

- 引入确定性 ContentBatchPlan，按文件数、单文件/总大小、target 与媒体路径冲突分片；每条 intent 只进入一个分片并保留独立证据。
- active 读取要求 package 根生命周期、包内 manifest、completion 与 immutable baseSiteArtifact 身份一致；失败保留 recovery，不发布产品版本。
- 本地版本，未 push、publish、deploy，待产品/视觉验收。

## v0.25.0 — 产品、内容与站点发布三层架构重建

- 以 `SitePublication` 为唯一物理站点发布对象；产品 `ProductRelease` 与内容 `ContentReleaseIntent` 保持独立身份和生命周期。
- 产品与内容 transport 统一通过唯一 Coordinator 合并快照、取得 lease、保存 deployment JSON、等待传播、精确公网验证和可恢复 finalize。
- Deploy Success 不再等同于网站发布成功；缺少完整公网证据时返回 Incident/recoveryId，resume 复用同一 deployment，不重复部署。
- 本地治理版本，未 push、publish、deploy；线上继续冻结 v0.24.37。

## v0.24.38 — 内容 deployment 恢复与传播验证

- 持久化 deployment JSON/site-publication，已有 deployment resume 只验证不重复上传。
- 公网验证记录 elapsed/attempts，传播超限保持 recoverable。
- 本地版本，未 push/publish/deploy。

## v0.24.37 — 内容 transport 当前产品基座绑定

- 内容 transport 只使用当前产品 immutable client；旧 package 基座与当前 release/artifact 不一致时部署前硬失败。
- 本地版本，未 push/publish/deploy。

## v0.24.36 — 首次候选合并快照修正

- 首次候选在 deployment 前按 contentReleaseId/contentHash/target/baseArtifact 加入合并快照，部署后回写 deploymentId 再验证与 finalize。
- 本地版本，未 push/publish/deploy。

## v0.24.35 — 合并快照公网验证修正

- 单条内容保持精确 contentReleaseId；合并快照验证 activeContentReleaseIds、candidate、基座、产品身份与候选页面。
- 本地版本，未 push/publish/deploy。

## v0.24.34 — 内容恢复 CLI 与异步 transport 配额门禁

- 暴露 `--resume --package` CLI，保存 deploymentId 并支持同一 package resume。
- 上传前执行文件数、单文件和总大小配额预检。
- 本地版本，未 push/publish/deploy。

## v0.24.33 — 内容增量 transport 接口

- 内容 transport 生成新的 active+candidate sitePublication identity 与独立 deployment，不复用旧 candidate deployment。
- lease/idempotency 绑定合并 publication，combined verify 成功后才 finalize。
- 本地版本，未 push/publish/deploy。

## v0.24.32 — 内容增量合并发布恢复

- 内容新增/恢复通过统一 sitePublication 合并 8 个 active 与当前 candidate，禁止孤立覆盖。
- 失败保留 active 与 recovery，复用 lease/idempotency。
- 本地版本，未 push/publish/deploy。

## v0.24.31 — 内容生命周期事实源读取修正

- 以 content-release.json 作为 active 生命周期事实，dist manifest 仅做身份、hash、target 与 base artifact 校验。
- 保留 8 个已成功内容 release，不重新发布、不修改内容事实。
- 本地版本，未 push/publish/deploy。

## v0.24.30 — 统一站点发布快照与内容保留

- 产品与 active content releases 合并为单一 sitePublication 快照，防止互相覆盖。
- deployment JSON 与产品/内容公网验证均为 released 必需证据。
- 本地版本，未 push/publish/deploy。

## v0.24.29 — 产品发布门禁与内容基座解耦

- 分离确定性产品构建门禁与环境型 Mermaid/Puppeteer QA；环境 incident 独立记录，不降低身份、clean、manifest、公网门禁。
- 明确内容可复用已登记兼容 immutable baseSiteArtifact，不等待未上线产品版本。
- 本地版本，未 push/publish/deploy。

## v0.24.28 — 持续自动闭环与协作身份治理

- 收口持续自动闭环、活动 task 身份注册、Xing 称呼与图形优先输出基线。
- 产品与独立内容发布保持边界；本地版本，未 push/publish/deploy。

## v0.24.27 — 内容发布状态机与幂等恢复

- 状态：Engineering 实现独立 contentRelease 状态机、lease/幂等 resume、有界公网验证和独立 finalize；待本地 commit/tag/clean、产品/视觉验收与用户授权，未再次 publish。
- 范围：`prepared → built → transported → verifying → finalized → released` 与 failed/recoverable/rolled-back 事实；同一内容包/基座不重复部署；失败保留所有 ignored 生命周期证据；30 条 observations 串行失败隔离。
- 不做：不修改正文、来源、status、publishedAt、UI、IA、schema、路由、上游事实或 v0.24.26 tag/history；不创建 branch、worktree、task、automation。

## v0.24.26 — 空内容安全与完整内容目标能力

- 状态：Engineering 完成空内容解析安全与 profile/businessObservation 独立内容目标能力，待本地 commit/tag/clean、产品/视觉验收与用户授权；未 push、publish、部署或公网验收。
- 范围：缺失内容安全返回 null/空集合；五类内容目标独立生成 contentReleaseId、contentHash、baseSiteArtifactId、deployment、publicVerify；产品构建继续隔离独立内容根。
- 不做：不修改 UI、IA、schema、路由、上游事实、v0.24.25 tag/history 或内容任务边界；不创建 branch、worktree、task、automation。

## v0.24.25 — 产品与独立内容发布边界解耦

- 状态：产品构建与独立内容根隔离；待 Engineering local commit/tag/clean、产品/视觉验收和用户 publish，未 push、publish、部署或公网验收。
- 范围：产品 build 只消费产品能力与稳定源，独立内容仅在显式内容 staging build 中叠加；产品 dist/manifest 不携带独立正文、媒体或内容发布身份。
- 不做：不修改 UI、IA、schema、路由、上游事实、v0.24.24 tag/history 或独立内容 task；不创建 branch、worktree、task、automation。

## v0.24.24 — 内容源与不可变产品基座解耦

- 状态：本版本实现实际 source bundle 基座、独立内容根与稳定能力模板；待本地 commit/tag/clean 后产品/视觉验收，未 push、publish、部署或公网验收。
- 范围：内容 staging 只从显式 immutable `baseSiteArtifact` 叠加独立内容快照；日常内容/媒体不再作为产品 Git 输入；registry 不枚举当前 asset/module ID。
- 不做：不改 UI、IA、schema、路由、页面结构、视觉系统、上游事实、产品 publish 逻辑或 v0.24.23 tag；不创建 branch/worktree/task/automation。

## v0.24.23 — 统一媒体合同与独立内容基座

- 状态：本版本实现 image/video MediaAsset、空媒体模块、媒体字段级 ChangeSet/recovery 与 immutable `baseSiteArtifact` 内容发布基座；待本地 commit/tag/clean 后产品/视觉验收，未 push、publish、部署或公网验收。
- 范围：内容 prepare/build/transport 使用独立 `contentReleaseId`、manifest/log 和 ignored package，不读取当前产品 HEAD/tag/current/preflight，不污染产品版本身份；保留产品 publish transport-only。
- 不做：不修改 UI、IA、schema、路由、页面结构、视觉系统、上游事实、Practice video 特例或 v0.24.22 tag；不创建 branch/worktree/task/automation。

## v0.24.22 — Registry 固定合同与 rollback 基线漂移门禁

- 状态：本版本固定 Robotaxi registry 来源/路由/类型合同，并在 rollback 前校验 canonical 原始 before 基线；未 push、publish、部署或公网验收。
- 范围：仅 registry 完整性和 ChangeSet recovery 校验；不改变 v0.24.21 tag，不扩大内容字段或页面能力。
- 不做：不改 UI、IA、schema、路由、组件、CSS、交互、上游事实、Practice video、内容事实或产品发布逻辑。

## v0.24.21 — 内容目标入口与可验证恢复包

- 状态：本版本补齐非发布 `content:target` 定位卡/ChangeSet 入口、原始变更事实关联和逆向 recovery package；未 push、publish、部署或公网验收。
- 范围：仅增强既有 registry、字段级 ChangeSet 与内容 prepare/build/transport；增加 registry 完整性与路径边界门禁，不扩大 UI、IA、schema、页面或内容白名单。
- 不做：不修改 v0.24.20 tag，不改 UI、IA、schema、路由、组件、CSS、交互、上游事实、Practice video 或产品发布逻辑。

## v0.24.20 — 声明式 B 端内容定位与字段级 ChangeSet

- 状态：本版本完成 registry 消费、Robotaxi 字段级 ChangeSet、Practice staging overlay 与独立内容边界；未 push、publish、部署或公网验收。
- 范围：仅支持已登记 `products.robotaxi` 字段；ChangeSet 写入 ignored `.content-workspace/changes/`，复用现有内容 prepare/build/Practice 校验/独立 transport。
- 不做：不修改 UI、IA、schema、路由、组件、CSS、交互、上游事实、产品发布逻辑、产品版本外内容或 v0.24.19 tag。

## v0.24.19 — 产品工程协作治理基线结构化

- 状态：已完成五层规则与 Agent 入口治理的本地实现，待 Engineering 自 QA、local commit/tag/clean 和产品/视觉验收；未 push、publish、部署或公网验收。
- 范围：新增统一基线索引、职责/内部流程、跨 task 协作和 Engineering 架构正文；明确 `sourceThreadId`、`targetThreadId`、`returnThreadId` 分离、一次回传、长任务 ACK 与禁止轮询；将迭代与发布规则收敛为产品版本闭环；保留产品总案和内容/Ops 独立合同。
- 不做：不修改 v0.24.18 tag、产品 UI/IA/schema、内容、上游事实、产品总案、内容运营合同或 publish 业务逻辑；不创建并行 task、branch、worktree 或 automation。

## v0.24.18 — 无状态产品工程迭代闭环

- 状态：本版本采用 current→Engineering→local commit/tag→history→验收→publish 的无状态闭环；未 push、publish、部署或公网验收。
- 范围：移除 current/history 生命周期状态字段；closeout/preflight 直接从 Git、版本文件和工作区推导本地事实；history 在 local commit/tag/clean 后一次性生成。
- 不做：不修改 v0.24.17 tag、UI、IA、schema、内容、上游事实或独立内容发布合同。

## v0.24.17 — Ops 定时采集与内容 task 唯一职责治理

- 状态：Engineering 已完成唯一调度身份与 task 责任治理、自 QA；待本地 commit/tag 后产品/视觉验收，未 push、publish、部署或公网验收。
- 范围：登记唯一 `xingbuild` 调度器、Ops 长期责任 task、运行 task 与内容接收 task；明确自动化资源创建门禁；禁止内容 task 创建、复制或替代定时采集；保留现有内容独立发布身份。
- 不做：不删除或暂停既有 task/自动化；不修改 UI、IA、schema、内容、上游事实、产品发布逻辑或 v0.24.16 tag。

## v0.24.16 — 内容运营独立发布治理

- 状态：Engineering 在 direct-local main 完成内容独立发布引擎、临时 staging 构建与产品/内容发布边界收口；待本地 commit/tag 后产品与视觉验收，未 push、publish、部署或公网验收。
- 范围：内容 publish 使用独立 `contentReleaseId` 与 ignored 发布包，不读取产品 HEAD/tag/preflight/closeout 门禁，不修改产品版本文件或创建产品 tag；产品 publish 保持 transport-only。
- 不做：不修改 UI、IA、schema、外部数据层、上游事实或 v0.24.15 tag。

## v0.24.15 — v0.24.14 本地收口状态事实修正

- 状态：Engineering 修正当前版本自然语言与 `localSubmission`/commit/tag 实际状态的一致表达；不回写或移动 v0.24.14 tag。
- 范围：仅版本记录与 current/history 状态事实；不改 UI、IA、schema、内容、上游事实、publish 脚本或规则。

## v0.24.14 — 发布 transport 目标与故障决策门治理

- 状态：Engineering 在 direct-local main 完成发布规则定点修正、自 QA 与本地收口；提交后的产品/视觉验收、publish 授权和线上状态仍为外部事件。
- 范围：统一 prepare/build/closeout/preflight/transport 四阶段；publish 只消费既有 HEAD/tag 与预生成 manifest；固定 EdgeOne 目标；新增 Publish Incident 失败停止与路由合同。
- 不做：不修改 UI、IA、schema、内容或上游事实；不回写 v0.24.13，不移动既有 tag；不在本版本 push/publish/deploy。

## v0.24.13 — transport 合同测试收口

- 状态：Engineering 修正 transport-only 发布合同的 Practice/范围测试断言并完成自 QA；v0.24.12 tag 保留不动。
- 范围：测试只验证精确目标 manifest 与 transport 边界，不要求 publish 阶段运行业务 scope-check。

## v0.24.12 — publish 纯传输部署与预生成产物合同

- 状态：Engineering 已完成 publish transport 拆分与自 QA；publish 只消费预先生成且身份匹配的 `dist/client`，业务验证和构建在 publish 前完成。
- 范围：新增 `release:prepare`/`release:build` 业务准备入口；publish 不运行 check、build、Sites、生成器或内容业务 QA。

## v0.24.11 — 发布构建只读消费已提交生成物

- 状态：Engineering 已完成构建纯度根修正与自 QA；生成器保持显式源变更命令，release build 只消费已提交生成物。
- 范围：移除 build/release:check/publish 对 tracked-output generators 的无条件调用；构建后 tracked dirty 仍硬失败。

## v0.24.10 — 不可变版本身份与提交后事件分离

- 状态：Engineering 已完成本地 commit/tag 与自 QA；提交后的产品/视觉验收、publish 授权和线上状态由外部 QA、显式授权参数与 release manifest 承担。
- 范围：current/history 只保存 localSubmission 等不可变版本身份事实；不因验收、授权或线上变化回写已打 tag 文件。

## v0.24.9 — 版本状态机与收口事实治理

- 状态：Engineering 已完成状态字段、事实一致性门禁与自 QA；待本地 commit/tag 后产品/视觉验收，尚未 push、publish、部署或公网验收。
- 范围：current 统一记录 localSubmission、productVisualAcceptance、publishAuthorization、onlineRelease，并由 closeout/preflight 阻止自然语言、Git/tag 与线上事实矛盾。

## v0.24.8 — 统一发布消费现有版本与构建纯度治理

- 状态：Engineering 实现与自 QA 已完成，待本地 commit/tag 与产品/视觉验收；尚未 push、publish、部署或公网验收。
- 范围：统一发布只消费已验收现有 local commit/tag；构建沙箱记录并拒绝 tracked dirty；授权、失败短路和同一 version/commit 公网验证形成集成合同。

## v0.24.6 — 版本身份冲突收口
- 状态：Engineering 本地提交版本；已完成版本身份冲突收口、自 QA、版本记录、commit 与 annotated tag；尚未 push、publish、部署或公网验收。
- 范围：保留既有 v0.24.5 tag，将动态版本测试修复统一转入 v0.24.6。

## v0.24.5 — 统一发布版本动态一致性测试修复
- 状态：Engineering 本地提交版本；已完成测试合同修复、自 QA、版本记录、commit 与 annotated tag；尚未 push、publish、部署或公网验收。
- 范围：动态校验 package.json、package-lock.json、VERSION.md 与 current.md 的统一版本身份；固定测试夹具行为版本保持不变。

## v0.24.4 — 候选转产品设计与归档治理
- 状态：Engineering 本地提交版本；已完成候选生命周期治理合同、版本记录、自 QA、commit 与 annotated tag；尚未 push、publish、部署或公网验收。
- 范围：候选仅属于产品设计前阶段；正式方案继承或关闭后立即归档，Engineering 只读取 current 与正式方案。

## v0.24.3 — v0.24.2 状态表达修订
- 状态：Engineering 本地 current-fix 已完成；已形成 v0.24.3 本地 commit/tag，产品/视觉验收待确认；origin/main 尚未同步，未 push、publish、部署或公网验收。
- 范围：仅修正 current.md 对 v0.24.2 本地 commit/tag、产品/视觉验收状态与 origin/main 未同步的准确表达。

## v0.24.2 — 工程与 task 治理本地提交版本
- 状态：Engineering 本地提交版本；已完成治理合同实现、自 QA、版本记录、commit、annotated tag；尚未 push、publish、部署或公网验收。
- 范围：统一 canonical direct-local、task 创建/交接权限、Engineering 自 QA、本地提交版本、产品/视觉验收与线上 publish 状态边界；不修改 UI、IA、schema、上游事实或运营内容。

## v0.24.1 — 统一版本发布
- 状态：统一版本发布；内容、产品、Git、tag 与公网 manifest 共用同一版本身份。

## v0.24.0 — 统一版本发布
- 状态：统一版本发布；内容、产品、Git、tag 与公网 manifest 共用同一版本身份。
# xingbuild 版本记录

## v0.23.0 — 统一能力展示控件与可组合表达

- 当前状态：已发布并完成公网验收；发布 commit/tag 为 `3d2f90c39ac5952aa122d1d4ee6aacd117b65e28` / `v0.23.0`，EdgeOne deployment 为 `dp9oxdxvo4a4`。
- 范围仅建立声明式 CapabilityStage/VisualizationHost、统一状态/失败降级与响应式能力空间，并用既有图形和 Showcase/SystemStage 做 fixture。
- 不修改 Robotaxi 上游、Observation/Practice schema、主题、一级导航、公开运营内容或内容发布边界。

## v0.22.0 — 企业经营体系多视图架构阅读能力

- 当前状态：已发布并完成公网验收；发布 commit/tag 为 `7ad9edd0e3cc4888bbaece0ddeace0cc32bf270c` / `v0.22.0`。
- 范围仅为企业经营体系文章内 LikeC4 只读多视图：总览、业务、数字化与 B 端产品架构，以及稳定进入、返回、焦点恢复和响应式文本降级。
- 不实现通用 CapabilityHost/VisualizationHost 平台，不改 Robotaxi、Practice、Observation、Article 内容事实、全站主题或内容发布合同。

## v0.21.0 — Practice 内容独立发布能力

- 当前状态：Engineering 实现与本地验证进行中；尚未提交、tag、推送、部署或公网验收。
- 范围仅建立单一 Practice 的内容 scope check、独立发布命令及目标公网投影验证；日常 Practice 内容提交不改变产品版本或 tag。
- 不修改页面、Practice schema、Robotaxi 事实或媒体审批结论、Observation、Article、About 和 EdgeOne 配置。

## v0.20.0 — 页面定义注册与既有页面组合渲染

- 当前状态：页面定义 registry、四种既有组合 renderer、`/about` 迁移与同组合 fixture 已实现；自动检查、六档本地页面验证和产品/视觉独立验收完成，尚未推送 GitHub、部署或公网验收。
- 范围仅建立受控 `PageDefinition` registry 与共享 composition renderer，保持既有 URL、内容对象、视觉 token、Header、Footer、ReturnNavigation、Observation/Article schema 和发布命令不变。
- 不实现 `VisualizationHost`、`CapabilityHost`、LikeC4 原生 runtime、自由画布或 Robotaxi embed；不迁移全部页面、不删除旧实现、不修改内容事实。

## v0.19.0 — 企业经营体系常青长文与图形内容能力

- 当前状态：已发布并完成公网验收；发布 commit/tag 为 `43a08ab6200405c753b5766f75f544827a1e38e8` / `v0.19.0`。
- 范围仅将企业经营体系迁移为内容驱动的常青文章、共享目录与构建期静态 SVG figure，并建立后续单 slug 文章内容发布边界。
- 不修改上游企业经营事实、网站结构、Robotaxi、Observation Brief、Header、Footer 或其他 backlog。

## v0.18.0 — 企业经营体系多层架构浏览器重构

- 当前状态：已发布并完成公网验收；发布commit/tag为`ec747f5337f044b4679d3796f3ee3322e98bf945` / `v0.18.0`，EdgeOne deployment为`dp9h2l7g0lep`。
- 范围仅限数字化实现架构浏览器：LikeC4 语义模型与生成数据、受控 React DOM + SVG 投影、三层关系浏览与无障碍交互。
- 不修改网站结构、frameworkModel 权威事实、Robotaxi、Observation、Article、About、Header/Footer、内容或发布能力。
- 发布后真实使用确认该实现只解决单一局部图，不具备多图、多层内容化扩展能力；后续纠正进入独立`v0.19.0`，不重写本版本tag。

## v0.17.0 — 企业经营体系固定架构图与全站返回统一

- 数字化实现固定为可读的 Architecture Spine：完整 9 节点、13 条关系和闭环在稳定几何中默认呈现；选择只更新强调与权威说明。
- GraphCanvas 关闭平移、缩放与复位，不再保留局部私有工具栏；窄屏保留完整关系线，并在当前节点说明后提供同源完整关系清单。
- Article、观察集合与企业经营体系局部视图统一使用安全、可恢复焦点的 `ReturnNavigation`；不改变业务事实、网站结构或其他内容。
- 发布 commit/tag：`9c87d8db19c986c06228f85919c3de84bd9fc773` / `v0.17.0`。
- EdgeOne 生产部署：`dp72unhkh6wx`；公网 release 与 content manifest 对齐同一版本和 commit。
- 发布后用户真实浏览暴露出架构层级、关系可见性和互动可感知性仍不成立；纠正进入独立 `v0.18.0`，不重写本版本 tag。

## v0.16.0 — 企业经营体系可读架构图运行时升级

- 企业经营体系升级为总览 → 数字化实现 → 节点聚焦的三级可读架构界面，保持既有业务事实、唯一局部入口与 URL 合同。
- 使用 `@xyflow/react` 提供只读图形运行时，关闭节点拖动、连线、删除与保存等编辑语义。
- 使用 `elkjs` 在构建阶段生成 desktop/mobile 确定性布局，手机图形参与自然页面滚动，并保留中文无障碍、reduced-motion 与文本降级。
- 桌面关系标签不参与 ELK 几何占位，只在当前选中或预览节点的直接关系上显示，避免整体缩小与全量标签噪声。
- 本版本不修改 Robotaxi 内容/媒体、Observation、About、导航、发布脚本或其他 backlog。
- 当前上线状态：Engineering 实现、自动检查与六档真实页面验证已完成，进入本地 commit/tag 收口；尚未 push、部署或公网验收。

## v0.15.8 — xingbuild 轻量访问概览接入

日期：2026-07-30

- 正式站页面 visible 累计 15 秒后，按本站独立匿名 seed 记录一次 `XINGBUILD` 合格访问；隐藏时间暂停，排除本地、preview、自动 QA 与管理员设备。
- 同源 Worker 复用共享 HMAC、Asia/Shanghai 自然日幂等、七字段白名单和 30 天有界清理合同，不记录路径、来源、输入、业务数据或网络身份。
- 本站不新增访问管理页面；生产发布前完成共享 `visitKv` 与 `visitHashSecret` 外部配置，真实写入及 Robotaxi 管理页联查仍由用户人工验收。

## v0.15.7 — Slug 级内容审核终端聚合

日期：2026-07-30

- 新增显式 `slug + authority` 的 `content:approve` 单命令，在共享 JS 能力层聚合既有 review 与 promote。
- 以目标级预检和精确回滚保证成功只新增目标审核、恢复副本与 production，失败不覆盖已有事实或留下半成品。
- 无关 ignored workspace 可并存且不被扫描、阻断或修改；命令不承担选题、写稿、发布或产品版本操作。

## v0.15.6 — Robotaxi 页面 canonical 收口

日期：2026-07-30

- 将 `/products` 固定为 Robotaxi 的唯一真实页面与 canonical reader URL。
- `/products/robotaxi` 通过 replace 兼容跳转至 `/products`，不保留独立页面、标题或额外浏览器历史层。
- 保持 `/robotaxi`、`/works` 与 `/works/robotaxi` 的既有兼容结果不变，不修改 RobotaxiPage、内容、视觉或外部系统 action。

## v0.15.5 — 全站 SiteShell 与 Footer 几何

日期：2026-07-30

- 将全站 SiteShell 收口为纵向页面框架：Header 与 Footer 保持普通流，main 统一吸收短页剩余高度。
- 短页 Footer 落在动态视口底部，长页 Footer 跟随全部内容；保留既有全局关系间距、最大宽度、gutter 与 sticky Header。
- 使用 `100vh` fallback、`100dvh` 和手机底部 safe area，不通过页面补丁或 Footer 定位覆盖制造几何假象。

## v0.15.4 — Slug 级内容发布能力

日期：2026-07-30

- 将日常 Observation 准备固定为 candidate → draft → 人工审核 hash → promote，并保留目标 draft、审核记录和精确恢复副本。
- 将生产入口收口为 `publish-content.command --slug <slug>`；只校验目标 slug 冲突，允许无关 ignored workspace 内容并存。
- 内容提交必须保持产品版本/tag 不变、范围仅含目标 Observation 与必要 approved media，且发布前满足 `origin/main == HEAD^`；push、部署与公网验收分别报告。
- Supersede 仅处理未发布草稿，要求显式 old/canonical、原因、决定日期和内容 hash；不包含已发布内容撤下。

## v0.15.3 — ObservationRail 从属预算与跨 task 边界修订

日期：2026-07-29

- 将 ObservationRail 的可见项预算收口为主栏 intrinsic content height 与最多两个视口高度的较小值；完整项、真实 gap 与“更多观察”共同计入预算，允许零项。
- Grid 双栏显式使用 `align-items: start`，右栏不再反向撑高主栏；Robotaxi Practice 在公开模块为零时不挂载 Rail。
- 固化轻量跨 task 治理：交接传递有界摘要和明确事实源，浏览器串行且有内存停止阈值；实现、验证、版本、推送、部署分别报告。

## v0.15.2 — Robotaxi 媒体生命周期与公开投影修订

日期：2026-07-29

- 将 Robotaxi 媒体 manifest 从“全部公开资产”收口为生命周期与 provenance 事实记录；公开投影只消费完整的 active + approved + public 单项链路。
- 同步 Robotaxi `v049.13.15` / `1e01d499`：总 publication 暂停、四项历史媒体转为内部追溯记录，当前公开模块为零；不删除原文件、哈希、版本、commit、历史 approvalRecord 或撤销/暂停原因。
- 扩展 content-only 范围与发布入口，使后续单一媒体 manifest 状态更新及其必要的 archive/public 资产可独立发布；不改页面结构、展示母版或其他内容对象。

## v0.15.1 — 画布平移与节点点击责任修订

日期：2026-07-29

- 图节点与其他交互控件不再启动画布平移会话；只有画布背景可获得 pointer capture 与受控平移责任。
- 保持下钻节点的 click、Enter、Space 进入语义，普通节点选择语义，以及背景拖动后的 click 抑制合同不变。

## v0.15.0 — 企业经营体系总览至数字化实现局部视图

日期：2026-07-29

- 在同一 `/business-observations` 展示母版中建立首条可分享、可刷新、可返回的局部阅读路径：总览节点“数字化实现”直接进入 `?view=digital-implementation`。
- 局部直接消费既有 `frameworkModel` 的 9 节点、13 边、定义、作用与关系；不复制或改写 career 同步快照中的权威事实。
- 总览与局部各自拥有默认选中、关系强调、复位与有限平移；局部手机端使用既有 350×1010 纵向世界及按真实世界高度限幅的可视区平移。
- 增加 URL/返回焦点、几何、双向关系、键盘、aria-live 与响应式投影合同；未增加第二个局部入口、节点详情页或新的框架概念。

## v0.14.3 — Brief 正文合同统一修订

日期：2026-07-29

- 删除八个固定 slug 的短 statement 迁移豁免；所有已发布 Brief 现在都以显式 `brief.body` 或 `brief.statement` 中的读者正文统一满足 80–160 中文等价字符合同。
- 保持已有事实、来源、页面、视觉与读取投影不变；本版本只收口 validator 与内容合同测试，避免未来单篇 content-only 发布再次依赖工程例外。

## v0.14.2 — Header 视口背景溢出修订

日期：2026-07-29

- Header 的全视口滚动背景改为固定视口层，不再由 `100vw` 与水平位移参与文档宽度计算。
- 保持 Header 高度、暖白透明背景、12px 模糊和轻影不变；1440、1024、390 的滚动前后均验证无横向溢出。

## v0.14.1 — Framework 投影标题层级修订

日期：2026-07-29

- Framework 说明内部标题随选中节点标题递进：来源页保持 `H1 → H2 → H3`，首页投影保持 `H2 → H3 → H4`。
- 保持同一标题视觉角色与所有既有框架概念、边集、间距和交互；本修订只纠正语义层级。

## v0.14.0 — 浮动导航、排版层级与移动归属收口

日期：2026-07-29

- Header 增加不改变几何的 top/scrolled 两态：滚动后以全视口暖白半透明层、克制模糊和轻影维持阅读上下文；降动效时不播放过渡。
- 收敛 wordmark、首页定位、页面/对象、文章、章节、正文、摘要与元信息的全站排版角色；移除页面私有 display/feature 字号责任。
- 首页唯一 H1 迁至完整 shell 行；Robotaxi 与企业经营体系继续消费同源 Presentation，Rail 只从内容投影层出现一次。
- Practice 模块标题随根标题递进；企业经营体系的移动端当前节点说明紧邻总览图并只读取 frameworkModel。
- 删除公开 career/版本治理说明，保留内部内容与上游事实边界；不改八条 Brief 正文、approved Robotaxi 媒体或框架概念边集。

## v0.13.1 — 生产阅读合同修订

日期：2026-07-28

- 将首页唯一定位语从 display hero 收敛为 1440px 的 28px、390px 的 24px 紧凑作者定位；不改定位文案或新增副标题。
- ObservationBlock 统一为无边线、无阴影、无抬升的暖色信息块；identity 固定为不可换行的 `subject · eventAt`，来源恢复为辅助信息色。
- Rail、集中观察与长文传递安全、可刷新 `origin` / `returnTo`；返回标签由真实目的地生成，并保留经营观察入口。
- RichDocument 改为父级单点拥有相邻关系：H1→lead 12px、lead→首 H2 32px，消除 Article/About 的间距叠加。
- 新 Brief 必须具备 80–160 中文等价字符正文与不超过 16 中文等价字符的主体；仅 v0.13.0 已发布的八条短 statement 保留显式、slug 限定的迁移豁免，未改写任何事实正文。
- 当前上线状态：本地验证、GitHub 推送与 EdgeOne 修订发布将在本轮闭环中分别确认。

## v0.13.0 — 信息架构、展示母版与富文本内容系统

日期：2026-07-28

- 一级导航收敛为 `B端产品 / 经营观察 / 关于我`；企业经营体系归入经营观察，集中观察页保留为内容上下文入口。
- 首页以唯一定位语 H1 投影同源最新 Robotaxi 产品与企业经营体系，并且只出现一次最新观察 Rail。
- 建立 `ShowcaseLayout`、`SystemStage`、`RichDocument` 与受控产品/经营观察/Profile 内容目录；后续内容仅通过内容对象和 approved media 进入页面。
- Header 固定为紧凑 sticky 身份组，Footer 从构建版本读取 `© 2026 xingbuild · v0.13.0`。
- 当前上线状态：本地实现、自动检查、浏览器预检、GitHub 推送与 EdgeOne 发布将在本轮闭环中分别确认。

## v0.12.2 — 发布就绪状态收口

日期：2026-07-28

- 建立单一 `release:preflight` 本地检查，统一验证分支、工作区、版本记录、HEAD 标签和 GitHub origin。
- 产品发布脚本复用该检查；“已提交并打标签”与“工作区干净、可发布”被明确分离。
- 当前上线状态：本地工作流修订，未推送 GitHub 或发布 EdgeOne。

## v0.12.1 — Robotaxi approved-media 内容入口

日期：2026-07-28

- 从 Robotaxi 已批准媒体清单接入四项经哈希校验的真实平台证据，按“运营中控台 → 两项内部模块、经营模型、经营总览”投影。
- 明确分离 reader media、reader action 和内部 provenance；Git commit、审批状态、媒体角色、边界和 SHA-256 不默认进入读者界面。
- 当前上线状态：本地实现、自动检查与结构视觉专业验收已完成；已完成本地稳定版本收口，未推送 GitHub 或发布 EdgeOne。

## v0.12.0 — 紧凑身份、双形态观察与作品母版

日期：2026-07-28

- 首页与 Robotaxi 实践页分离，首页只承担作者入口与两项核心实践入口。
- 观察改为显式 `brief` / `article` 阅读投影；Brief 保留事件日期、主体、维度、事实陈述和来源行。
- Header、CollectionLayout 与作品母版统一为可复用页面结构。
- 专业验收确认 Brief 四行阅读语法无分割线、Article 不显示治理结构，短内容页 footer 自然跟随实际内容。
- 当前上线状态：本地实现、自动检查与结构视觉专业验收均已完成；已完成本地稳定版本收口，未推送 GitHub 或发布 EdgeOne。

## v0.11.3 — Brief 事件日期与稳定排序修订

日期：2026-07-28

- 对 explicit BriefProjection 要求父 ObservationPublication 提供 `eventAt`，并在投影中同时保留事件日期与 `publishedAt` 公开追溯日期。
- Brief 流与 rail 展示 `eventAt`，按事件日期倒序、公开日期倒序、稳定 id 排序；不再以统一 promote 日期伪装为事件日期。
- 当前上线状态：本地检查与专业复验完成；已完成本地稳定版本收口，未推送 GitHub 或发布 EdgeOne。

## v0.11.2 — 内容合同测试修订

日期：2026-07-28

- 将 Brief 测试从“当前公开集合没有 Brief”改为验证内容合同：无 explicit brief 不投影，合法 explicit brief 可以投影；不再让真实内容数量决定工程测试结果。
- 将构建 manifest 测试改为与当前 `content/observations/` 的 published 集合动态比对，不固定公开数量或 slug。
- 当前上线状态：本地检查与专业复验完成；已完成本地稳定版本收口，未推送 GitHub 或发布 EdgeOne。

## v0.11.1 — 内容入口结构收口

日期：2026-07-28

- Robotaxi Practice 与模块配置从页面内容 JavaScript 迁至受控内容文件；媒体只由受版本记录的 manifest 解析，当前没有经批准媒体或模块，因此不填充伪截图、占位模块或泛化链接。
- ObservationPublication 增加显式 BriefProjection；日期与经营维度从父对象继承，既有两篇公开观察不自动转换为简讯。
- Practice 读取 Robotaxi 相关最新公开 Brief，企业经营体系读取全站最新公开 Brief；没有公开 Brief 时两页均不保留空 rail。
- 观察 rail 按完整条目高度预算截取，公开读取层继续严格排除 ignored workspace drafts/imports。
- 当前上线状态：本地实现、自动检查、真实浏览器验证与结构视觉专业验收均已完成；已完成本地稳定版本收口，未推送 GitHub 或发布 EdgeOne。

## v0.11.0 — 总体结构与高密度视觉母版

日期：2026-07-28

- `/` 与 `/robotaxi` 统一为 Robotaxi PracticePage，建立可持续扩展的实践内容模型与页面母版；当前没有经批准的模块、媒体或深链时，页面只呈现已确认的定位、作品身份、摘要与边界，不填充伪内容。
- 建立统一 LayoutShell、TwoColumnLayout 与高密度空间 token；没有真实 Brief 时不保留空白 rail，主内容自然占据有效阅读宽度。
- 企业经营体系收敛为同源模型驱动的一张受控总览图，说明位于图下；保留选择、键盘、有限平移、复位与几何校验，不公开未确认局部入口。
- 观察建立显式 BriefProjection 阅读投影；既有文章保留在底层内容模型但不自动缩写为信息流。当前无合格 Brief 时以配置化当前状态空态呈现。
- 当前上线状态：本地实现、自动检查、真实浏览器验证与结构视觉专业验收均已完成；已完成本地稳定版本收口，未推送 GitHub 或发布 EdgeOne。

## v0.10.1 — 内容导入安全消费补丁

日期：2026-07-27

- `.content-workspace/imports/` 中的候选只有在校验、文件名与 slug 合同及 draft 排他写入全部成功后才被精确消费。
- 外部输入、无效候选、重复 draft 和写入失败输入全部保留，避免误删来源文件。
- 新观察发布前增加 1440px 与 390px 中文业务词组人工换行检查，只对真实拆词使用最小 WORD JOINER。
- 当前上线状态：工程补丁、自动检查、真实草稿验证和专业验收均已完成；已完成本地稳定版本收口，未推送 GitHub 或发布 EdgeOne。

## v0.10.0 — 观察内容发布流水线

日期：2026-07-27

- 将观察从网站代码迁移为 ObservationPublication、EvidenceUnit、Source 三层结构化内容，并建立独立 schema 与公开读取层。
- 建立 candidate 导入、草稿硬隔离、开发期直接预览、发布提升、内容范围校验和 content-only 发布通道。
- 产品版本发布继续要求 matching tag；日常内容发布保持产品版本号不变，只允许一篇已发布观察进入提交。
- 当前上线状态：Engineering 实现、自动检查、七档本地浏览器验证和两轮专业验收均已完成；已完成本地稳定版本收口，未推送 GitHub 或发布 EdgeOne。

## v0.9.0 — 全站内容卡片与页面结构收敛

日期：2026-07-27

- 首页、观察、作品和关于我使用同一默认内容主轴，删除栏目 rail、单一年份 rail 与 About 常驻目录。
- 建立共享 ContentCard、ObservationCard、WorkCard 与 CardGrid，首页和栏目页消费相同组件与字段顺序。
- 观察卡片固定为标题、摘要、类型/主题/日期；作品卡片固定为标题、问题摘要、状态/更新时间。
- 建立独立卡片表面、边界、圆角、焦点和交互 token，以关系化空间替代通用 128px 页面间距。
- 当前上线状态：Engineering 实现、自动检查、七档本地浏览器验证和结构视觉专业验收均已完成；已完成本地稳定版本收口，未推送 GitHub 或发布 EdgeOne。

## v0.8.0 — 单页交互式企业认知架构

日期：2026-07-27

- 将企业认知框架从入口、视图切换与独立概念页重构为四个核心问题和四张架构图组成的连续单页。
- 建立四图共享的 Architecture、Node、Edge、RelationLabel、NodeExplanation 与响应式投影模型；桌面与手机使用同一节点和固定边集。
- 桌面采用左图右解释，900px 以下使用纵向架构与图后解释；节点支持 hover、focus、点击和键盘稳定选择。
- 固定反馈轨无悬空箭头、关系文字与边一一对应、图四无“结果→事实”，并补足模型、交互、无 JavaScript 和响应式验证。
- 当前上线状态：Engineering 实现、自动检查、本地浏览器验证和结构视觉专业验收均已完成；已完成本地稳定版本收口，未推送 GitHub 或发布 EdgeOne。

## v0.7.1 — 本地启动终端交互收敛

日期：2026-07-27

- 关闭 Vite 开发服务器对普通终端字符的读取，避免误触 `h`、`r` 或 `q` 后显示帮助、重启或退出。
- 保留启动状态、本地与线上链接、自动打开预览和 `Control-C` 停止服务。
- 当前上线状态：本地修订与验证已完成，尚未推送 GitHub 或发布 EdgeOne。

## v0.7.0 — 企业认知框架产品化

日期：2026-07-27

- 将企业经营体系认知框架从静态作品说明升级为由统一概念、关系、视图、应用与路径状态模型驱动的框架浏览器。
- 实现总览、数字化实现、企业业务架构九视角、业务对象到底层对象及 Robotaxi 应用的完整下钻路径。
- 桌面使用主结构与右侧稳定详情，900px 以下投影为纵向语义流与独立概念页。
- 增加稳定 URL、键盘与焦点等价交互、关系文本、来源版本、证据边界、无 JavaScript 顺序及模型自动校验。
- 当前上线状态：本地实现与验证进行中，尚未推送 GitHub 或发布 EdgeOne。

## v0.6.2 — 序号语义与手机导航简化修订

日期：2026-07-26

- 删除首页栏目、作品、核心能力、无序问题和作品并列主题中的装饰性编号。
- 删除 `work.index` 内容字段、索引 rail 和对应空白布局，让标题与内容直接承担结构表达。
- 保留观察年份与日期、架构流程与四平面编号、版本和 404 等具有明确含义的数字。
- 固定手机菜单只承载三个一级入口，并保持既有字体、触控高度、项间距和滚动锁定合同。
- 当前上线状态：本地实现与验证已完成，尚未推送 GitHub 或发布 EdgeOne。

## v0.6.1 — 对象内部构图节奏修订

日期：2026-07-26

- 将 ObjectStack 默认节奏从 `object` 修正为 `relate`，避免把内容对象层级机械映射成所有内部关系的统一大间距。
- 重点观察和作品的 Identity、Proposition、Evidence、Action 恢复为紧密且有归属的统一构图。
- 保持对象之间的 `group`、栏目之间的 `section` 以及 v0.6.0 六层结构不变。
- 当前上线状态：用户已完成 GitHub 推送和生产发布；公网 Chrome 验收确认对象内部构图节奏已生效。本次未独立读取线上版本清单。

## v0.6.0 — 视觉结构与空间节奏系统

日期：2026-07-26

- 建立 Page Frame → Section → Content Group → Content Object → Element → Relationship 六层视觉结构。
- 以 `bind / relate / object / group / section` 语义关系 token 取代含义混杂的页面间距。
- 引入 PageStack、SectionFlow、CollectionFlow 和 ObjectStack 最小布局责任，让相邻间距只由共同父级拥有。
- 重组首页、观察、作品、关于我和长文的内容对象关系，消除栏目头尾空间叠加并强化 Identity、Proposition、Evidence、Action 分组。
- 当前上线状态：用户已完成 GitHub 推送和生产发布；公网 Chrome 验收确认栏目级节奏通过，对象内部构图仍需 `v0.6.1` 修订。本次未独立读取线上版本清单。

## v0.5.2 — 修正本地启动与交付链接

日期：2026-07-26

- 启动指令会复用并打开已有正常服务，或在固定 4317 端口启动后自动打开浏览器。
- 端口异常占用时明确停止，不再静默切换端口并显示错误网址。
- 启动终端与每轮迭代完成报告固定提供本地、线上两个入口，并继续区分本地验证与生产状态。
- 当前上线状态：本地实现、启动验证与稳定版本已完成，尚未推送 GitHub 或发布 EdgeOne。

## v0.5.1 — 中文语义换行与阅读节奏修订

日期：2026-07-25

- 为核心中文标题统一启用浏览器原生短语识别换行，避免拆开“构建”“同时”和“企业数字化”等完整词组。
- 以相邻语义关系明确正文段落、标题、提示与章节的单一间距责任，消除间距叠加和意外 margin collapse。
- 保持 `lang="zh-CN"`，不引入固定换行、视口专用文案、JavaScript 分词或第三方排版依赖。
- 当前上线状态：本地实现与验证已完成，尚未推送 GitHub或发布 EdgeOne。

## v0.5.0 — 根本视觉构图优化

日期：2026-07-25

- 将首页 Hero 标题起点上移到约 204px，并把有效宽度扩展到 940px，使 1440px 中文标题自然形成两行。
- 建立 `HeroStatement`，将栏目说明收回 `SectionIntro`，由稳定组件表达内容对象内部关系。
- 固定衬线承担作者判断与阅读主体、无衬线承担解释与系统信息的字体分工。
- 优化手机 Hero 说明与最新观察节奏，390×844 首屏可看到重点观察标题。
- 强化全小写 `xingbuild` wordmark，同时保持 557px 行内导航和 520px 以下全屏菜单合同。
- 当前上线状态：用户已完成生产发布，公网页面已通过桌面与手机核心 Chrome 验收；本次验收未独立读取线上版本清单，因此不以该清单作为精确版本证据。

## v0.4.1 — 修正手机导航密度与触发边界

日期：2026-07-25

- 将全屏手机菜单的内容驱动断点调整到 520px 以下，约 557px 宽度继续使用紧凑行内导航。
- 手机菜单链接从页头下方开始排列，不再垂直居中制造无意义的顶部空白。
- 保持全视口覆盖、滚动锁定、关闭图标、键盘焦点和触控目标不变。
- 当前上线状态：本地实现与验证已完成，尚未推送 GitHub 或发布 EdgeOne。

## v0.4.0 — Visual System v1 工程化升级

日期：2026-07-25

- 建立语义颜色、字体角色、流式字号与行高、空间、版心和内容驱动断点。
- 本地托管 Noto Serif SC 与 Noto Sans SC，桌面和手机保持一致的编辑型字体角色。
- 将站点框架、内容、阅读、作品与页面投影拆分为最小充分组件，并按 token、基础、布局、组件和页面拆分 CSS 责任。
- 保持内容事实、一级导航、阅读路径和 Sites 构建发布合同不变。
- 当前上线状态：本地实现与验证已完成，尚未推送 GitHub 或发布 EdgeOne。

## v0.3.1 — 精简全站视觉与手机导航

日期：2026-07-25

- 手机菜单改为图标按钮和全视口覆盖层，展开后变为关闭图标，并支持滚动锁定与 `Escape` 关闭。
- 页头只保留 `xingbuild`，页脚只保留版权；作者、所在地和更新时间不再重复出现在全站框架。
- 删除页面、栏目、列表、正文和内容卡片中的装饰性横线与边框，改用排版、对齐和留白建立层级。
- 架构图继续保留表达业务对象关系所必需的语义线。
- 当前上线状态：本地稳定版本已完成，尚未推送 GitHub 或发布 EdgeOne。

## v0.3.0 — 升级阅读路径与响应式布局

日期：2026-07-25

- 首页首屏聚焦网站定位，最新观察、核心作品、About 和网站状态形成清晰的向下阅读顺序。
- 观察列表建立重点观察与紧凑归档两种密度，整行可点击并保留键盘焦点。
- brief 与 analysis 使用不同阅读契约：短观察不显示空目录，分析长文提供讨论问题、桌面目录和手机折叠目录。
- 作品按问题、构建对象、状态、证据、架构和局限组织；关于我补充代表项目成果并调整阅读顺序。
- 桌面与手机继续使用同一暖白、墨色和赭色品牌体系，通过响应式重组而非等比例缩放。
- 当前上线状态：本地稳定版本已完成，尚未推送 GitHub 或发布 EdgeOne。

## v0.2.2 — 固定跨端品牌颜色

日期：2026-07-25

- 修正窗口缩小到响应式断点后背景、文字、线条和强调色突然切换的问题。
- 响应式断点只改变布局、排版、导航和图形方向，不再重定义全局品牌颜色。
- 桌面与手机统一使用暖白、墨色和赭色品牌体系。
- 当前上线状态：本地稳定版本已完成，尚未推送 GitHub 或发布 EdgeOne。

## v0.2.1 — 修正一键发布确认逻辑

日期：2026-07-25

- 双击发布命令后直接执行检查、GitHub 同步、EdgeOne 部署与公网验证，不再要求重复输入 `publish`。
- 保持本地实现、GitHub 同步、EdgeOne 部署和公网验收的状态边界。
- 当前上线状态：本地稳定版本已完成，尚未推送 GitHub 或发布 EdgeOne。

## v0.2.0 — 建立持续出版的网站骨架

日期：2026-07-25

- 新增“观察”，形成“观察 / 作品 / 关于我”顶层信息架构。
- 建立结构化内容对象、独立页面、长文阅读和作品详情。
- 重构桌面编辑型与手机系统型响应式视觉。
- 当前上线状态：本地稳定版本已完成，尚未推送 GitHub或发布 EdgeOne。

## v0.1.4 — 完善正式域名体系

日期：2026-07-25

- 将 `www.xingbuild.top` 固定为兼容入口，并通过 EdgeOne 301 永久跳转至主域名 `xingbuild.top`。
- 将 EdgeOne 主机重定向配置纳入源代码、生产构建与自动验证，避免域名行为只存在于控制台。
- `robotaxi.xingbuild.top` 继续由独立 Robotaxi EdgeOne 项目负责，不进入本仓库的构建和发布。
- 当前上线状态：实现中，尚未完成生产发布与公网验收。

## v0.1.3 — 固定 EdgeOne 生产项目

日期：2026-07-24

- 将一键发布目标从不存在或错误的 `xingbuild` 修正为实际生产项目 `xingbuild-nochina`。
- 固定项目 ID、加速区域和正式域名的发布合同，避免后续误创建或误更新其他项目。
- 当前上线状态：仅完成本地修正，尚未发布本版本。

## v0.1.2 — 一键发布闭环

日期：2026-07-24

- `publish` 一次完成 GitHub 标签与 main 推送、EdgeOne 生产部署和公网验证。
- 增加发布版本清单，以 Git 版本和提交校验线上网站。
- 任一阶段失败即停止，不把 GitHub 已同步误报为网站已上线。
- 当前上线状态：已部署至 `xingbuild-nochina`，`https://xingbuild.top`、HTTPS、版本 `v0.1.2` 和提交 `9eceae4` 均已验证。

## v0.1.1 — GitHub 与 EdgeOne 发布基础设施

日期：2026-07-24

- 创建 GitHub 远程仓库并推送 `main` 与稳定标签。
- 将 EdgeOne CLI 固定为项目开发依赖，避免依赖系统级管理员权限。
- 发布脚本统一调用项目内 CLI，继续保持本地提交与线上发布分离。
- 当前上线状态：配置进行中，尚未确认生产部署和域名生效。

## v0.1.0 — 网站基线与工程闭环

日期：2026-07-24

- 建立 xingbuild 首个桌面与手机自适应网站。
- 固定“作品 / 关于我”的内容结构和两个代表作品。
- 分离结构化内容、页面组件与视觉样式。
- 建立迭代、启动、发布前检查和 EdgeOne 发布流程。
- 建立本地 Git 稳定提交和标签规则；线上仓库与生产发布保持独立授权。
## v0.26.20 — 本地内容预览工作台与 Task 入场治理

父版本：`v0.26.19` / `36dcffa097455fc6747555751f1861ae26b7227f`

- 新增唯一 `content:preview:site` dev-only 入口，复用固定 `4317` preview lease，以 `content-preview` mode 绑定当前 HEAD、task、registered target、绝对 source、projection routes/keys 与 active ContentSet 只读基线。
- 新增 ContentPreviewSession 与 Vite 内容预览工作台：使用 canonical ignored content、既有 page composition/ResponsiveTextSlot/media，提供 Web `1280` 与 Mobile `390` 真页面 iframe、HMR 和“未审核·未发布”状态；不提供 approve/publish/deploy/active 切换。
- 启动前拒绝未注册 target、unsafe source override、缺失/非法 JSON、非 projectionKeys 注册的 responsive slot；预览只读 active ContentSet，不写 active/review/recovery/release/SitePublication/线上 manifest。
- 固化 AGENTS、task-onboarding、baseline index、task registry 的 elon 职责与 direct-local 入场边界；不改变 ContentSet/target registry/ResponsiveTextSlot schema、页面 IA/视觉或发布链路。

## 验证合同

- registered target/source/route/baseline、unknown/unsafe/missing source、responsive projection、content/product lease 隔离、workbench dev-only/无发布控制、零写入与 preview runtime 回归。
- `npm run check`、`npm run release:prepare`、内容检查、`npm run release:closeout-check`、exact `npm run release:build`、`npm run release:preflight`、`git diff --check`；保留既有环境/内容 fixture failures 分层，不修改内容事实。
- 本版本只形成本地 Engineering checkpoint；待 elon 产品/架构与 elon ui 本地 Web→Mobile 独立验收，未执行 product transport 或 content publish。
