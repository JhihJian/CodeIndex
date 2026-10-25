# CodeIndex、OpenGrok、Zoekt 与 CodeGraphContext 实测

2026-10-25。全部测量、查询核验与输入恢复检查已完成。

本轮在固定的 PageIndex、Microsoft TypeScript 和 Linux 输入上执行 12 次全量建库。10 个组合完成建库与查询，CodeGraphContext 在 TypeScript 上触发 12 GiB 内存上限，在 Linux 上达到 1,800 秒超时。Linux 建库最快的是 OpenGrok，TypeScript 建库最快的是 Zoekt；CodeIndex 的 Linux 全量耗时 135.88 秒，再次满足 180 秒目标。

## 全量建库与标识符查询

所有时间均为秒，查询列为毫秒。命中指标为返回的前十个不同文件中包含预期路径。每题执行一次首次查询和 20 次后续查询，表中查询时间是各题后续查询中位数的中位数。

| 输入 | 工具 | 建库秒 | 路径命中 | 查询中位毫秒 | GNU time 最大 RSS MiB | 索引产物 MiB |
|---|---|---:|---:|---:|---:|---:|
| PageIndex | CodeIndex | 1.54 | 6/6 | 0.333 | 116.4 | 9.12 |
| PageIndex | OpenGrok | 2.37 | 6/6 | 0.603 | 437.4 | 12.36 |
| PageIndex | Zoekt | 0.28 | 6/6 | 0.057 | 109.8 | 8.80 |
| PageIndex | CodeGraphContext | 8.45 | 6/6 | 0.228 | 241.1 | 3.28 |
| TypeScript | CodeIndex | 148.37 | 4/4 | 1.077 | 691.9 | 378.43 |
| TypeScript | OpenGrok | 33.02 | 2/4 | 2.405 | 1536.8 | 342.95 |
| TypeScript | Zoekt | 14.70 | 4/4 | 0.617 | 1391.6 | 535.79 |
| TypeScript | CodeGraphContext | OOM，1,228.46 秒终止 | 无完整索引 | — | 未取得 | — |
| Linux | CodeIndex | 135.88 | 4/4 | 1.645 | 3754.8 | 4495.48 |
| Linux | OpenGrok | 82.98 | 4/4 | 1.156 | 2960.2 | 2680.08 |
| Linux | Zoekt | 123.51 | 4/4 | 0.196 | 1607.2 | 3193.38 |
| Linux | CodeGraphContext | 超时，1,800.04 秒终止 | 无完整索引 | — | 未取得 | — |

两项失败时间来自监督进程。CGC TypeScript 的 systemd 结果为 `oom-kill`，进程树采样峰值约 11.40 GiB，cgroup 采样峰值约 11.94 GiB。Linux 由测量器在 1,800 秒终止，进程树采样峰值约 0.67 GiB，cgroup 峰值约 0.72 GiB。该次 Linux 失败属于超时，未观察到内存上限触发。

查询通过各工具的公开库接口执行。CodeIndex 的主计时返回元数据，源码证据另计时；OpenGrok 的片段提取在主计时之外；Zoekt 和 CGC 的查询返回片段或源码字段。表中耗时适合评估这些实际调用路径，调用方还应结合返回内容和首次打开成本选择接口。Zoekt 修正了最初适配器的 200 条匹配展示上限，补测后仍为三个输入全部命中；初始记录保存在 `*-query-match-limit200.json`。

磁盘统计对普通文件按 inode 去重，排除原始输入、Git 对象、运行时与安装依赖。CodeIndex 包含完整文本快照和 Cscope 产物，OpenGrok 包含 xref，Zoekt 保存可搜索内容，CGC 使用默认 `INDEX_SOURCE=true` 保存图节点源码。各工具的符号、图边、全文文档及按需交叉引用具有不同含义，文件和证据审计用于解释这些产物。

## 覆盖与证据核验

| 工具 | PageIndex 入库文件 | TypeScript 入库文件 | Linux 入库文件 | 额外核验 |
|---|---:|---:|---:|---|
| CodeIndex | 155/155 | 67,863/67,863 | 86,363/86,363 | 固定源码摘要与返回字节范围 |
| OpenGrok | 155/155 | 67,861/67,863 | 86,363/86,363 | Lucene 实际路径、按路径限定定义查询 |
| Zoekt | 155/155 | 67,863/67,863 | 86,363/86,363 | 内容分别跳过 3、5、2 文件 |
| CodeGraphContext | 149/155 | 建库失败 | 建库失败 | 实际 File 节点与输入清单 |

