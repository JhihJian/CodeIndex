# CodeIndex 与 code-review-graph 性能对比

对照项目：[`heyjude0919/code-review-graph`](https://github.com/heyjude0919/code-review-graph)，commit `0919071a9ba353e604981059e99ee2ed98768092`。

测试时间、机器和输入仓库保持一致。两套工具都使用本地确定性索引，不启用向量模型和远程 LLM。CodeIndex 另外使用 Pi provider 做了一次真实推理验证，结果单独记录。

## 结论

`code-review-graph` 更适合已经知道符号名、需要高频图关系查询和多语言解析的场景。它的 SQLite + FTS5 + Tree-sitter 组合在纯搜索和图边查询上明显更快，初始索引的内存占用也更低。

CodeIndex 更适合从自然语言问题直接定位源码并把证据交给后续模型的场景。它的默认查询会读取源码范围，返回快照、符号、行号、blob digest 和源码片段。相同问题下，CodeIndex 的证据召回率更高，输出可以直接用于推理。

这不是单一的全面胜负。两者优化的查询单位不同：`code-review-graph` 的搜索结果主要是节点元数据，CodeIndex 的结果已经包含源码证据。直接比较两者的返回字节数会低估 `code-review-graph` 后续读取源码的成本，也会高估 CodeIndex 单次查询的工作量。

## 测试输入

使用两个真实仓库：

| 仓库 | Git HEAD | CodeIndex 扫描文件 | CodeIndex 符号 | CodeIndex 关系 | code-review-graph 图文件 | code-review-graph 节点 | code-review-graph 边 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| PageIndex | `b3422f9` | 154 个文本文件 | 2,625 | 17,651 | 121 个可解析代码文件 | 2,499 | 23,120 |
| pi-mono | 当前 HEAD | 667 个文本文件 | 2,709 | 19,289 | 512 个可解析代码文件 | 6,144 | 55,733 |

两个仓库都使用相同的 Git HEAD 内容。文件数不同是产品策略差异：CodeIndex 保留文件级降级索引并记录 Markdown、JSON、YAML 等文本文件；`code-review-graph` 默认只把支持的代码文件写入图。比较源码解析能力时，报告同时保留双方的解析节点和关系数量。

## 全量构建

| 仓库 | 工具 | 墙钟时间 | 最大 RSS | 索引体积 | 状态 |
| --- | --- | ---: | ---: | ---: | --- |
| PageIndex | CodeIndex | 6.45 s | 211 MiB | 24.3 MiB | partial，112 个文件完成语言解析 |
| PageIndex | code-review-graph | 2.23 s | 75 MiB | 20.7 MiB | 完成，121 个代码文件 |
| pi-mono | CodeIndex | 4.24 s | 238 MiB | 30.9 MiB | partial，502 个文件完成语言解析 |
| pi-mono | code-review-graph | 5.39 s | 109 MiB | 62.4 MiB | 完成，512 个代码文件 |

`code-review-graph` 在 PageIndex 上构建约快 2.9 倍，内存约少 64%。在 pi-mono 上 CodeIndex 构建约快 1.3 倍，但内存约为对方的 2.2 倍，索引体积约为对方的一半。

CodeIndex 当前 Python 解析通过 Node.js 调用 Python 标准库 AST，进程间传输文件源码会带来明显内存峰值。JavaScript/TypeScript 使用 Node.js 内置启发式解析器。`code-review-graph` 使用 Tree-sitter，并在单个 SQLite 数据库中写入节点、边和 FTS5 索引。

## 自然语言查询

问题集覆盖“本地文档存储实现”“文档树构建”“客户端 API”“模型 provider registry”等问题。每个结果都按期望路径或符号检查证据召回。

| 仓库 | 工具 | 命中 | 证据召回率 | 查询中位耗时 | 返回源码证据 |
| --- | --- | ---: | ---: | ---: | --- |
| PageIndex | CodeIndex | 6/6 | 100% | 8.7 ms | 是，累计 51.1 KB |
| PageIndex | code-review-graph | 0/6 | 0% | 0.83 ms | 否，默认 FTS5 无结果 |
| pi-mono | CodeIndex | 4/4 | 100% | 5.2 ms | 是，累计 17.0 KB |
| pi-mono | code-review-graph | 2/4 | 50% | 3.0 ms | 否，返回节点元数据 |

`code-review-graph` 的默认 FTS5 查询把整句自然语言作为搜索条件，并且默认不安装向量模型。它对精确符号查询表现良好，但不能把“构建文档树”稳定映射到 `build_tree_from_nodes` 这类代码符号。启用它的可选 embedding 依赖后，召回结果可能变化，本次没有把额外模型下载和推理成本混入默认对比。

## 精确符号查询

这一组问题直接使用符号名，排除自然语言路由差异，用于比较索引本身的查询速度：

| 仓库 | 工具 | 命中 | 查询中位耗时 | 单次典型返回 |
| --- | --- | ---: | ---: | --- |
| PageIndex | CodeIndex | 6/6 | 6.25 ms | 约 7.9 KB，包含源码证据 |
| PageIndex | code-review-graph | 6/6 | 0.26 ms | 约 1.8 KB，主要是节点元数据 |
| pi-mono | CodeIndex | 4/4 | 4.52 ms | 约 9.7 KB，包含源码证据 |
| pi-mono | code-review-graph | 4/4 | 0.51 ms | 约 7.6 KB，主要是节点元数据 |

在纯搜索延迟上，`code-review-graph` 约快 10 到 24 倍。这个差距主要来自 FTS5 的数据库索引和 CodeIndex 查询阶段读取源码证据的额外工作。

## 关系查询

使用调用者查询验证关系图访问：

| 查询 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| `build_tree_from_nodes` 的调用者 | 6.36 ms，1 条关系，带源码证据 | 0.01 ms，1 条关系 |
| `loadExtensions` 的调用者 | 8.95 ms，2 条关系，带源码证据 | 0.01 ms，1 条关系 |

`code-review-graph` 的 SQLite 复合索引和直接边查询更适合高频调用链、继承链和影响范围计算。CodeIndex 当前会在已加载的 JSONL 索引上扫描关系并同时组织源码证据，因此查询延迟更高。

## 增量更新

在没有源码变化的情况下执行更新：

| 仓库 | 工具 | 墙钟时间 | 结果 |
| --- | --- | ---: | --- |
| PageIndex | CodeIndex | 4.84 s | 154 个文件复用解析结果，重新校验并发布快照 |
| PageIndex | code-review-graph | 0.45 s | 1 个文件更新，FTS 和派生数据刷新 |

`code-review-graph` 的增量路径更细，能够直接定位变化文件并局部刷新 SQLite 数据。CodeIndex 当前复用未变化文件的解析结果，但仍会重新构建关系、导航和新的不可变快照，适合一致性优先的更新流程，尚未达到对方的增量速度。

## 能力边界

| 能力 | CodeIndex | code-review-graph |
| --- | --- | --- |
| Node.js 主程序 | 是 | 否，Python 主程序，另有 VS Code TypeScript 扩展 |
| Python | Python AST 适配器 | Tree-sitter |
| JavaScript/TypeScript | Node.js 启发式解析 | Tree-sitter |
| 多语言覆盖 | 当前 Python、JS/TS，其他文本文件级索引 | 19 种语言及 notebook 支持 |
| 快照和 blob digest | 有 | 文件 hash 和 SQLite 状态，有 Git 增量机制 |
| 包含树 | 有 | 以 `CONTAINS` 边表达 |
| 关系图 | 有调用、导入、继承等关系 | 有调用、导入、继承、测试覆盖和影响半径等关系 |
| 自然语言路由 | 短语归一化，可接 Pi provider | FTS5，embedding 为可选能力 |
| 直接源码证据 | 查询结果内置 | 通常需要后续 review/context 工具读取 |
| 原子快照发布 | 有 manifest 和不可变快照目录 | SQLite WAL 和迁移机制 |

## 可复现命令

构建对照项目：

```bash
cd /data/dev/code-review-graph
uv run code-review-graph build --repo /data/github/PageIndex
uv run code-review-graph build --repo /data/github/pi-mono
```

运行 CodeIndex 查询基准：

```bash
cd /data/dev/CodeIndex
node benchmarks/compare_code_review_graph.mjs \
  --store .data/tracked-pageindex \
  --questions benchmarks/questions-pageindex.json \
  --output benchmarks/results/codeindex-vs-crg-pageindex.json
```

运行对方查询基准：

```bash
cd /data/dev/code-review-graph
uv run python /data/dev/CodeIndex/benchmarks/crg_query_runner.py \
  --repo /data/github/PageIndex \
  --questions /data/dev/CodeIndex/benchmarks/questions-pageindex.json \
  --output /data/dev/CodeIndex/benchmarks/results/code-review-graph-pageindex.json
```

所有原始结果、`/usr/bin/time -v` 构建日志和问题集都保存在 `benchmarks/results/` 与 `benchmarks/` 目录。

## 最终判断

如果目标是代码关系图的低延迟查询、多语言覆盖和增量更新，`code-review-graph` 当前实现更成熟，尤其适合作为 MCP 后端直接给出调用者、依赖和影响范围。

如果目标是让模型从自然语言问题出发，获得固定版本、精确行范围和源码片段，CodeIndex 的证据协议更直接。CodeIndex 下一步最有价值的性能改进是把 JSONL 关系扫描改成 SQLite 或内存倒排索引，同时把 Python AST 解析改成 Node.js 内可复用的 Tree-sitter 适配器，以降低内存和增量更新成本。
