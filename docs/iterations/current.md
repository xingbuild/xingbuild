# 当前迭代

## 当前唯一版本：`v0.27.7`

父版本：v0.27.6 / `10e03917981f91eb120c4eadfba674d65da0896e`

contentImpact: compatible
contentImpactReason: release-scope-path-identity-correction
affectedTargets: []
affectedRoutes: []
affectedFields: []
compatibilityEvidence: v0.27.6-scope-classifier-backward-compatible

## 正式方案

[v0.27.7 Scope classifier 路径身份修复方案](../design/v0.27.7%20Scope%20classifier%20%E8%B7%AF%E5%BE%84%E8%BA%AB%E4%BB%BD%E4%BF%AE%E5%A4%8D%E6%96%B9%E6%A1%88.md)

## 执行范围

修复 v0.27.6 scope classifier 对中文、空格、引号和重命名路径的 commit 读取误判：使用 NUL-safe Git path 输出并保持声明路径与 committedHead 精确匹配。仅修复发布证据读取与回归测试；不改 UI/IA/schema/正文/review/active ContentSet，不回写 v0.27.6 tag，不执行物理清理，不运行 content publish。