CodeIndex 的入库文件数包含仅保存文本与元数据的文件，三个输入的已解析文件分别为 112、26,766、60,005。TypeScript 输入还包含 5,189 个 Go 文件及大量其他格式，CodeIndex 当前支持范围为 Python、JS/TS、C/C++。Linux 有一个 Python 2 语法文件产生解析错误，覆盖状态保留在审计记录中。

OpenGrok 的 TypeScript 前十路径命中为 2/4。将查询限定到预期路径后，四个目标定义均能找到，差异来自排序。另有两个无关测试文件因 `defs` 字段单个 term 超过 Lucene 的 32,766 字节上限而建库失败：`generatedContextualTyping.js` 与 `parserRealSource12.js`。完整路径和错误见 [OpenGrok 审计](results/competitors/opengrok-typescript-audit.json)。PageIndex 的 `get_document_structure` 还会命中 JSON 中的同名键，路径命中指标因此只用于文件定位验收。

Zoekt 的十个内容占位文件均因 `contains too many trigrams` 跳过正文：

| 输入 | 文件 |
|---|---|
| PageIndex | `cookbook/pageindex-citation.ipynb` |
| PageIndex | `cookbook/pageindex-multimodal.ipynb` |
| PageIndex | `pageindex/flash/data/boilerplate_phrases.json` |
| TypeScript | `tsc/internal/diagnostics/loc/zh-CN.generated.json` |
| TypeScript | `tsc/internal/diagnostics/loc/zh-TW.generated.json` |
| TypeScript | `tsc/internal/bundled/libs/lib.dom.d.ts` |
| TypeScript | `package-lock.json` |
| TypeScript | `tsc/testdata/fixtures/lib/dom.generated.d.ts` |
| Linux | `arch/m68k/ifpsp060/src/fpsp.S` |
| Linux | `MAINTAINERS` |

这些文件仍可按路径找到。其余索引内容的 CRC64-ISO 与原文件一致，工作树 SHA-256 与固定清单一致，所有文件的索引 Git 版本与输入提交一致。CGC PageIndex 缺少的六个文件为 `.gitattributes`、`LICENSE`、两个 SVG、一个 JSONL 和 `pageindex/py.typed`，具体清单见 [CGC 审计](results/competitors/cgc-pageindex-audit.json)。

返回片段逐条比对原始文件，已测的十个成功组合均通过。CodeIndex 另外验证 70 条返回证据的快照 ID、blob SHA-256、输入摘要和 UTF-8 字节范围。Zoekt 提供 Git 版本、CRC64 和行字节偏移；CGC 提供图内源码及位置；OpenGrok 提供定义、引用和 xref。它们各有可用的证据信息，接入时应明确实际采用的版本与校验契约。

## 调用关系

[关系样例](competitors/relation-cases.json) 包含 PageIndex 的四条 Python 直接调用，以及 Linux 的四条 C 直接调用，位置已人工核对。CodeIndex 两组均为 4/4，CGC PageIndex 为 4/4。CGC Linux 因建库超时未执行关系查询。

CodeIndex 的 Python 调用来自解析关系，C 调用通过 Cscope 按需查询；CGC 使用图内 `CALLS` 或 `HEURISTIC_CALLS`。OpenGrok 和 Zoekt 的本轮数据来自符号检索，关系样例只在提供对应调用接口的工具上执行。上述结果覆盖少量直接调用，函数指针、重载、动态分派和复杂跨文件消歧需要单独题集。

## 无变化与单文件更新

更新均在固定输入副本中追加一个唯一函数并提交，结束后核验新函数、原题命中和已有调用样例，再恢复原提交及索引。操作按固定顺序执行，单文件更新会复用前序操作的系统缓存。每项为一次墙钟测量。

| 工具与模式 | PageIndex 无变化 / 更新秒 | TypeScript 无变化 / 更新秒 | Linux 无变化 / 更新秒 |
|---|---:|---:|---:|
| CodeIndex | 0.07 / 0.22 | 0.16 / 5.63 | 0.25 / 74.93 |
| OpenGrok | 0.84 / 0.91 | 5.08 / 5.95 | 15.59 / 12.93 |
| Zoekt 默认 | 0.02 / 0.30 | 0.04 / 17.17 | 0.07 / 123.19 |
| Zoekt 实际 delta 更新 | — / 0.07 | — / 0.09 | — / 0.15 |
| CGC 登记检查 / watch handler | 1.20 / 2.42 | 建库失败 | 建库失败 |

CodeIndex 的 C/C++ 更新重建 Cscope 交叉引用，因此 Linux 单文件更新仍需约 75 秒。CGC 的无变化结果是重复 `index` 后跳过已登记仓库；watch 实验先准备全仓库导入映射，计时包含进程启动、准备、处理及保存，排除文件事件投递和两秒防抖。

