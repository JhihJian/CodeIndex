# CodeIndex

CodeIndex 是一个面向大型代码仓库的 Node.js 结构化索引和推理工具。它采用固定仓库快照、确定性符号解析、包含树、关系图和可复核源码证据，借鉴 PageIndex 的结构优先导航方式。

它适合需要回答“某个功能在哪里实现”“谁调用了这个符号”“改动会影响哪些代码”这类问题的场景。CodeIndex 先用索引缩小候选范围，再读取少量源码证据，避免为了单个查询扫描整个仓库。

## 特性

- 固定快照和原子发布，查询结果绑定 snapshot、路径、行号、字节范围和 blob digest。
- 支持 Python AST、JavaScript 和 TypeScript 符号解析，对其他文本文件保留文件级索引。
- 建立仓库、目录、文件和符号包含树，以及 imports、calls、inherits、implements 等关系。
- 使用 SQLite FTS5 检索候选节点，使用关系 B-tree 索引访问邻接边。
- 元数据候选和源码证据分阶段读取，支持 `--metadata-only` 低延迟查询。
- 支持增量解析、无变化快路径、源码 blob 复用和可选 Pi provider 推理。


## 环境要求

- Node.js `>=22.5`，用于使用内置 `node:sqlite` 和 SQLite FTS5。
- Python 3，用于 Python AST 解析器。

## 安装

```bash
git clone https://github.com/heyjude0919/CodeIndex.git
cd CodeIndex
npm install
npm test
```

## 快速开始

```bash
npm test
node bin/codeindex.js index --repo /data/github/PageIndex --store .data/pageindex
node bin/codeindex.js inspect --store .data/pageindex
node bin/codeindex.js query --store .data/pageindex --query "local document store implementation"
```

索引不要求 LLM。确定性查询会返回候选符号、源码范围、快照和关系证据。需要自然语言归纳时，可使用本机 Pi provider：

```bash
node bin/codeindex.js query \
  --store .data/pageindex \
  --query "这个函数如何构建文档树" \
  --llm \
  --provider sub2api-qc101-gpt \
  --model gpt-6-luna
```

CodeIndex 通过 `pi --print --no-tools` 调用 provider，仓库内容只作为不可信上下文传入模型。

## 命令

- `index`：构建新的不可变快照并原子发布。
- `update`：读取已发布快照，复用内容未变化文件的解析结果，重新计算关系和导航数据。
- `inspect`：查看已发布快照和覆盖状态。
- `query`：在固定快照内通过 SQLite FTS5 检索符号和导航节点，通过关系 B-tree 索引查询邻接边，并按需返回源码证据。使用 `--metadata-only` 只获取候选元数据，不读取源码。
- `benchmark`：在真实仓库上对比 CodeIndex 与全仓库扫描的候选召回、查询上下文和耗时。

## 设计

详细设计见 [`docs/codeindex-architecture.md`](docs/codeindex-architecture.md)。索引数据使用 JSONL 和内容 blob 保存，发布快照同时生成只读 SQLite 查询数据库。SQLite 中的 FTS5 表负责候选检索，`relations(source_id, type)` 和 `relations(target_id, type)` 索引负责关系查询。查询先执行元数据搜索，再对少量候选按需读取源码，因此不会为了一个查询扫描全库源码。发布指针通过原子替换更新。摘要是导航派生数据，源码范围和关系边才是事实证据。


## 验证

PageIndex 基准：

```bash
node bin/codeindex.js benchmark \
  --repo /data/github/PageIndex \
  --store .data/pageindex \
  --questions benchmarks/questions-pageindex.json \
  --output benchmarks/results/pageindex.json
```

大型开源仓库基准（Bun）：

```bash
node bin/codeindex.js benchmark \
  --repo /data/dev/bench-repos/bun-tracked \
  --store .data/bun \
  --questions benchmarks/questions-bun.json \
  --output benchmarks/results/bun-codeindex.json
```

Bun 是 oven-sh/bun 的固定提交 `02f9249e434ed4ad6b26512a62d08caee2afb70e`，跟踪源码约 181.5 MiB，共 14,650 个 Git 文件。对比使用相同的 Bun 固定副本和 `code-review-graph` 默认完整构建流程：

| 指标 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| 全量构建墙钟时间 | 40.00 s | 83.31 s |
| 最大 RSS | 971 MiB | 1,150 MiB |
| 实际索引文件数 | 13,548 | 11,291 |
| 解析符号 / 图节点 | 23,086 | 102,675 |
| 关系边 | 152,962 | 930,237 |
| 索引体积 | 421 MiB | 999 MiB |
| 精确符号查询中位数 | 0.44 ms | 0.68 ms |
| 精确查询召回 | 4/4 | 4/4 |
| 自然语言查询中位数 | 9.47 ms | 42.19 ms |
| 自然语言查询召回 | 4/4 | 1/4 |
| 无变化更新 | 0.47 s | 0.16 s |

CodeIndex 的自然语言问题集覆盖 Bun 的构建脚本、WebSocket 客户端封装、HTTP 类型定义和 Lambda 构建层。精确查询与自然语言查询都返回源码证据；`code-review-graph` 的默认搜索结果主要是节点元数据。关系边直接查询中，CodeIndex 对 `src/node-fallbacks/path.js::relative` 的目标边查询为 0.19 ms，返回 131 条边；`code-review-graph` 对应目标查询为 0.009 ms，返回 2 条边，差异来自两边解析器对调用目标的解析范围不同。

这次 Bun 测评还暴露了大型混合仓库的资源边界：CodeIndex 构建峰值约 971 MiB，且 6,671 个文件处于部分解析状态；`code-review-graph` 的完整后处理在社区检测阶段出现 SQLite 变量数量警告，但构建命令仍成功完成。原始构建日志、查询 JSON 和更新时间结果保存在 [`benchmarks/results`](benchmarks/results)，详细对比见 [`benchmarks/bun-code-review-graph-comparison.md`](benchmarks/bun-code-review-graph-comparison.md)，此前 pi-mono 的历史对比仍保留在 [`benchmarks/code-review-graph-comparison.md`](benchmarks/code-review-graph-comparison.md)。
