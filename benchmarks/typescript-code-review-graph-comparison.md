# CodeIndex 与 code-review-graph 的 TypeScript 超大型仓库性能对比

本轮以 Microsoft TypeScript 的固定提交 `8d9b6da99ea7d4a8e7d906dd2532456dfe14e24f` 为输入，使用同一份浅克隆工作区分别运行 CodeIndex 和 `code-review-graph`。该仓库包含大量编译器测试、基线文件和 TypeScript 源码，适合观察超大型仓库中的索引规模与资源边界。

## 输入规模

| 项目 | CodeIndex 扫描 | code-review-graph 图 |
| --- | ---: | ---: |
| Git 文件 | 67,951 | 67,951 |
| 跟踪源码体积 | 207.1 MiB | 207.1 MiB |
| 实际索引文件 | 67,862 | 31,942 |
| 符号 / 节点 | 149,696 | 128,903 |
| 关系边 | 223,319 | 512,089 |

CodeIndex 对当前没有语言级适配器的 `.symbols`、`.types`、Go 和其他文件保留文件级索引，26,766 个文件完成语言解析，41,096 个文件处于部分解析状态。`code-review-graph` 的语言解析文件集合不同，因此节点和边数量不代表完全相同的覆盖范围。

## 全量构建

| 指标 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| 墙钟时间 | 246.32 s | 301.43 s |
| 最大 RSS | 2,462 MiB | 780 MiB |
| 索引体积 | 1,352 MiB | 841 MiB |

CodeIndex 在该输入上的全量构建约快 18%，但峰值内存约为对照项目的 3.2 倍，索引体积约大 61%。主要原因是 CodeIndex 同时保留所有文本文件、源码 blob、JSONL 事实导出和 SQLite 查询库，并通过 Python AST 子进程解析大量文件。

## 查询

问题集覆盖 TypeScript 的 LanguageService、BuildOrchestrator、API Client 和 Snapshot 等核心 API，包含四个精确符号问题及对应的四个自然语言问题。

| 查询类型 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| 精确查询中位数 | 2.41 ms | 0.78 ms |
| 精确查询召回 | 4/4 | 4/4 |
| 自然语言查询中位数 | 82.52 ms | 89.29 ms |
| 自然语言查询召回 | 4/4 | 0/4 |

CodeIndex 的精确查询包含源码证据，纯元数据阶段中位数为 0.72 ms。自然语言查询中，code-review-graph 默认将整句作为 FTS 条件，四个问题没有命中；CodeIndex 通过短语归一化和候选扩展保持 4/4 召回。

## 关系查询和更新

对 `packages/typescript/src/ast/utils.ts::skipParentheses` 进行目标边查询时，CodeIndex 中位耗时为 0.127 ms，返回 104 条调用边；`code-review-graph` 中位耗时为 0.011 ms，返回 3 条边。两边的调用解析范围不同，关系数量不等价，耗时用于观察邻接索引访问成本。

无变化更新耗时为 CodeIndex 1.18 s、`code-review-graph` 0.16 s。CodeIndex 在当前仓库是 Git clean 时直接通过 revision 快路径复用快照；对照项目直接返回 0 个变化文件。

## 复现

```bash
cd /data/dev/CodeIndex
node bin/codeindex.js index \
  --repo /data/dev/bench-repos/typescript-benchmark \
  --store .data/typescript
node benchmarks/compare_code_review_graph.mjs \
  --store .data/typescript \
  --questions benchmarks/questions-identifiers-typescript.json \
  --output benchmarks/results/typescript-codeindex-identifiers.json

cd /data/dev/code-review-graph
uv run code-review-graph build \
  --repo /data/dev/bench-repos/typescript-benchmark
uv run python /data/dev/CodeIndex/benchmarks/crg_query_runner.py \
  --repo /data/dev/bench-repos/typescript-benchmark \
  --questions /data/dev/CodeIndex/benchmarks/questions-identifiers-typescript.json \
  --output /data/dev/CodeIndex/benchmarks/results/typescript-crg-identifiers.json
```

原始构建、查询和更新结果保存在 [`benchmarks/results`](results)。
