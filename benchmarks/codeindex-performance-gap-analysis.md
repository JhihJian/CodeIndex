# CodeIndex 与 code-review-graph 性能差距调研

## 结论

当前三个差距的根因不同，应分开处理：

1. **最大 RSS**：CodeIndex 在构建阶段同时保留扫描结果、解析结果、符号、关系、包含树、导航和源码 blob 写入数据，并且最后还生成整份 JSONL 中间字符串。`code-review-graph` 采用进程池逐文件解析，主进程收到结果后写入 SQLite，生命周期更短。
2. **精确查询**：两边的纯元数据查询已经接近。TypeScript 测评中 CodeIndex metadata-only 查询中位数为 0.72 ms，`code-review-graph` 为 0.78 ms。CodeIndex 默认的 2.41 ms 包含源码证据读取、最多 6 个源码片段切分以及逐候选 SQLite 查询，因此不能直接和对方的节点元数据查询比较。
3. **无变化更新**：CodeIndex 的 Git 快路径顺序有问题。它先读取完整 `files.jsonl` 和 `parsed.jsonl`，然后才检查 Git revision；`code-review-graph` 先执行 Git diff，没有变化时直接返回。

TypeScript 固定提交 `8d9b6da99ea7d4a8e7d906dd2532456dfe14e24f` 的实测数据如下：

| 指标 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| 全量构建 | 246.32 s | 301.43 s |
| 最大 RSS | 2,462 MiB | 780 MiB |
| 精确查询，含 CodeIndex 证据 | 2.41 ms | 0.78 ms，节点元数据 |
| 精确查询，纯元数据阶段 | 0.72 ms | 0.78 ms |
| 无变化更新 | 1.18 s | 0.16 s |

## 证据对照

CodeIndex 的 `indexRepository()` 在获取 `currentGit` 之前调用 `loadPublished()`。当前 `loadPublished()` 同时解析 `files.jsonl` 和 `parsed.jsonl`：

- [src/lib/indexer.js](../src/lib/indexer.js) 中的 `loadPublished()`。
- [src/lib/indexer.js](../src/lib/indexer.js) 中的 Git revision 快路径。
- TypeScript 无变化更新的 RSS 为 676,972 KiB。
- `strace` 已确认无变化更新仍打开了 `files.jsonl` 和 `parsed.jsonl`。

CodeIndex 的构建循环还会同时积累以下数据：

- `parsedPrevious`、`parsedChanged`、`parsedByFile`。
- `allSymbols` 和 `containmentNodes`。
- `rawRelations` 和 `relationRecords`。
- `navigation`、`lineBytesByPath`、`fileRecords`。
- JSONL 写入前的完整对象数组。

此外，[src/lib/fs.js](../src/lib/fs.js) 的 `writeJsonl()` 使用 `rows.map(JSON.stringify).join('\n')`，写入大型 `symbols.jsonl`、`containment.jsonl` 和 `parsed.jsonl` 时会创建完整的中间字符串。

`code-review-graph` 的 [incremental.py](../../code-review-graph/code_review_graph/incremental.py) 先通过 `get_changed_files()` 判断变化文件，空结果立即返回。发生变化后才读取文件、计算 hash、查找依赖并解析。全量构建使用 `ProcessPoolExecutor`，解析结果逐项进入 SQLite，主进程没有等价的全仓库语义对象图。

精确查询方面，CodeIndex 的 [query.js](../src/lib/query.js) 会对 FTS 命中的候选逐个调用 `getSymbol()`，之后再读取关系和源码证据；[sqlite-store.js](../src/lib/sqlite-store.js) 的批量 `getSymbols()` 已存在但没有用于候选阶段。`code-review-graph` 的 [search.py](../../code-review-graph/code_review_graph/search.py) 会合并 FTS 结果，再一次批量读取节点。

## 推荐实施顺序

### P0：修复无变化更新的加载顺序

将已发布索引加载拆成两层：

1. 只读取 `published.json` 和 `manifest.json`。
2. 读取当前仓库 Git revision、dirty 状态和 submodule 状态。
3. revision 相同、工作区 clean、manifest 状态允许复用时，直接返回已发布快照。
4. 只有 revision 不同、工作区 dirty、非 Git 仓库或需要内容校验时，才读取 `files.jsonl` 和 `parsed.jsonl`。

涉及文件：`src/lib/indexer.js`、必要时 `src/lib/git.js`。

