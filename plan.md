# 章节级 Canon Facts 护栏方案

## Summary
- 在现有 `history_context -> writer_context -> audit` 链路上，新增一层“章节级 canon facts（既定事实账本）”。
- 这层账本不替代现有摘要检索，而是把“已落地的命令、已确认的判断、已分配的人手、已解决/未解决的争议”抽成结构化事实，供后续章节检索、喂给 Writer、并在审计时逐条对照。
- 只做通用机制，不回填旧章节；从功能上线后新批准的章节开始累计。
- 命中明确冲突时，系统自动进入 revision，最多 2 次；仍未修复则进入人工审核。

## Key Changes
- 在章节批准后新增一个 `ChapterFactExtractionAgent`，只对“已批准章节”提取 canon facts。
- 事实分成两类即可：
  - `established_facts`：本章已经定下来的事实或命令，后文不能当成未定事项重写。
  - `open_tensions`：本章留下的争议、怀疑、隐患，后文可以继续承接，但不能改写已定事实本身。
- 存储形态采用通用 sidecar：
  - `novel_state/chapters/chNNN_facts.json`
  - `novel_state/fact_ledger.json`
- 每条事实至少包含这些字段：
  - `factId`
  - `chapterId`
  - `type`：如 `order` / `state` / `allocation` / `judgement` / `relationship`
  - `subject`
  - `assertion`
  - `status`：`established` 或 `open_tension`
  - `durability`：默认 `until_changed`
  - `evidence`
- 在细纲阶段加入 `FactSelectorAgent`，从已批准章节 facts 中挑出与当前章最相关的一组，产出 `fact_context.json/md`。
- `ChapterOutlineAgent` 输入里新增两块：
  - `必须继承的已定事实`
  - `可以继续发酵但不能改写底层结论的开放张力`
- Writer 阶段把 fact context 注入 `chapterIntent.mustKeep` 和 `ruleStack.hardFacts`，并把“允许继续冲突的点”和“禁止重开定义的点”分开写。
- 审计阶段新增维度 `canon_fact_continuity`：
  - 检查正文是否否认、重置、重发明已确立事实。
  - 检查正文是否把已执行过的命令写成首次提出。
  - 检查正文是否把“可继续争执的执行细节”误写成“底层结论重新未定”。
- 自动修正流程改为：
  - 初稿审计命中 `canon_fact_continuity=critical`
  - 生成定向 revision notes
  - 自动重写 1 次
  - 仍为 critical 再重写 1 次
  - 仍失败则停止自动修正，进入人工审核并展示冲突 fact 列表
- 运行时可视化补一张 `Fact Context` 卡，方便人工确认系统到底把哪些前章事实当成 canon。

## Interface Changes
- 新增运行时产物：
  - `runtime/staging/write/chNNN/fact_context.json`
  - `runtime/staging/write/chNNN/fact_context.md`
- 新增已定稿产物：
  - `novel_state/chapters/chNNN_facts.json`
  - `novel_state/fact_ledger.json`
- `history_context` 保留，但职责收敛为“摘要与余波”；`fact_context` 专门负责“硬事实与可延续张力”。
- `rule_stack` 新增一组来源明确的 fact guardrails，优先级与现有 `hardFacts` 一致，不单独再发明新优先级体系。

## Test Plan
- 工作流测试：批准 `ch002` 后生成 `ch002_facts.json`，且 `fact_ledger.json` 出现对应事实。
- 检索测试：生成 `ch003` 时，`fact_context` 能选中“整桶不许开、药桶垫高远火、三拨人已定”等已定事实，以及“马会魁仍在等火药问题出事”这种开放张力。
- Prompt 测试：`ChapterOutlineAgent` 和 `WriterAgent` 输入里都能看到 facts，且“已定事实”和“开放张力”分栏出现。
- 审计测试：构造类似“上一章已下令垫高远火，这一章又把‘火药该不该架高’写成首次新规”的正文，必须命中 `canon_fact_continuity` critical。
- 自动修正测试：第一次 draft 故意冲突，第一次 revision 仍冲突，第二次 revision 修好则通过；若两次都失败，则状态进入人工审核。
- 回归测试：现有 `history_context agents`、`outline continuity`、`audit` 相关测试继续通过，避免把历史摘要链路打断。

## Assumptions
- canon facts 只从“已批准章节”提取，不读取 pending draft。
- 本期不做旧项目回填；旧书想受益，需要后续单独补一个 backfill 工具。
- 事实抽取采用“LLM 提取 + 结构化 schema 限制”的方案，而不是纯规则抽取；这样对不同题材更通用。
- 允许角色继续争执“执行方式/代价/后果”，但不允许把已经落地的事实本身重新写成未定事项。
- 自动 revision 上限固定为 2 次；超过后直接交人工，不继续无限自修。
