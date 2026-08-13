# 当前迭代

## 当前唯一版本：`v0.26.20`

父版本：v0.26.19 / 36dcffa097455fc6747555751f1861ae26b7227f

## 正式方案

[docs/design/v0.26.20 本地内容预览工作台与 Task 入场治理方案.md](../design/v0.26.20%20本地内容预览工作台与%20Task%20入场治理方案.md)

## 用户目标

1. 新 task 只需读取项目入口文件，即可知道责任、必读事实、direct-local/worktree 边界和回传格式。
2. Xing 与 elon ops 可以直接编辑 canonical ignored 内容文件，并在本地真实网站即时查看 Web/Mobile 效果。
3. 本地预览、用户确认、审核、ContentSet Candidate 和正式发布保持独立，不因预览改变 active ContentSet 或线上状态。

## 正式对象与边界

- ContentPreviewSession：复用 4317 preview lease，新增 content-preview mode、targetId、sourcePath、projectionRoutes 和 active ContentSet 只读基线。
- 唯一编辑源：.content-workspace/content/**。
- 唯一定位源：content/registry/content-targets.json。
- 唯一页面投影：现有 page composition、ContentSet adapter、ResponsiveTextSlot、媒体与组件。
- 唯一正式发布链路：elon ops review → ContentSet Candidate → Site Publication Coordinator。
- 新 task 入场：AGENTS.md → docs/rules/task-onboarding.md → docs/rules/00-baseline-index.md → 责任域规则。

## 允许范围

- scripts/preview-runtime.mjs、vite.config.mjs、package.json；
- 单一 content:preview:site 命令及 dev-only workbench；
- targetId/source file/route/active baseline 定位；
- Web 1280 / Mobile 390 真实页面预览与 HMR；
- preview identity、零写入、错误和页面保持性测试；
- AGENTS.md、task-onboarding、baseline index、task registry；
- VERSION/package/current/design/history。

## 明确不做

- 不修改 ContentSet/ResponsiveTextSlot/target registry schema；
- 不修改页面 IA、生产视觉、正文、审核、媒体 approval、active.json；
- 不新建 CMS、数据库、内容目录副本或第二套发布引擎；
- 不自动复制 active/release/recovery 内容，不猜测缺失 source；
- 不运行 content publish、product transport 或 EdgeOne；
- 不创建 branch/worktree/task/automation；
- 不把本地预览称为 confirmed、approved、published 或 publicly verified。

## 用户入口

```bash
npm run content:preview:site -- --target-id products.robotaxi.intro
```

必须返回绝对 source file、fieldPath、projectionRoutes、active ContentSet baseline，并以 XINGBUILD_CONTENT_BUILD=1 在固定 4317 启动 content-preview mode。工作台只在 dev mode 存在。

## 验收标准

- registered target 精确定位；unknown/unsafe/missing/invalid JSON 在启动前硬失败；
- preview mode 与普通 preview lease 不混用，端口冲突不换端口、不杀未知进程；
- 编辑 .content-workspace/content 后 Web/Mobile 真实页面自动刷新；
- active.json、active ContentSet、review/recovery/release/SitePublication/线上 manifest 全程不变；
- /products 的 responsive intro、Why、四媒体、CTA、ClosingAction 保持；
- 五路由轻量检查无 overflow，main=1、h1=1、console/pageErrors=0；
- 工作台没有 approve/publish/deploy/active 切换能力；
- elon1 为 direct-local 只读 task，未创建 worktree；
- elon/elon ui/elon engin/elon ops 命名与真实 threadId 进入注册表。

## 内容兼容声明

```yaml
contentImpact: none
contentImpactReason: local-content-preview-and-task-governance-only
affectedTargets: [preview-runtime, content-target-resolution, vite-dev-middleware, task-governance]
affectedRoutes: [local-only]
affectedFields: []
compatibilityEvidence: active-contentset-read-only-and-no-publication-side-effects
```

## 执行顺序

1. elon 完成正式方案与 current。
2. elon engin 实现、测试、commit/tag/clean、ProductArtifact/preflight。
3. elon 做产品与架构验收。
4. elon ui 做本地 Web→Mobile 独立验收。
5. 验收通过后交给 Xing 与 elon ops 使用；内容仍需单独确认和发布。
