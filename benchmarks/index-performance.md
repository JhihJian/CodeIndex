# CodeIndex 0.3 性能迭代实测

在相同固定输入和 12 GiB 内存预算下，TypeScript 全量建库由 **148.37 秒降至 10.68 秒**，Linux 由 **135.88 秒降至 78.74 秒**。PageIndex 为 1.53 秒，与基线基本一致。三个输入的全量符号、SQL 关系、源码摘要和 Cscope 主库内容通过等价检查。

## 测量范围

基线实现为 `9222f7efca28db10c90f06becd5799196d433e27`，历史结果收录于 `7904b7d`；优化实现为 `b42ddc4`，Linux 最终复测使用修复宏尾部和跨行字符串增量引用的 `413a915`。环境沿用 Ryzen 7 255、16 逻辑 CPU、19.32 GiB 物理内存、Node 24.13.1、Universal Ctags 5.9、Cscope 15.9。完整历史环境及其他工具结果见 [索引工具实测对比](index-tool-comparison.md)。

输入保持 PageIndex 155 文件、TypeScript 67,863 文件、Linux v6.12 86,363 文件，共 154,381 文件。TypeScript 输入包含 Go 等其他语言。PageIndex 包含额外的 `docs/codeindex-architecture.md`，Linux 包含额外的 `.code-review-graph/.gitignore`，与历史清单一致。

全量建库前预读源码和 Git 文件，使用新输出目录，无解析缓存复用。表中耗时包含 CLI 启动、扫描、源码冻结、建库、校验和发布。安装、输入准备和独立正确性审计单独计量。每个配置测量一次，文件缓存、后台 I/O 和运行波动仍会影响具体数值。

所有被测命令及其后代运行于 `MemoryMax=12G`、`MemorySwapMax=0` 的 systemd scope，测量串行执行。正式轮取消全局 `--max-old-space-size` 并清除 `NODE_OPTIONS`，使 worker 的 256 MiB 老生代请求生效。该值只约束 V8 老生代；进程树总预算由 cgroup 执行。

## 全量建库

| 输入 | 基线秒 | 优化秒 | 耗时缩短 | 基线 CPU 秒 | 优化 CPU 秒 | 优化快照 MiB |
|---|---:|---:|---:|---:|---:|---:|
| PageIndex | 1.54 | 1.53 | 0.6% | 1.65 | 1.64 | 9.12 |
| TypeScript | 148.37 | 10.68 | 92.8% | 150.15 | 14.32 | 378.43 |
| Linux | 135.88 | 78.74 | 42.1% | 151.93 | 156.46 | 4495.48 |

CPU 秒为 GNU time 的 user 与 system 时间之和。Linux 的平均 CPU 使用从约 1.12 核提高到 1.99 核，总 CPU 消耗接近基线。TypeScript 的总 CPU 消耗显著下降，体现了重复计算的消除。持久化产物大小基本保持一致。旧体积统计包含发布元数据，新统计仅包含发布快照，均对硬链接去重，差异约 200 字节。

JS/TS 每个文件复用行位置、括号范围和调用位置，行定位使用二分查找，声明去重使用 Set。TypeScript 的解析与入库阶段由 139.787 秒降到 2.983 秒。

Linux 冻结源码后同时构建 Cscope 和符号数据库。Ctags 按连续文件分片，按输入顺序逐行消费，每片消费完成即删除临时文件。省去分片输出的整文件拼接，SQLite 保持单写入者。最终轮 Cscope 任务耗时 58.516 秒，其中大部分与符号处理和 SQL 建索引重叠，末尾实际等待 6.432 秒。`nativeTaskMs` 与串行阶段重叠，汇总耗时只累加 `stages`。

历史 OpenGrok 在相同输入上的 TypeScript、Linux 全量分别为 33.02 和 82.98 秒，可结合原报告的功能、覆盖及计时范围作背景比较。

