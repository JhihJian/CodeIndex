# Linux v6.12 流式构建验证

CodeIndex 已在完整 Linux v6.12 工作区上完成 C/C++ 解析、关系汇总、导航生成、校验和原子发布。全量构建用时 **1,930.66 秒（32 分 11 秒）**，`/usr/bin/time -v` 报告的最大 RSS 为 **650 MiB**，退出码为 0。构建使用 2,048 MiB 的 V8 老生代上限。

## 数据集与测量口径

- kernel.org 官方 Linux v6.12 源码包，SHA256 为 `b1a2562be56e42afb3f8489d4c2a7ac472ac23098f1ef1c1e40da601f54625eb`。
- 本地固定 Git 提交：`e81dbc9fe6c78c547c2ce7a3354b52479b26edd9`，构建开始时工作区 clean。
- 输入为 86,677 个 Git 文件，跟踪源码约 1.38 GiB。扫描会排除二进制、超大文件和默认忽略目录。
- 当前工作区比早期基线多一个对照工具生成的 `.code-review-graph/.gitignore`，扫描将其作为普通文件收录，因此索引文件数由 86,362 变为 86,363。
- 环境为 AMD Ryzen 7 255、16 个逻辑 CPU、约 19.3 GiB 内存、Linux x64、Node.js 24.13.1。
- 最大 RSS 使用 GNU time 的进程资源统计口径，阶段进度中的 RSS 是主进程采样值。V8 老生代上限、RSS 和同时运行的进程总内存是不同指标。

## 全量结果

| 指标 | CodeIndex 流式版本 | code-review-graph 历史完整构建 |
| --- | ---: | ---: |
| 墙钟时间 | 1,930.66 s | 1,160.20 s |
| 最大 RSS | 650 MiB | 9,778 MiB |
| 索引文件 / 图文件 | 86,363 | 61,078 |
| 符号 / 图节点 | 4,616,281 | 3,020,668 |
| 关系 | 4,520,076 | 7,654,413 |
| 全部快照文件逻辑体积 | 26.50 GiB | 约 8.61 GiB |
| CodeIndex SQLite 数据库 | 11.68 GiB | 包含于图数据库 |
| C 精确问题召回 | 4/4 | 4/4 |
| Python 精确问题召回 | 4/4 | 4/4 |

流式版本的峰值 RSS 约为对照的 1/15，构建耗时约为对照的 1.66 倍。两者的符号定义、关系解析和后处理范围不同：CodeIndex 保存源码 blob、解析缓存、JSONL 审计导出、包含树和 SQLite 检索库；对照执行解析、FTS、flow 和 community。完整快照的磁盘成本包括这些派生副本。

结构化处理共 60,006 个文件，其中 C 为 59,742 个、C++ 为 4 个、Python 为 260 个。30,075 个文件解析状态为 complete，29,931 个为 partial，26,357 个为 unsupported。manifest 中 `partialFiles=56,288` 合并计算了 partial 和 unsupported；`skippedFiles=102` 为扫描排除项。

C/C++ 采用 Tree-sitter 语法解析。错误节点所在文件保留 partial 状态，已识别符号仍可查询。宏展开、条件编译求值、函数指针和 translation unit 级语义仍需编译上下文增强。

## 阶段耗时

| 阶段 | 耗时 |
| --- | ---: |
| 扫描与摘要 | 7.08 s |
| 解析、源码保存与逐批入库 | 1,424.38 s |
| 父符号关联 | 13.99 s |
| 包含树生成 | 21.10 s |
| 关系解析 | 64.38 s |
| 导航与 FTS 写入 | 182.55 s |
| 查询索引 | 27.56 s |
| 完整性校验 | 25.48 s |
| JSONL 导出 | 163.93 s |

内存中的全仓库符号和关系数组已改为 SQLite 表；解析批次限制为 64 个文件或 4 MiB 源码。增量读取旧解析缓存和最终 JSONL 导出均使用逐行迭代。特殊父键在文件入库时转换成标准符号键，使父关联使用 `symbol_key` 索引。

解析与入库占构建时间约 74%，成为当前主要时间开销。导航和 JSONL 导出分别占约 9% 和 8%。

## 查询与证据

查询先预热一次，再执行七次，表中为各问题中位数的中位数。索引加载和构建耗时单独统计。对照结果沿用同一固定源码上的历史测量。

| 查询口径 | C 四问题 | Python 四问题 |
| --- | ---: | ---: |
| CodeIndex metadata-only | 4.98 ms | 3.13 ms |
| CodeIndex 带源码证据 | 5.50 ms | 3.39 ms |
| code-review-graph 节点元数据 | 1.16 ms | 0.48 ms |
| 双方召回 | 4/4 | 4/4 |

C 问题为 `do_execveat_common`、`tcp_v4_syn_recv_sock`、`vfs_open` 和 `pick_next_task_fair`。验证脚本逐项检查了完整快照中的源码 digest、快照身份、行范围和字节边界，并确认 metadata-only 查询没有读取源码或 JSONL。

关系查询直接使用 source/type B-tree，预热一次后测量 20 次：

| 函数 | 调用边 | 已确定目标 | 中位耗时 |
| --- | ---: | ---: | ---: |
| `do_execveat_common` | 19 | 11 | 0.031 ms |
| `tcp_v4_syn_recv_sock` | 49 | 26 | 0.063 ms |
| `vfs_open` | 2 | 2 | 0.014 ms |
| `pick_next_task_fair` | 15 | 8 | 0.025 ms |

已确定目标表示当前关系解析规则选中了唯一符号，完整调用语义仍受宏和编译上下文影响。

## 无变化更新与资源回归

完整 Linux 快照上的无变化更新用时 **0.30 s**，最大 RSS **51.7 MiB**，变化文件数为 0，直接使用 manifest 与 Git 状态返回。

低内存回归设置 `--max-old-space-size=128`，对 500 个 Python 文件、100,000 个函数、99,500 条调用关系完成全量与单文件增量。全量 13.704 s，增量 8.072 s，复用 499 个文件，主进程最大 RSS 402.3 MiB。V8 报告的总堆上限为 320 MiB。此测试验证资源边界，运行耗时受并行大仓库测试影响。

PageIndex 的六个真实问题保持 6/6 命中，2,625 个符号和 17,651 条关系数量保持一致。

## 复现与原始记录

```bash
node --max-old-space-size=2048 bin/codeindex.js index \
  --repo /data/dev/bench-repos/linux-benchmark \
  --store .data/linux-stream-v5 --progress --json

node benchmarks/compare_code_review_graph.mjs \
  --store .data/linux-stream-v5 --questions benchmarks/questions-linux-c.json \
  --output benchmarks/results/linux-streaming-c.json

node --max-old-space-size=2048 benchmarks/verify-linux-streaming.mjs \
  .data/linux-stream-v5 --update
```

构建、阶段进度、查询、证据核验、环境与无变化更新记录位于 [`results/linux-streaming-*`](results)。低内存资源回归见 [`streaming-memory.json`](results/streaming-memory.json)，PageIndex 回归见 [`streaming-pageindex.json`](results/streaming-pageindex.json)。实现与恢复行为见 [`流式构建说明`](../docs/streaming-index.md)。

旧版未接入 C 解析时的 66.66 秒构建和 C 问题 0/4，以及早期四文件适配器测试，保留在 [`历史对比报告`](linux-code-review-graph-comparison.md)。当前 C 适配器仅将带定义体的类型计为定义符号，旧版曾将类型引用也计入，因此四文件符号数量与旧记录采用不同口径。
