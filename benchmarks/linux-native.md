# Linux 正式原生后端验证

CodeIndex 0.2 将 Ctags、Cscope 和紧凑 SQLite 接入正式 `index/query/update`。Linux v6.12 全量命令的计时覆盖扫描、源码保存、符号与交叉引用构建、校验及原子发布。最终数据来自 [全量时间记录](results/linux-native-build.time) 和 [构建结果](results/linux-native-build.json)。

## 输入与测量口径

- 仓库：`/data/dev/bench-repos/linux-benchmark`，Git 提交 `e81dbc9fe6c78c547c2ce7a3354b52479b26edd9`，对应 Linux v6.12 固定输入。
- 纳入 86,363 个文本文件、1,212,793,499 字节，其中 C/C++ 59,746 个。比最早历史基线多一个对照工具生成的 `.code-review-graph/.gitignore`，与流式和原型实验保持同一文件集合。
- 主机：Ryzen 7 255，16 个逻辑 CPU，约 19.3 GiB 内存；Node 24.13.1、Universal Ctags 5.9.0、Cscope 15.9。
- 全量使用新输出目录，未复用解析结果。文件系统缓存已预热；结果适用于本机热缓存场景。
- GNU time 的墙钟时间从正式进程启动计到退出。所有 Cscope 产物、倒排索引和数据库校验均在发布前完成。
- 最大 RSS 是 GNU time 对命令及子进程报告的数值。它与 V8 堆上限、主 Node 进程 RSS、同时存活的整个进程树内存属于不同口径。

## 构建与更新

最终全量墙钟 **135.03 秒**，达成 180 秒目标。此前两次正式集成测量分别为 143.33 秒和 133.48 秒，原始记录保留为 `linux-native-build-initial.*` 与 `linux-native-build-second.*`。最终版本补充了注释中的 include 过滤，因此使用独立的新目录再次测量。

| 指标 | 正式原生后端 |
| --- | ---: |
| 文件 | 86,363 |
| 符号 | 6,190,587 |
| SQL 保存关系 | 403,090 |
| Cscope 主要输入 / 实际文件 | 59,746 / 59,746 |
| 全量墙钟 | 135.03 s |
| GNU time 最大 RSS | 约 2.42 GiB |
| 单文件 update 命令墙钟 | 71.96 s |
| 无变化 update 墙钟 | 0.20 s，约 51.7 MiB RSS |
| SQLite | 1,433,788,416 字节，约 1.34 GiB |
| 完整单快照 | 4,713,864,322 字节，约 4.39 GiB |

SQL 关系事实随源码和解析结果入库。主要阶段如下：

| 阶段 | 耗时 |
| --- | ---: |
| 扫描与摘要 | 6.85 s |
| 源码、文件及 include 事实 | 11.77 s |
| Ctags 提取与符号入库 | 42.88 s |
| Python/JS/TS 解析入库 | 1.55 s |
| SQLite 索引与 FTS | 14.05 s |
| Cscope 构建与产物核验 | 55.60 s |
| 数据校验与收尾 | 2.25 s |

SQL 关系包含 Python/JS/TS 提取事实、C include 和 C++ 继承等；Cscope 调用与引用按需查询，SQL 计数覆盖对应存储范围。符号计数包括模块、函数、声明、类型、宏、变量和字段，与 Tree-sitter 旧版的符号分类存在差异。

单文件更新在 `fs/open.c` 末尾追加注释，只重提取该文件，复用 86,362 个文件。SQLite 从旧库克隆并局部维护，Cscope 对完整 C/C++ 快照重建。核验后恢复源码和发布指针，Git 工作区干净。详见 [更新结果](results/linux-native-incremental.json) 和 [完整脚本墙钟](results/linux-native-incremental.time)，后者用时 74.11 秒，还包含更新前后查询与恢复核验。

快照体积按 `du -sb` 统计，硬链接的 `source/` 和 `tree/` 去重；包含一个快照的数据库、源码、原生文件和目录。多个历史快照继续保留在 store 中。SQLite 构建采用临时目录和 `synchronous=OFF`，发布提供进程级隔离，整机断电后的持久性需额外存储保障或重建。

## 查询与能力回归