## 内存与并行度

| 输入 | 基线 GNU RSS MiB | 优化 GNU RSS MiB | 优化采样进程树 RSS MiB | 基线 cgroup 峰值 GiB | 优化 cgroup 峰值 GiB |
|---|---:|---:|---:|---:|---:|
| PageIndex | 116.4 | 111.3 | 141.4 | 0.099 | 0.097 |
| TypeScript | 691.9 | 837.7 | 829.8 | 1.330 | 1.412 |
| Linux | 3754.8 | 2475.2 | 2917.7 | 8.711 | 4.582 |

GNU time 最大 RSS 是进程级指标，Node worker 线程计入 Node 进程。进程树 RSS 每 0.25 秒采样，求和可能重复计算共享页，也可能漏掉短时峰值，所以可低于 GNU time 最大 RSS。cgroup 包含文件缓存。短任务来不及采样时记录为 null。最终 Linux 全量与更新的 cgroup 峰值分别为 **4.582 GiB 和 6.665 GiB**，各任务均在 12 GiB、禁 swap 条件下成功退出。

TypeScript 的四 worker 运行提高了进程 RSS。单 worker 消融结果为 **11.58 秒、554.1 MiB GNU RSS、1.196 GiB cgroup 峰值**，解析与入库阶段 3.772 秒，四个查询和证据审计通过。相对基线，单 worker 已实现约 12.8 倍加速；四 worker 在该次测量中进一步减少 0.90 秒。内存优先的环境可使用 `--workers 1`。

默认并行度为可用 CPU 数与 4 的较小值，允许 1 到 8。该参数分别限制 JS/TS worker 池和 Ctags 分片任务数，Cscope 是另一个独立任务。小于 256 KiB 或只有一个 JS/TS 文件时直接串行解析。单批最多 64 文件或 4 MiB，单个更大文件独占一批。

## 更新与查询

更新探针与历史基准完全相同，在指定文件末尾添加无参数、返回 42 的函数。更新完成后恢复输入 Git revision、文件内容和原发布指针，并验证探针消失。

| 输入 | 基线无变化秒 | 优化无变化秒 | 基线单文件更新秒 | 优化单文件更新秒 |
|---|---:|---:|---:|---:|
| PageIndex | 0.07 | 0.07 | 0.22 | 0.22 |
| TypeScript | 0.16 | 0.15 | 5.63 | 5.05 |
| Linux | 0.25 | 0.21 | 74.93 | 74.26 |

Linux 更新复用 86,362 个文件，Cscope 使用增量模式。其原生任务为 61.225 秒，历史全量交叉引用重建为 60.859 秒。更新总耗时与基线接近，主要成本仍来自旧库检查与复制、受保护文件重解析和全局倒排索引重建。更新测量位于审计之后，缓存状态受前序读取影响。

增量仅复制旧 `cscope.out`，等字节长度改写 cwd，并对新 staging tree 中的变化文件解除硬链接后调整 mtime，再用 `-U` 检查文件变化。全部摘要变化路径参与判断，包含 `.inc` 和 `.def`。文件名 alias、cwd 空白、header 长度不同、旧格式不符或其他 Cscope 版本使用全量构建。旧快照和共享 blob 保持不变。

| 输入 | 基线 hit@10 | 优化 hit@10 | 基线热查询中位 ms | 优化热查询中位 ms |
|---|---:|---:|---:|---:|
| PageIndex | 6/6 | 6/6 | 0.333 | 0.334 |
| TypeScript | 4/4 | 4/4 | 1.077 | 1.081 |
| Linux | 4/4 | 4/4 | 1.645 | 1.659 |

每题先执行一次，再执行 20 次，表中为各题热查询中位数的中位数。计时采用 metadata-only，源码证据另行审计。hit@10 表示预期路径出现在前十个不同文件中。PageIndex 与 Linux 的四条直接调用测试均通过。

