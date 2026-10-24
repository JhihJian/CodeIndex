# Linux v6.12 性能对比

## 测试对象

本次使用 Linux kernel v6.12 官方源码包，下载地址为 kernel.org，源码包 SHA256 为：

```text
b1a2562be56e42afb3f8489d4c2a7ac472ac23098f1ef1c1e40da601f54625eb
```

源码包解压后初始化为 clean Git 快照，提交为本地复现提交 `e81dbc9fe6c78c547c2ce7a3354b52479b26edd9`。工作区包含 86,677 个 Git 文件，跟踪源码约 1.38 GiB，其中主要是 34,664 个 C 文件和 25,308 个头文件。

CodeIndex 和 `code-review-graph` 都使用同一个工作区。`code-review-graph` 使用默认完整构建流程，包含解析、FTS、flow 和 community 后处理。

## Tree-sitter C/C++ 适配器验证

当前版本在同一份 Linux v6.12 工作区上直接解析四个 C 源文件，目标函数均被识别：

| 文件 | 目标函数 | 函数符号 | 总符号 | includes | calls | references | 状态 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `fs/exec.c` | `do_execveat_common` | 65 | 201 | 52 | 405 | 4 | partial |
| `net/ipv4/tcp_ipv4.c` | `tcp_v4_syn_recv_sock` | 88 | 528 | 34 | 887 | 0 | partial |
| `fs/open.c` | `vfs_open` | 40 | 140 | 29 | 235 | 2 | partial |
| `kernel/sched/fair.c` | `pick_next_task_fair` | 457 | 1,473 | 32 | 2,177 | 43 | partial |

四个目标函数的召回为 4/4，共提取 2,342 个符号、147 条包含关系、3,704 条直接调用关系和 49 条宏引用关系。`partial` 表示 Linux 源码包含依赖编译上下文的条件分支或 Tree-sitter 错误节点，解析器保留已识别的确定性范围并将无法确认的关系留在未解析状态。

完整 Linux 重建仍受主进程符号聚合内存约束：原生 Tree-sitter 解析已通过子进程批处理控制单批 native 内存，主进程在默认约 4 GiB V8 堆上聚合全仓库结果时耗尽堆空间。当前适配器的功能验证使用上述真实文件和独立 fixture，完整 Linux 性能表待流式符号写入完成后更新。

## 全量构建

| 指标 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| 全量构建墙钟时间 | 66.66 s | 1,160.20 s |
| 最大 RSS | 约 1,677 MiB | 约 9,778 MiB |
| 实际索引文件 / 图文件 | 86,362 | 61,078 |
| 解析文件 | 259 | 61,078 |
| 符号 / 图节点 | 5,175 | 3,020,668 |
| 关系边 | 24,284 | 7,654,413 |
| FTS 节点 | SQLite FTS5 | 1,396,157 |
| 索引体积 | 约 1.35 GiB | 约 8.61 GiB |
| 部分解析文件 | 86,103 | 未单独统计 |

CodeIndex 当前只对 Python、JavaScript 和 TypeScript 生成结构化符号。Linux 的 C、头文件、汇编和大量脚本因此主要保留文件级索引，结构化解析文件只有 259 个。`code-review-graph` 能够解析 C/C++，所以在这个项目上生成了数量显著更多的函数、类型和关系节点。

CodeIndex 的全量构建时间明显更短，主要原因是它跳过了 Linux C 语义解析以及对照工具的完整图后处理。该结果用于观察资源边界，两套工具的解析能力和后处理范围需要分别解读。

## 查询

查询分为 C 函数和 Python 函数两组，每组 4 个问题。CodeIndex 查询同时测量源码证据，`code-review-graph` 查询返回结构节点元数据。

### C 函数

问题包括 `do_execveat_common`、`tcp_v4_syn_recv_sock`、`vfs_open` 和 `pick_next_task_fair`。

| 指标 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| 召回 | 0/4 | 4/4 |
| 查询中位数 | 0.11 ms | 1.16 ms |
| CodeIndex metadata-only 中位数 | 0.10 ms | 未单独测量 |

CodeIndex 的 0/4 反映了当时的 C 解析覆盖范围；空结果表示该版本没有相应的结构化符号事实。对照项目可以通过 C Tree-sitter 解析返回函数节点。

### Python 函数和类

问题包括 `have_command`、`markup_refs`、`KernelCmd` 和 `do_parse`。这组文件两边都能结构化解析。

| 指标 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| 召回 | 4/4 | 4/4 |
| 带源码证据查询中位数 | 0.32 ms | 0.48 ms，节点元数据 |
| CodeIndex metadata-only 中位数 | 0.16 ms | 未单独测量 |

CodeIndex 的结果包含不可变 snapshot、源码行号、字节范围和 digest。`code-review-graph` 的结果主要包含函数或类节点元数据，因此查询响应体大小和证据语义也不同。

## 无变化更新

两边都在构建完成后对 clean 工作区执行更新命令：

| 指标 | CodeIndex | code-review-graph |
| --- | ---: | ---: |
| 更新墙钟时间 | 0.27 s | 0.23 s |
| 最大 RSS | 约 52 MiB | 约 36 MiB |
| 变化文件 | 0 | 0 |
| 解析节点 / 边 | 0 | 0 |

CodeIndex 直接命中 manifest-only Git 快路径，不读取大型 `files.jsonl` 和 `parsed.jsonl`。两边在 Linux 这个 Git 快照上的无变化更新已经处于同一数量级。

## 结果解释

Linux v6.12 暴露了 CodeIndex 当前的语言覆盖边界，同时验证了最近的资源优化：

- CodeIndex 的 JSONL 分块写入、源码布局复用和临时对象释放在 1.38 GiB 源码输入上仍能把峰值 RSS 控制在约 1.67 GiB。
- `code-review-graph` 的 C/C++ 结构化解析带来了更高的符号和关系覆盖，但完整构建及后处理的峰值 RSS 约 9.78 GiB，数据库约 8.61 GiB。
- 在两边都支持的 Python 子集上，CodeIndex 的 metadata-only 查询中位数约 0.16 ms，带源码证据查询中位数约 0.32 ms。
- 提升 Linux 这类项目的实际价值，应优先增加 C/C++ 解析适配器或 Tree-sitter 适配，再继续优化空结果查询。

原始构建、更新和查询结果保存在 [`benchmarks/results`](results)；问题集保存在 [`questions-linux-c.json`](questions-linux-c.json) 和 [`questions-linux-python.json`](questions-linux-python.json)。
