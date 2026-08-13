# 当前迭代

## 当前唯一版本：`v0.26.22`

父版本：v0.26.21 / `3bde62d80a1bb666ee5846e30dd10fa631fbf29f`

## 正式方案

[docs/design/v0.26.22 内容预览运行时 v2 与局部刷新闭环方案.md](../design/v0.26.22%20内容预览运行时%20v2%20与局部刷新闭环方案.md)

## 本版本要解决的真实问题

Xing 需要在本地直接修改已登记内容，并立即看到真实页面的 Web/Mobile 结果；修改一个字段只更新它真正影响的页面，不重新构建全站、不生成 ProductArtifact、不触碰 ContentSet 或线上状态。

v0.26.21 已完成 target 影响面和 reducer 的单元/定向验证，但真实使用暴露出直接阻断：workbench 自定义 HTML 没有接入可运行的 Vite HMR client，文件 hash 已变化而浏览器 revision、DOM 和 frame 均不变化。v0.26.21 保持冻结，不回写旧版本；本版本建立独立的预览运行时事件链，避免再次依赖 Vite HMR 的隐式行为。

## 产品合同

### 1. 预览边界

预览链只有：

```text
canonical ignored content source
  → ContentTarget
  → PreviewSourceWatcher
  → target validator
  → TargetImpact
  → PreviewEventBroker
  → affected Web/Mobile frames
```

发布链仍然独立：

```text
ProductArtifact + active ContentSet
  → SiteSnapshot
  → Site Publication Coordinator
  → deployment / publicVerify / finalize
```

两条链不得互写、互相触发或共享发布状态。

### 2. 稳定对象

- `ContentTarget`：唯一 registry 中已登记的 `targetId`、`fieldPath`、source、projection 和安全校验规则。
- `TargetImpact`：由 registry 与 `pageDefinitions/contentRefs` 共同解析的真实 consumer routes/views；不允许手工维护第二份映射。
- `ContentPreviewSession`：一次只读本地会话，绑定当前 canonical main、HEAD、4317 lease、PID、`sessionId` 和 selected target。
- `PreviewSourceWatcher`：只监听 selected target 的 canonical source 文件，支持原子保存的 rename、短暂半写入、debounce 和恢复；不监听整个仓库，不监听 active/release/recovery。
- `PreviewEventBroker`：本地受控事件通道（SSE 或等价单一通道），传递 `targetId/sourceHash/valueHash/revision/consumerViews/status`。
- `FrameManager`：只对 `TargetImpact` 返回的 Web/Mobile frame 发出更新；无关 frame 的 URL、revision、DOM 和导航计数必须保持不变。

### 3. 状态与刷新规则

```text
valid source change
  → validate
  → revision + 1
  → refresh only affected route × viewport

invalid/partial source
  → invalid
  → preserve last-valid rendered state
  → show inspectable error

selected target unchanged
  → outside-selected-target
  → no frame refresh

valid source restored
  → valid-updated
  → affected frames recover once
```

同一 source 的多个 target 必须按 `TargetImpact` 精确分发。例如：`products.robotaxi.intro` 影响 `/` 与 `/products`；Products-only Why 只影响 `/products`；首页 `homeTitle` 只影响 `/`。不得把 JSON 变化转换成 `path=*` 全量 reload。

### 4. 内容与生命周期保护

预览只能读：canonical ignored source、target registry、page definitions、review/draft 状态、approved media manifest，以及 active ContentSet 的只读 hash/baseline 对照。

预览绝不能写：`src/`、schema/CSS/组件、`active.json`、ContentSet、review/approve/release/finalize、ProductArtifact、SitePublication、deployment、EdgeOne 或任何线上状态。预览不得把 draft 变成 approved/active。

### 5. 会话清理

`sessionId/runId`、4317 lease、PID、browser profile、临时截图和临时缓存均为会话对象。正常退出、异常退出、SIGINT/SIGTERM 和超时都必须进入可观测的 cleanup 分支，并验证无 orphan lease、owned process、profile/temp residue。QA 证据如需长期保留，另由 QA owner 保存最小 machine-readable summary；不得把 profile/cache 当发布证据。

## 明确不做

- 不做产品 UI/IA/视觉、组件、token、文案或页面结构迭代；因此不需要 elon ui 做全站视觉验收。
- 不新增 CMS、数据库、第二套内容 schema、第二套 target registry、第二套 renderer 或页面专用内容源。
- 不把 Vite HMR 当产品协议；可以复用 Vite dev server，但刷新事件必须由预览运行时显式拥有和验证。
- 不做 full reload、全站 build、ProductArtifact/ContentSet/SitePublication 生成、content publish、product transport 或 EdgeOne 调用。
- 不读取、复制、迁移或清理历史 releases、site-publications、base-site-artifacts、recoveries；这些进入独立候选。
- 不创建 branch、worktree、并行 task 或 automation。

## 验收合同

### Xing 实际使用闭环（最高优先级）

1. 启动固定 4317，并显示当前 HEAD、sessionId、selected target、source hash 和 consumer frames。
2. Xing 对 `products.robotaxi.intro` 做一次真实有效编辑；约定时限内 Web1280/Mobile390 的 `/`、`/products` frame 同步更新，revision +1，文本与响应式换行正确。
3. 无关 `/business-observations`、`/observations`、`/about` frame 的 URL、revision、DOM 和导航计数不变。
4. 写入一次非法/半写入内容：页面保留 last-valid，不白屏，workbench 显示字段级错误。
5. 恢复有效内容：仅受影响 frame 恢复，revision 单调递增。
6. 刷新页面后 source/value hash、revision 和生命周期快照一致；退出后 lease/PID/profile/temp 清理可证明。

### 工程门禁

- target registry、page definitions、ContentSet 兼容和 frame impact 定向测试通过；未知 target、越界字段、非法 projection、无效 JSON 均在写入/渲染前硬失败。
- valid、invalid、outside-selected-target、恢复、重复事件、乱序事件和断线重连回归通过。
- 真实固定 4317 浏览器证据包含 source/value hash、revision、consumer identity、frame URL/DOM、console/pageerror 和 cleanup 结果。
- active ContentSet、review/recovery/release/SitePublication/ProductArtifact 在预览前后 byte/hash 不变。
- 版本形成 clean commit/tag、exact build、preflight 后，才由 Xing 决定是否进入产品发布；本版本本地预览完成本身不自动触发 publish。

## `contentImpact` 声明

```yaml
contentImpact: compatible
contentImpactReason: explicit-local-event-channel-replaces-implicit-hmr
compatibilityEvidence: active-contentset-read-only-and-no-publication-side-effects
affectedTargets: [content-preview-session, target-impact, products.robotaxi.intro, site.home.homeTitle, practice.why]
affectedRoutes: [local-only]
affectedFields: []
lifecycleWrites: none
publicationAction: none
```

## 执行顺序与责任

1. `elon` 维护本 current 与正式方案；不把本地预览问题转成视觉验收。
2. `elon engin` 只实现本文件范围，完成定向测试、固定 4317 真实使用证据、commit/tag/clean 和 ProductArtifact/preflight。
3. Xing 进行一次实际编辑确认；这是本功能的产品验收，不是全站视觉审查。
4. 产品版本是否 transport 由现有发布门禁单独决定；内容发布仍由 `elon ops` 按内容生命周期独立执行。
5. 历史过程文件清理和内容数据生命周期不进入 v0.26.22，分别按对应候选处理。