## 正确性与交付检查

全量等价审计逐文件比较符号字段与父级身份、SQL 关系与来源身份，验证所有源码 tree 文件和去重 blob 的 SHA-256，并比较去掉 cwd header 后的完整 Cscope 主库内容。

| 输入 | 检查文件 | 符号 | SQL 关系 | 去重源码 blob |
|---|---:|---:|---:|---:|
| PageIndex | 155 | 2668 | 17651 | 155 |
| TypeScript | 67863 | 190793 | 242818 | 65299 |
| Linux | 86363 | 6190587 | 403090 | 85809 |

文件覆盖和解析覆盖分别核对，解析覆盖沿用基线；Linux 的 Python 2 语法文件仍保持已有的解析失败状态。70 条查询证据通过 snapshot 身份、blob 摘要及 UTF-8 字节范围核验。

另以保留的更新快照，对比旧实现的全量 Cscope 重建与新实现的增量结果。三个输入使用相同 snapshotId 和相同探针内容。初次 Linux 更新审计发现，Cscope 15.9 的 `copyinverted()` 会将部分宏尾部引用的作用域改为 `<global>`。最小复现确认了 `FN`、`CTX` 等宏的问题。继续比对还发现跨行字符串会被误当成标识符，现通过流式检查旧库的宏尾部及这类源码片段，对受影响文件强制重新解析，其余文件继续复用。修复后重新验证逐文件事实、源码和完整 Cscope 主库内容，结果一致；另核对 `field_name` 的 710 条引用、`ctx` 的 98,378 条引用和新增探针，返回内容及作用域完全一致。原始失败记录保留。该审计只读快照。

Node 22.16.0 与 24.13.1 各通过 46 项测试，覆盖串行与并行等价、分片顺序、取消与后代进程清理、连续秒级更新、删除与重命名、非标准扩展 include、旧快照哈希及 inode/mtime/mode 不变、失败后保留发布状态。`indexRepository()` 与 `runBenchmark()` 为异步接口，调用方须 `await`，用法见 [原生索引运行说明](../docs/native-index.md)。

## 原始记录与复现

- [PageIndex / TypeScript 正式第三轮](results/performance/final) 与 [Linux 最终修复复测](results/performance/final-linux)：全量、查询、审计、无变化、单文件更新及恢复记录。
- [单 worker 消融](results/performance/serial)、[PageIndex / TypeScript 更新快照等价审计](results/performance/update-equivalence)、[Linux 修复后更新等价审计](results/performance/update-equivalence-linux)、[Node 版本检查](results/performance/checks-release)。
- [Linux 更新初次失败记录](results/performance/update-equivalence-measurement.stderr)、[仅修正宏尾部后仍失败的记录](results/performance/update-equivalence-linux-failed-v4-measurement.stderr)、[宏引用差异](results/performance/cscope-query-difference.stdout)、[最小回归修复前后](results/performance/diagnostics)。Cscope 源码依据为 15.9 的 `build.c:copyinverted()` 与 `crossref.c:putposting()`，源包见 [Debian 上游归档](https://deb.debian.org/debian/pool/main/c/cscope/cscope_15.9.orig.tar.xz)。
- [首轮](results/performance/initial)：使用全局 2048 MiB old-space 参数，覆盖了 worker 的请求值，更新探针签名也与基线不同。该轮保留用于追踪实验过程。
- [第二轮](results/performance/round-2)：已校正 heap 参数与探针，尚保留 Ctags 分片拼接。TypeScript 13.74 秒、Linux 90.55 秒。第三轮采用直接消费分片，TypeScript 10.68 秒、Linux 78.66 秒。补充更新审计后修复宏及跨行字符串引用问题，再次执行 Linux 完整验收。最终 Linux 成绩采用修复后记录，所有轮次的原始结果均保留。
- [复现步骤](performance/README.md)、[机器可读汇总](results/performance/summary.json)。