Zoekt 仅使用 `-delta` 时因默认子模块索引而回退到全量构建，日志明确记录 `delta builds currently don't support submodule indexing`。该批回退结果分别为 0.28、15.84、121.72 秒，原始记录保留。真正的 delta 路径使用 `-delta -submodules=false`，三个输入均完成增量并通过新函数和原题核验，日志确认各自仅处理变化的一个文件。这一配置适用于本轮无子模块的隔离输入，频繁更新后的 shard 合并成本需要持续运行实验补充。

10 次无变化操作、10 次普通或 watch 更新、3 次 delta 回退和 3 次实际 delta 共 26 次测量均成功。全部 16 次变更操作命中新函数，保持原有路径命中，CodeIndex/CGC 的已有关系样例也保持命中。恢复后新函数均消失，原题和关系样例保持。154,381 个输入文件及其原来源逐文件摘要一致，隔离副本提交与发布索引已恢复。验证记录见 [summary.json](results/competitors/summary.json) 和 [input-verification.json](results/competitors/input-verification.json)。项目原有测试 39/39 通过，语法检查通过。

## 选择建议

以高吞吐符号和文本搜索为目标时，Zoekt 是值得优先评估的组件：本轮标识符全部命中，热查询与实际 delta 更新较快，接入时应管理内容跳过、子模块配置和 shard 合并。需要源码浏览与交叉引用界面时，OpenGrok 的 Linux 全量性能较好，TypeScript 同名定义的默认排序需要结合路径过滤使用。

CodeIndex 保留了固定快照、SHA-256 和字节范围证据契约，同时提供 Python/JS/TS 解析关系及 Cscope 按需关系；本轮 Linux 全量满足三分钟目标，C/C++ 单文件更新的主要成本仍是 Cscope 重建。CGC 在 PageIndex 的图查询和 watch 更新均通过，大仓应用应先针对本轮 OOM 与超时结果评估资源和实现成本。

## 实验范围与复现

使用 Ryzen 7 255、16 个逻辑 CPU、约 19.32 GiB 物理内存的同一主机。全量建库串行执行，每项最多 1,800 秒、12 GiB、禁用 swap；更新每项最多 300 秒。文件与 Git 缓存预热，输出目录全新，解析缓存不复用。CGC PageIndex 的缓存由安装烟测预热，其余组合执行显式预读。工具内部并行策略保留默认值。

| 输入 | 文件数 | 文本字节 | 来源 |
|---|---:|---:|---|
| PageIndex | 155 | 5,268,104 | `b3422f9ba7ee8f3b589ac9e41cf5dc35dc6ad64a`，附本地架构文档 |
| TypeScript | 67,863 | 215,644,618 | `8d9b6da99ea7d4a8e7d906dd2532456dfe14e24f` |
| Linux | 86,363 | 1,212,793,499 | v6.12 源码包，基准工作区提交 `e81dbc9fe6c78c547c2ce7a3354b52479b26edd9` |

输入由统一文本扫描器筛选，单文件上限为 5 MiB，再复制成隔离 Git 仓库。PageIndex 包含原工作区未跟踪的 `docs/codeindex-architecture.md`，Linux 包含基准工作区额外的 `.code-review-graph/.gitignore`。来源状态、输入提交、文件清单摘要均保存在 [inputs.json](results/competitors/inputs.json)。输入只包含单个初始 Git 提交，历史检索能力属于另一个测试范围。

GNU time 最大 RSS、同时存活后代进程 RSS 总和及 cgroup 峰值分别保留。进程 RSS 求和可能重复共享页，0.25 秒采样会漏掉短进程。早期短操作的进程树样本可能只采到启动器，因此主表采用 GNU time RSS；后续测量增加 `workloadSampled`，未采到被测进程时该项为 null。cgroup 还包含文件缓存。正式建库和更新均为单次测量；14 个预先选定标识符用于功能验收，进一步评价定位质量可扩充随机抽样、同名符号和自然语言任务。

工具固定为 CodeIndex `9222f7e`、OpenGrok 1.14.20、Zoekt `572f5e4`、CodeGraphContext 0.6.13。对应许可证分别为 MIT、CDDL 1.0、Apache 2.0、MIT。CGC 使用默认 FalkorDB Lite，SCIP 关闭，自动 watch 关闭，保存源码开启。Zoekt 在本机 Git 不支持其 `cat-file --filter` 用法时采用 go-git 回退路径。

完整安装与执行步骤见 [复现说明](competitors/README.md)，机器与版本记录见 [environment.json](results/competitors/environment.json)，原始命令、日志、查询和审计见 [结果目录](results/competitors/)。
