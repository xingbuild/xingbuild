# XBUILD-CONTENT-AUTHORING-REMAINING-001

候选 ID：`XBUILD-CONTENT-AUTHORING-REMAINING-001`
状态：`DRAFT`；未进入 `current.md`，不授权 Engineering。
owner：`elon`；实现：`elon engin`；内容事实：`elon ops`；页面表现按实际变更面验收。
基线：`v0.26.29` 已完成页面导航、目标级局部预览、正文编辑和 Home source mapping。

## 未完成项

| itemId | 页面/对象 | 当前状态 | 必须实现 | Engineering 自查 | Xing 验收 |
| --- | --- | --- | --- | --- | --- |
| `CA-01` | 五路由可见内容 | 部分实现 | 每个可编辑可见字段登记 `targetId/sourcePath/fieldPath/projectionRoutes/consumerViews`；无内容时不渲染、不留空白 | registry 与页面 DOM 一一对应；未登记字段硬失败 | 逐页确认内容可定位、可编辑、局部刷新 |
| `CA-02` | About、经营观察长文 | 未实现 | 统一 `long-form-document-v1`；正文支持段落/列表/换行；页面用 projection profile 控制标题、摘要、目录、图形等可选区 | 同一 schema、稳定 block ID、旧内容可读 | 确认两页编辑体验与显示层级 |
| `CA-03` | 所有可选结构 | 部分实现 | 空的说明、摘要、Why、figure、architecture、resume 等结构不渲染，父级 flow 自动收紧 | empty fixture 无占位、无多余间距 | 逐项确认消失后的页面节奏 |
| `CA-04` | 首页产品区→最新简讯 | 未实现 | 由首页父级复用既有 responsive rhythm；修复两区块相邻无间距；不加页面私有 token | Web/Mobile geometry、空/非空两态通过 | 只验实际页面节奏 |
| `CA-05` | About 简历入口 | 未实现 | 只显示“查看简历”“下载简历”；两者使用同一受保护 PDF；下载名为 `金星简历YYYYMMDDHHmm.pdf`；不显示 HTML/PDF/内部文件名 | 源 hash/字节、链接、动态文件名、安全属性通过 | 确认入口文案与页面呈现 |

## 统一边界

- 不修改上游 career 受保护源文件；不把字体、颜色、自由富文本样式交给内容编辑器。
- 内容修改只刷新受影响 `consumerViews`；不全站 reload、build 或生成 ProductArtifact。
- `elon engin` 只能实现已进入 `current.md` 的 item；`elon ops` 只处理内容事实、审核和发布。
- 每个 item 单独记录：`beforeHash/afterHash`、影响路由、实现证据、验收结论、阻断和下一动作。
- 所有 item 通过后才可形成正式方案；本候选本身不启动实现或发布。

