# XBUILD-GOVERNANCE-CLI-PROCESS-LIFECYCLE-005

状态：`archived-to-v0.27.9`；来源候选已纳入正式方案。

- 目标版本：`v0.27.9`
- 正式方案：`docs/design/v0.27.9 治理 CLI 资源边界与进程生命周期根治方案.md`
- 归档理由：Xing 已批准执行 005；候选内容已转为唯一 current/design，不再作为活动候选重复维护。
- 实现边界：仅治理 CLI、inventory 资源/算法、进程生命周期、输出与 machine evidence；不包含内容存储架构 004、清理迁移、内容发布或产品 transport。
- 原始问题：`--help` 误触发无界全量 inventory，造成高 CPU/内存与孤儿进程风险。
- 当前状态：Engineering 尚未实现；必须先完成 `GOV-01..GOV-10` 未提交自 QA，再由 `elon` 逐项验收并决定 `READY_FOR_COMMIT`。
