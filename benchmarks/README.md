# 基准结果

四种工具在 PageIndex、TypeScript、Linux 固定输入上的全量建库、查询、覆盖和更新结果见 [索引工具实测对比](index-tool-comparison.md)，复现脚本见 [competitors](competitors/README.md)。

当前正式后端的 Linux 全量、增量、查询与资源验证见 [linux-native.md](linux-native.md)，PageIndex 回归见 [pageindex-native.json](results/pageindex-native.json)。下文保留早期版本的测量数据，各结果按对应后端与产物范围解释。

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

## Microsoft TypeScript

数据集：67,862 个 CodeIndex 文件，149,696 个符号，223,319 条关系，源代码 205.7 MiB。CodeIndex 全量构建耗时 246.32 秒，峰值 RSS 2,462 MiB；自然语言问题集 4/4 命中，证据上下文 24.4 KB。与 `code-review-graph` 的完整对比见 [`typescript-code-review-graph-comparison.md`](typescript-code-review-graph-comparison.md)。

## Linux v6.12

流式版本已完成全量构建：86,363 个文件、4,616,281 个符号、4,520,076 条关系，用时 1,930.66 秒，最大 RSS 约 650 MiB。C 和 Python 两组问题均为 4/4 命中，C 查询中位数为 metadata-only 4.98 ms、带源码证据 5.50 ms。完整快照约 26.50 GiB，包括 SQLite、源码、解析缓存和 JSONL 导出。

单文件增量复用 86,362 个文件的解析结果，用时 807.36 秒，最大 RSS 约 1.23 GiB；新快照的四个 C 问题和源码关系证据均通过核验。测试已恢复原源码与发布指针，原始记录见 [`linux-streaming-incremental.json`](results/linux-streaming-incremental.json)。

完整测量与复现命令见 [`linux-streaming.md`](linux-streaming.md)。旧版未支持 C 时的基线和四文件适配器测试保留在 [`历史报告`](linux-code-review-graph-comparison.md)，四文件原始记录为 [`linux-codeindex-c-adapter.json`](results/linux-codeindex-c-adapter.json)。

## 流式资源回归

500 个 Python 文件包含 100,000 个函数和 99,500 条调用关系，在 `--max-old-space-size=128` 下完成全量构建和单文件增量，复用 499 个文件。V8 总堆上限为 320 MiB，主进程最大 RSS 为 402.3 MiB。资源记录见 [`streaming-memory.json`](results/streaming-memory.json)。PageIndex 六个问题保持 6/6 命中，符号和关系数量保持一致，记录见 [`streaming-pageindex.json`](results/streaming-pageindex.json)。

## 三分钟替代方案实验

Ctags + 紧凑 SQLite + Cscope 原型在相同 Linux 工作区上完成符号索引、源码保存、C/C++ 交叉引用、查询核验和发布，用时 **116.84 秒**。四个函数定位和八组调用查询均通过。GNU time 报告最大 RSS 约 2.42 GiB，完整原型快照约 3.83 GiB。

该原型的正式接入与回归结果已记录于 [linux-native.md](linux-native.md)。原型测量环境为预热文件缓存、全新输出目录、无解析缓存复用。完整范围与原始数据见 [`linux-fast-alternatives.md`](linux-fast-alternatives.md)。

## Pi provider 推理验证

`benchmarks/results/pageindex-llm-final.json` 使用本机 Pi provider `sub2api-qc101-gpt/gpt-6-luna` 对中文问题“这个函数如何构建文档树”进行了一次真实推理。模型基于 CodeIndex 返回的源码范围解释了栈式建树、页范围补全和父节点范围扩展，并引用了：

- `pageindex/flash/outline/tree.py:54-113`
- `pageindex/flash/api.py:188-247`
- `pageindex/page_index_md.py:192-223`

索引中未支持或解析失败的文件会进入 `partial` 覆盖状态，查询结果会携带不确定性说明，空结果不会被解释为代码中不存在目标。

索引与推理基准之外，与 `code-review-graph` 的独立性能对比见 [`code-review-graph-comparison.md`](code-review-graph-comparison.md)。该报告把纯元数据查询、带源码证据的查询、关系查询和增量更新分开统计。