验收条件：无变化更新不打开 `files.jsonl`、`parsed.jsonl`，不调用 `scanRepository()`，snapshot id 不变，RSS 不再随符号数增长。

### P1：让精确查询先排序、后批量取 symbol

保持 FTS 评分和候选排序逻辑不变，但调整读取顺序：

1. FTS 返回的行直接完成初步评分。
2. 先按评分和路径排序，只保留最终候选数量。
3. 使用一次 `getSymbols(ids)` 批量读取 symbol。
4. 关系查询使用已有的关系索引和批量 peer 读取。
5. 源码证据继续作为单独阶段统计。

涉及文件：`src/lib/query.js`、`src/lib/sqlite-store.js`。

这样可以把最多 128 次 symbol point query 降为一次批量读取，同时保持候选排序不变。目标不是让带源码证据的查询看起来等同于节点元数据查询，而是让两组指标清楚可比：

- metadata-only：比较 FTS、排序和元数据读取。
- evidence query：比较源码读取、行切片和证据组装。

### P1：降低构建期峰值

按风险从低到高处理：

1. `writeJsonl()` 改为固定大小分块写入，避免 `map + join` 创建整份中间字符串。
2. 让 `spanFrom()` 接收当前文件已经计算的行偏移，避免每个 symbol 重建 `lineOffsets()`。
3. 当前文件处理完成后释放源码字符串和临时行偏移，避免为整个仓库保留 `lineBytesByPath`。
4. 扁平化符号和关系后释放 parser result 的临时 Map，减少 `parsedByFile`、`parsedPrevious` 和当前构建对象的重叠生命周期。
5. 如果 RSS 仍然过高，再将 JSONL/SQLite 构建改成有界批处理，而不是一次收集全仓库对象。

涉及文件：`src/lib/fs.js`、`src/lib/indexer.js`、必要时 `src/lib/sqlite-store.js`。

不建议第一步直接改成多进程并行解析。当前瓶颈是对象生命周期，直接增加 worker 会复制输入、输出和解析结果，可能降低墙钟时间但继续推高 RSS。

## 测评口径需要修正

当前比较必须保留三组指标：

1. **纯元数据查询**：两边都只返回名称、路径、类型、行范围和签名等节点元数据。
2. **带源码证据查询**：CodeIndex 从不可变 snapshot 读取 blob；对照项目也要从同一固定工作区按路径和行范围读取源码，统计读取字节和证据构造时间。
3. **关系边查询**：同时记录耗时和返回边数量。两边解析器对调用目标的解析范围不同，边数量不能直接作为性能结论。

RSS 也需要区分父进程和进程组。`code-review-graph` 使用最多 8 个解析 worker，单个 `/usr/bin/time` 的 RSS 不能无条件视为全部子进程总和。后续应记录 process group 或 cgroup 峰值。

全量构建应拆分扫描、解析、关系构建、校验、JSONL/blob 写入、SQLite 构建和后处理。`code-review-graph` 默认还运行签名、FTS、flow、community 和 summary 后处理，不能只用一个总时间推断解析器速度。

## 暂缓事项

- 暂缓 embedding。它无法解决 RSS、JSONL 物化或无变化更新加载顺序。
- 暂缓整体替换 Tree-sitter 或重写解析器。当前最明确的收益来自生命周期、批量查询和 Git 快路径。
- 暂缓把 JSONL、源码 blob、SQLite 和快照协议一次性重构。先完成 P0 和低风险 P1，再根据阶段 RSS 采样决定是否需要 canonical SQLite 或流式构建。

## 验证计划

每次改动后在同一份 TypeScript 固定工作区重复测量：

- 构建阶段 RSS：扫描、解析、对象图、校验、JSONL 写入、SQLite 构建。
- 无变化更新：JSONL 打开次数、扫描调用、parser 调用、snapshot id、RSS。
- 精确查询：metadata-only 和 evidence 两组的 p50、p95、SQLite 查询次数。
- 关系查询：耗时、返回边数量、目标符号和 peer 数量。
- 完整性：现有测试、索引校验、候选排序、关系结果和证据 digest 保持一致。

建议的第一阶段目标是：无变化更新不再读取大型 JSONL；metadata-only 精确查询保持 1 ms 内；构建 RSS 通过阶段采样确认 `parsedByFile`、重复符号节点和 JSONL 中间字符串的峰值贡献，再决定是否继续做有界批处理。
