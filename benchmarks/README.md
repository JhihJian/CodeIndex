# 基准结果

基准使用 CodeIndex 的确定性查询与 `rg` 全仓库扫描对比。`CodeIndex` 的查询时间不含首次加载或索引构建，源码上下文统计包含返回给后续模型的证据片段。完整 JSON 报告保存在当前目录。

## PageIndex

数据集：155 个文本文件，2,625 个符号，17,651 条关系，源代码 5.27 MB。

- 6/6 问题命中，证据召回率 100%。
- CodeIndex 证据上下文 51 KB。
- 全仓库上下文 31.6 MB，减少约 618 倍。
- 相对匹配文件上下文减少约 574 倍。
- 查询中位耗时 15.7 ms，`rg` 基线 13.9 ms，处于基线 1.5 倍门禁内。

## Bun

数据集：13,548 个文本文件，23,086 个符号，152,962 条关系，源代码 135.2 MiB。Bun 固定提交共包含 14,650 个 Git 文件，跟踪源码约 181.5 MiB。

- 4/4 问题命中，证据召回率 100%。
- CodeIndex 证据上下文 23.8 KB。
- 全仓库上下文 540.9 MB，减少约 23,816 倍。
- 相对匹配文件上下文减少约 17,698 倍。
- 查询中位耗时 16.9 ms，`rg` 基线 83.6 ms，约快 4.94 倍。

Bun 的完整对比结果见 [`bun-code-review-graph-comparison.md`](bun-code-review-graph-comparison.md)。

## Pi provider 推理验证

`benchmarks/results/pageindex-llm-final.json` 使用本机 Pi provider `sub2api-qc101-gpt/gpt-6-luna` 对中文问题“这个函数如何构建文档树”进行了一次真实推理。模型基于 CodeIndex 返回的源码范围解释了栈式建树、页范围补全和父节点范围扩展，并引用了：

- `pageindex/flash/outline/tree.py:54-113`
- `pageindex/flash/api.py:188-247`
- `pageindex/page_index_md.py:192-223`

索引中未支持或解析失败的文件会进入 `partial` 覆盖状态，查询结果会携带不确定性说明，空结果不会被解释为代码中不存在目标。

索引与推理基准之外，与 `code-review-graph` 的独立性能对比见 [`code-review-graph-comparison.md`](code-review-graph-comparison.md)。该报告把纯元数据查询、带源码证据的查询、关系查询和增量更新分开统计。