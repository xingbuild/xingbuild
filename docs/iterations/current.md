# 当前迭代

## 当前唯一版本：`v0.26.27`

父版本：v0.26.26 / `18c45c5ddc724c8e6d9be235c63b9a0867a52814`

contentImpact: compatible
contentImpactReason: 本版本只简化 dev-only 内容工作台的页面导航入口；不改页面 IA、线上产品、active ContentSet、正文事实、审核或发布链路。
affectedTargets: ["preview-page-navigation", "preview-route-sync", "preview-content-selection"]
affectedRoutes: ["/", "/products", "/business-observations", "/observations", "/about"]
affectedFields: ["none; preview navigation and selected authored target only"]
compatibilityEvidence: 工作台仍只写 canonical ignored source；active/review/recovery/release/SitePublication/ProductArtifact 只读且不变。内容 target 的 TargetImpact 与 Web/Mobile 局部刷新合同保持不变。

## 正式方案

[docs/design/v0.26.27 内容工作台页面导航即选择与局部预览方案.md](../design/v0.26.27%20内容工作台页面导航即选择与局部预览方案.md)

## 本版本要解决的真实问题

v0.26.26 已经实现“右侧页面点击文字 → 左侧编辑 → 右侧即时预览”，但工作台顶部仍有一个页面下拉，而右侧真实页面自身也有站点导航，形成两套页面选择入口。Xing 的真实操作应只有一个页面导航：直接在右侧真实页面中点击站点导航切换页面，再在当前页面中点击文字进入编辑。

## 产品范围

- 移除工作台顶部“选择页面”下拉及其帮助文案；不新增第二个页面选择器。
- 右侧 Web/Mobile 预览保留真实站点的主导航；主导航是唯一页面分类入口。桌面直接点击，移动端通过真实菜单打开后点击。
- 站点导航点击只在预览区内切换当前 route，并让 Web/Mobile 两个 frame 同步到同一页面；不离开工作台、不打开外部窗口、不影响左侧编辑器布局。
- 页面导航完成后清除旧 target 的选中关系和编辑器，重新请求当前页面可见内容 target 标记；当前页面内部正文、标题、说明、列表项继续直接点击进入左侧编辑。
- 同源、已登记站点 route 的页面链接可作为页面导航；外部来源、媒体、CTA 和产品行为链接不被工作台拦截，避免把业务交互误当成页面选择。
- 保留 v0.26.26 的 Web1280/Mobile390 双视图、左右独立滚动、正文 target、Web/Mobile 换行和精准 TargetImpact 刷新。

## 明确不做

- 不修改产品站点的导航组件、IA、路由定义、页面布局或视觉样式；导航拦截只存在于 dev-only 预览 frame。
- 不保留顶部页面下拉、不增加横向页面卡、不建立第二套页面分类配置。
- 不把正文点击和站点导航点击混成一个 target；内容 target 仍由唯一 registry 负责，页面导航只改变 preview route。
- 不因页面切换或内容编辑触发 Vite full reload、全站 build、ProductArtifact、ContentSet、SitePublication、EdgeOne 或线上发布。
- 不修改 active ContentSet、review/recovery/release、产品版本或已发布内容事实。

## 工程实现边界

`elon engin` 只修改 dev-only content-preview：移除 workbench page select，给 frame marker 增加已登记 route 导航识别与受控 route-sync 消息，父 workbench 维护一个 active preview route 并同步两 frame；导航与正文 target 点击必须有明确优先级和独立消息类型。页面导航不写内容源、不进入发布链路。

## 验收合同

1. 工作台顶部没有页面下拉或第二套页面分类；右侧真实站点导航可切换首页、B端产品、经营观察、观察文章、关于我。
2. 桌面与移动 Web/Mobile 两个 frame 在页面导航后同步到同一路由；移动菜单打开、选择和关闭不丢失工作台。
3. 页面导航不会触发外部跳转，不会离开工作台；导航后旧 target marker/编辑器清除，当前页面 target 重新标记。
4. 在导航后的当前页面点击正文、标题、说明、列表项仍能进入左侧 editor；内容点击不会被页面导航处理器抢走。
5. 修改正文后仍只刷新 target 的真实受影响 route×viewport；导航本身不触发内容写入、产品构建或发布。
6. 左侧 editor 与右侧 preview 继续独立滚动；页面导航后两侧滚动容器、顶部工作台结构保持稳定。
7. 运行固定 4317 一次 Xing 实际确认：站点导航切换 → 当前页面正文点击 → 修改 → 受影响 frame 更新；active/review/release/SitePublication/ProductArtifact hash 不变。
8. 只做本次工作台导航/路由同步与既有内容编辑能力的定向 QA；不重复全站产品视觉验收。

## 责任与发布边界

`elon` 维护方案与验收边界；`elon engin` 实现、测试、commit/tag/clean、exact build/preflight；Xing 做一次实际使用确认；`elon ui` 不参与本次普通工具交互验收，除非发现真实视觉/可访问性回归；`elon ops` 继续独立负责内容审核与发布。产品工程 transport 与内容发布互不触发。
