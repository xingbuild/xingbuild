# 当前迭代

## 当前唯一版本：`v0.26.16`

父版本：`v0.26.15` / `222b6a93f3bae8e7c1a87b86c62d61e563add904`

## 正式方案

[`docs/design/v0.26.16 发布资产传输与运行时验证闭环方案.md`](../design/v0.26.16%20发布资产传输与运行时验证闭环方案.md)

来源 Incident：`CONTENT-PUBLICATION-STATIC-ASSET-ROUTING-WHITE-SCREEN-001`。

## 根本问题

v0.26.15 内容 SitePublication `dp9g7iu2xbai` 的五个线上路由返回 HTML shell，但 HTML 引用的 JS/CSS URL 也返回同一份 `index.html`，导致浏览器 `#root=0`、React 不挂载。相同 assembled client 在本地静态服务正常。旧 `publicVerify` 未验证静态资产 MIME/正文/完整性和浏览器运行时，因此错误 deployment 被 finalize。

## 本版本目标

1. 建立不依赖隐藏 workspace、symlink、当前目录或目录 fallback 的显式可移植 upload root。
2. 在 deploy 前对 `index.html` 所有 JS/CSS/媒体引用执行路径、存在性、长度、hash、MIME 和非 HTML fallback 硬校验。
3. 在传播后从实际公网 HTML 解析并验证同一组资产，再用唯一 `qa-browser-runtime` 验证五个路由的 root/main/h1/文本/console/pageerror/资产请求。
4. 只有资产与浏览器运行时门禁都通过才允许 SitePublication finalize；失败只能保留 blocked/recoverable 证据。
5. 对同一 publication/deployment 提供幂等 resume；必要时提供显式授权的 prior-known-good snapshot CAS rollback，失败不污染 active ContentSet。

## 允许范围

- `scripts/lib/site-publication.mjs`、`scripts/lib/site-publication-coordinator.mjs`、公网验证脚本、QA runtime 复用与相关测试。
- ProductArtifact/SiteSnapshot/SitePublication 中新增机器可读 asset/runtime evidence 和状态门禁。
- 以当前 active ContentSet 组装恢复用 SitePublication；不重建、不修改内容事实。

## 明确不做

- 不回写、重试、手改或删除 v0.26.15、`dp9g7iu2xbai`、旧 SitePublication、ContentSet、正文、审核、来源、媒体或 tag/history。
- 不直接调用 EdgeOne 绕过 Coordinator，不手工上传资产，不创建第二套发布器或浏览器 resolver。
- 不修改 UI、IA、页面组件、ResponsiveTextSlot、Why 或视觉合同。
- 不运行 content publish；内容 task 继续保持冻结，直到产品公网恢复并完成验证。

## 产品—内容兼容声明

```yaml
contentImpact: compatible
contentImpactReason: explicit-upload-root-and-static-asset-runtime-verification
affectedTargets: [publication-client-packaging, site-publication-coordinator, public-verify, qa-browser-runtime]
affectedRoutes: [/, /products, /business-observations, /observations, /about]
affectedFields: []
compatibilityEvidence: legacy-product-and-contentset-publication-package-renders-locally
```

## 验收标准

- 正确 assembled client 的 index 引用资产与 upload manifest 逐项一致；HTML fallback、错误 MIME、缺失资产、路径越界、symlink 和传播旧响应均硬失败且不 finalize。
- 五路由真实公网浏览器均 `#root` 有内容、`main=1`、`h1=1`、页面文本存在、console/pageerror=0，所有脚本/样式/媒体请求正确。
- 旧 active ContentSet 可读取，ContentSet identity、正文、审核、媒体和产品/内容责任边界不变。
- `check`、`release:prepare`、asset/runtime targeted QA、分层 `release:qa`、`release:closeout-check`、exact `release:build`、`release:preflight`、`git diff --check` 全通过。
- 产品/视觉本地验收和同一 deployment 公网复验通过后，才允许一次受控 transport；新差异进入下一版本。

## 执行顺序

1. Engineering 读取本方案实现并完成 local commit/tag/clean、ProductArtifact/preflight。
2. 产品/视觉独立本地验收。
3. Coordinator 使用当前 active ContentSet 组装并受控 transport；传播后完成资产与浏览器 runtime verify，再 atomic finalize。
4. design-ui 对同一 deployment 做公网视觉/运行时复验。
5. 只有恢复完成后，才解除 content task 冻结；不重发无关内容。
