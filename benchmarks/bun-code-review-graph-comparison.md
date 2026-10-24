# CodeIndex 与 code-review-graph 的 Bun 性能对比

本轮以 oven-sh/bun 的固定提交 `02f9249e434ed4ad6b26512a62d08caee2afb70e` 为输入，使用同一份工作区副本分别运行 CodeIndex 和 `code-review-graph`。Bun 是规模明显大于 pi-mono 的知名开源 JavaScript runtime/toolchain 项目。

## 输入规模

| 项目 | CodeIndex 扫描 | code-review-graph 图 |
| --- | ---: | ---: |
| Git 文件 | 14,650 | 14,650 |
| 跟踪源码体积 | 181.5 MiB | 181.5 MiB |
| 实际索引文件 | 13,548 | 11,291 |
| 符号 / 节点 | 23,086 | 102,675 |
| 关系边 | 152,962 | 930,237 |

CodeIndex 保留二进制和不可解码文件的跳过记录，并对未支持语言保留文件级索引。`code-review-graph` 只将可解析语言文件写入图，所以两边的节点数量不能直接当作解析质量的同义指标。

## 全量构建

| 指标 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| 墙钟时间 | 40.00 s | 83.31 s |
| 最大 RSS | 971 MiB | 1,150 MiB |
| 索引体积 | 421 MiB | 999 MiB |

CodeIndex 在这次 Bun 输入上的构建耗时约为对照项目的一半，峰值内存少约 16%，索引体积约为对照项目的 42%。CodeIndex 仍有 6,671 个部分解析文件，主要来自 Rust、Zig、C/C++ 等当前没有语言级符号适配器的文件。对照项目默认完整后处理在社区检测阶段报告 SQLite 变量数量警告，但构建命令返回成功。

## 查询

问题集包含 Bun 构建脚本、WebSocket 客户端封装、HTTP 类型定义和 Lambda 构建层四个精确符号问题，以及对应的四个自然语言问题。

| 查询类型 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| 精确查询中位数 | 0.44 ms | 0.68 ms |
| 精确查询召回 | 4/4 | 4/4 |
| 自然语言查询中位数 | 9.47 ms | 42.19 ms |
| 自然语言查询召回 | 4/4 | 1/4 |

CodeIndex 的默认结果包含源码范围、blob digest 和源码片段。对照项目默认搜索结果主要是节点元数据，后续源码取证成本没有计入查询时间，因此返回内容和工作量需要分开看。

## 关系查询和更新

对 `src/node-fallbacks/path.js::relative` 进行目标边查询时，CodeIndex 中位耗时为 0.19 ms，返回 131 条边；`code-review-graph` 中位耗时为 0.009 ms，返回 2 条边。两边的调用目标解析范围不同，关系数量不等价，耗时只用于观察索引访问成本。

无变化更新耗时为 CodeIndex 0.47 s、`code-review-graph` 0.16 s。CodeIndex 需要扫描并计算文件 digest 后复用已发布快照，`code-review-graph` 直接返回 0 个变化文件。

## 复现

```bash
cd /data/dev/CodeIndex
node bin/codeindex.js index \
  --repo /data/dev/bench-repos/bun-tracked \
  --store .data/bun
node benchmarks/compare_code_review_graph.mjs \
  --store .data/bun \
  --questions benchmarks/questions-identifiers-bun.json \
  --output benchmarks/results/bun-codeindex-identifiers.json

cd /data/dev/code-review-graph
uv run code-review-graph build --repo /data/dev/bench-repos/bun-tracked
uv run python /data/dev/CodeIndex/benchmarks/crg_query_runner.py \
  --repo /data/dev/bench-repos/bun-tracked \
  --questions /data/dev/CodeIndex/benchmarks/questions-identifiers-bun.json \
  --output /data/dev/CodeIndex/benchmarks/results/bun-crg-identifiers.json
```

原始构建、查询和更新结果保存在 [`benchmarks/results`](results)。
