# 已归档｜XBUILD-CANDIDATE-ITEM-GOVERNANCE-001

候选 ID：`XBUILD-CANDIDATE-ITEM-GOVERNANCE-001`
状态：已归档；交接规则已收敛到 `v0.26.30` 正式方案，禁止按本文件单独实现。
owner：`elon`；适用：所有产品、治理和内容候选。

## 必须具备的逐项合同

| itemId | 缺口 | 必须实现 | 完成证据 |
| --- | --- | --- | --- |
| `CG-01` | 只有批次状态 | 每个功能点有稳定 `itemId`、owner、source/target、影响面、`beforeHash/afterHash` 和状态 | 候选逐项清单 |
| `CG-02` | Engineering 无逐项自查 | 每项记录 `enginStatus`：`not-required/pending/implemented/tested`；内容项明确 `not-required` | Engineering 回传逐项结果 |
| `CG-03` | 产品验收被批次吞掉 | 每项记录 `elonDecision` 与 `elonAcceptance`；一项未通过不得汇总为通过 | 产品逐项 Verdict |
| `CG-04` | 阻断不透明 | 每项记录 `blockerType/blocker/evidence/nextOwner`；批次只汇总未通过项 | 机器可读阻断清单 |
| `CG-05` | 内容项误送 Engineering | 按变更面分流：产品能力进 Engineering；纯内容进 `elon ops`；共享页面表现才触发 `elon ui` | handoff 与责任域一致 |
| `CG-06` | 批次完成条件不清 | 物理上可一个 Candidate/ContentSet/deployment；逻辑上必须所有 item 达到各自完成态后才允许汇总发布 | aggregate gate 通过 |
| `CG-07` | 交接丢失 | handoff 只传 itemId、状态、证据、阻断和下一动作；不得只传“已完成” | source/target/return 一致 |

## 状态规则

每项分别记录四类状态，禁止用一个批次状态代替：

```text
decision: pending → confirmed | rejected
engineering: not-required | pending → implemented → tested
acceptance: pending → accepted | blocked
delivery: not-applicable | pending → committed → deployed → published
```

`rejected`、`blocked`、`not-required` 必须写理由；只有所有 item 达到各自门槛，批次才可进入下一阶段。任务标题仍遵循项目 task 状态规则：进行中无前缀，未完成停止用 `⚠️`，责任彻底完成用 `✅`。

## 非目标

- 不为每个 item 创建独立 deployment、ContentSet、分支或 worktree。
- 不把聊天内容当作候选、正式方案或验收证据。
- 不改变已打 tag 的版本事实、ContentSet、SitePublication 或线上状态。
