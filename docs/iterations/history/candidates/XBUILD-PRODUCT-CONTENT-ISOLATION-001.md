# 已归档｜XBUILD-PRODUCT-CONTENT-ISOLATION-001

候选 ID：XBUILD-PRODUCT-CONTENT-ISOLATION-001
类型：产品/Engineering 能力候选
状态：已归档；核心合同已由 `v0.24.25` 正式方案实现。
责任：产品/视觉确认方案；Engineering 实现与验证

## 问题事实

v0.24.24 产品构建直接读取 `.content-workspace/content`，并将 Robotaxi 正文与媒体复制到产品 `dist/client`。公网内容因此可见，但没有独立 `contentReleaseId`、deployment 或 publicVerify；这不是内容独立发布成功，而是产品构建穿透了独立运营边界。

关联阻断：`CONTENT-BLOCK-ROBOTAXI-TRANSPORT-001`。

## 目标

产品发布只生成产品能力与产品基座，不隐式消费或携带独立运营内容。内容发布必须单独通过：

```text
独立内容源 → contentReleaseId/hash → immutable baseSiteArtifact → deployment → publicVerify
```

产品与内容可以分别发布、验证、回滚，互不改变对方的版本事实。

## 实施边界

- Engineering：解除产品 build 与 `.content-workspace/content` 的隐式读取和复制；保留页面能力与空内容渲染边界。
- 内容 task：继续使用独立 content root、ChangeSet、manifest、日志和恢复包；不得修改产品代码或版本文件。
- 产品 publish：只传输产品 dist；不得带入内容正文、运营媒体或内容发布身份。

## 验收

- 产品 dist 不包含独立内容正文与运营媒体。
- 产品 `release.json` 不承载 `contentReleaseId`。
- 内容独立包包含 `contentReleaseId`、content hash、baseSiteArtifactId、deployment 和 publicVerify。
- 产品迭代进行时，内容仍可独立发布；内容发布失败不污染产品版本。
- 既有页面无内容时保持合法空状态，不生成占位内容。

## 非目标

不修改 UI、IA、schema、路由、产品视觉原则或上游事实；不回写已发布版本；不创建并行 task、branch、worktree 或 automation。
