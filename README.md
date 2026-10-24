# CodeIndex

CodeIndex 是一个面向大型代码仓库的 Node.js 结构化索引和推理工具。它采用固定仓库快照、确定性符号解析、包含树、关系图和可复核源码证据，借鉴 PageIndex 的结构优先导航方式。

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

Node/TypeScript 大型仓库基准：

```bash
node bin/codeindex.js benchmark \
  --repo /data/github/pi-mono \
  --store .data/pi-mono \
  --questions benchmarks/questions-pi-mono.json \
  --output benchmarks/results/pi-mono.json
```

与 `code-review-graph` 的实际性能对比见 [`benchmarks/code-review-graph-comparison.md`](benchmarks/code-review-graph-comparison.md)。