Linux C 与 Python 问题分别 4/4 命中，PageIndex 的 6 个自然语言问题全部命中。预热一次后连续测量 20 次，四个 C 问题各自的 metadata-only 中位耗时为 1.09–3.17 ms，带源码证据为 1.63–3.41 ms。C 查询的证据逐条核验 blob digest、快照、路径及实际返回内容的字节范围。metadata-only 查询通过禁止读取源码的检查，调用查询另用 strace 确认源码打开数为零。

| C 函数 | 被调用记录 | 调用者记录 |
| --- | ---: | ---: |
| `do_execveat_common` | 19 | 4 |
| `tcp_v4_syn_recv_sock` | 49 | 1 |
| `vfs_open` | 2 | 5 |
| `pick_next_task_fair` | 15 | 2 |

关系解析保留歧义状态，表中记录数包含尚未确定唯一目标的记录。首次关系查询包含 Cscope 子进程及结果映射，缓存后查询复用原生结果并重新解析当前目标；两者在 [关系核验结果](results/linux-native-verification.json) 中分别计时。精确名称查询的元数据和源码阶段见 [查询计时](results/linux-native-query-timing.json)，问题集单次查询见 [C](results/linux-native-c.json)、[Python](results/linux-native-python.json) 和 [PageIndex](results/pageindex-native.json)。

覆盖清单保留 26,357 个结构化解析暂不支持的文本文件，提供文件级定位。`Documentation/trace/postprocess/decode_msr.py` 使用 Python 2 print 语法，在 Python 3 解析器中标为 partial。Ctags/Cscope 提供语法提取，完整编译配置、宏展开、函数指针与 C++ 重载仍需要编译上下文。

39 项自动化测试在 Node 22.16 和 24.13 上通过，覆盖真实原生工具、快照搬移、原仓库删除、增量旧读者、同名目标、导入与继承、源码裁剪、FTS 更新、损坏产物、失败清理和显式导出。无变化更新的 strace 只打开已发布指针和清单，JSONL、数据库与源码 blob 打开数均为零，记录见 [no-op I/O](results/linux-native-noop-io.json)。

500 个 Python 文件的低堆回归包含 100,500 个符号与 99,500 条调用事实。在 `--max-old-space-size=128` 下，全量 6.083 秒，单文件更新 0.187 秒，主 Node 进程最大 RSS 约 268.7 MiB；V8 总堆上限为 320 MiB。记录见 [低堆回归](results/native-memory.json)。

## 与历史版本的关系

| 版本 | Linux 全量墙钟 | 产物与行为 |
| --- | ---: | --- |
| Tree-sitter 流式实现 | 1,930.66 s | 完整物化的包含、导航、关系、解析缓存与 JSONL；约 26.50 GiB |
| Ctags/Cscope 原型 | 116.84 s | 独立存储与有限查询验收；约 3.83 GiB |
| 正式原生后端 | 135.03 s | 正式 CLI、混合语言解析、按需导航/关系、固定源码、显式审计导出 |

当前实现移除了全库关系目标聚合、逐节点导航摘要及默认 JSONL 重复写入，保留查询时的证据与歧义表达。跨版本计数按各自解析范围解释，构建时间的下降包含存储和物化策略调整。

## 复现

先安装 README 中的原生依赖，然后执行：

```bash
/usr/bin/time -v node bin/codeindex.js index \
  --repo /data/dev/bench-repos/linux-benchmark \
  --store .data/linux-native-fresh --progress --json

node benchmarks/verify-linux-native.mjs .data/linux-native-fresh
/usr/bin/time -v node benchmarks/verify-linux-native.mjs .data/linux-native-fresh --update
/usr/bin/time -v node bin/codeindex.js update \
  --repo /data/dev/bench-repos/linux-benchmark --store .data/linux-native-fresh --json

node bin/codeindex.js benchmark \
  --repo /data/dev/bench-repos/linux-benchmark --store .data/linux-native-fresh \
  --questions benchmarks/questions-linux-python.json --output /tmp/linux-python.json
```

`--update` 验证脚本使用正式 CLI，并在 `finally` 中恢复源码和发布指针；恢复副本保存在 store。强制中断时需先检查该副本及仓库状态。环境、版本、实际快照位置和体积见 [环境记录](results/linux-native-environment.json)。
