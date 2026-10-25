# CodeIndex 0.3 在 CPython、VS Code 与 LLVM 上的横向对比

## 结论

冻结后的 CodeIndex 在真实 TypeScript 应用 VS Code 上保持了建库速度优势，但结果随语言和输入特征明显变化：

- **VS Code：** CodeIndex 三轮建库中位数 4.70 秒，OpenGrok 为 11.90 秒，Zoekt 为 9.67 秒，CGC 为 519.24 秒。CodeIndex 符号题 8/8，调用题 2/3，仍存在函数定义漏提取。
- **CPython：** CodeIndex 中位数 28.87 秒，慢于 OpenGrok 的 10.20 秒和 Zoekt 的 8.82 秒。符号题 8/8，但 Python 解析另有 74 个文件为 partial，内容题为 0/2。
- **LLVM：** CodeIndex 和 Zoekt 因 Ctags 失败未完成建库，CGC 超出 1800 秒预算。OpenGrok 完成建库，中位数 80.90 秒，文件覆盖完整，符号题 5/8。

九个成功组合共完成 27 次全新构建，三个失败组合各保留一次尝试，合计 30 次。成功组合三轮的逐题命中状态一致。全部 20 次无变化或单文件更新操作完成，探针和既有命中检查通过，CodeIndex 两个成功项目的增量结果均与独立全量构建等价。所有输入和原发布状态已恢复。各工具的功能、覆盖和返回工作量不同，下文分项比较。

## 输入、版本与预算

| 项目 | 固定版本 | 共同输入文件 | 文本字节 |
|---|---|---:|---:|
| CPython | 3.14.0 | 5,019 | 103,533,479 |
| VS Code | 1.105.0 | 8,071 | 95,990,525 |
| LLVM | 21.1.0，完整 llvm-project 官方源码发行包 | 158,039 | 1,689,076,171 |

这些项目覆盖混合 C/Python 标准库、真实 TypeScript 应用和大型 C++ 编译器工程，均未参与上一轮 CodeIndex 调优。输入由相同扫描器筛选文本，单文件上限 5 MiB。每个工具读取完全相同的文件集合，Git blob 与工作树逐文件核对原始字节，换行、编码和过滤器转换通过隔离副本的 Git 属性关闭。上游版本、归档摘要、输入排除项与语言分布分别见 [sources.json](results/heldout/sources.json) 和 [inputs.json](results/heldout/inputs.json)。

CodeIndex 固定为 0.3.0、产品提交 `362cbce6e00f7f13018bbecd91ab72f2e051ed9c`，本轮只调整测量与审计脚本。OpenGrok 为 1.14.20，Zoekt 提交为 `572f5e4a3a37532300298e2ba38513c15b2e0319`，CodeGraphContext 为 0.6.13、FalkorDB Lite 后端。Ctags 5.9、Cscope 15.9 及二进制摘要见 [environment.json](results/heldout/environment.json)。旧 LLVM 本地归档完整性检查失败，开测前改为官方 21.1.0 源码包，完成 xz 校验并核对上游 tag 对应提交。

测试主机为 Ryzen 7 255、16 个逻辑 CPU、约 19.32 GiB 内存。每个测量命令及全部后代统一限制为 12 GiB、禁用交换，全部串行执行。全量构建预算 1800 秒，查询、普通审计和更新预算 300 秒。CodeIndex 自身原生构建默认 180 秒限制保持原样。CodeIndex 设置四个 JS/TS 解析 worker，清除 `NODE_OPTIONS`；OpenGrok 使用 `-Xmx8g`；Zoekt 使用默认四个 worker；CGC 开启源码保存，关闭 SCIP 和自动 watch。

建库及符号查询首次完成的组合进行三次全新建库，工具顺序按轮次轮换。每次预读源码与 Git，使用全新索引目录，结果属于输入预热条件下的构建。失败保留原始记录和实际耗时。三次范围用于展示本机观测波动。后台系统服务正常运行，CPU 未绑核。

## 建库与资源

成功组合列三次中位数及最小至最大范围，CPU 为 GNU time 报告的用户时间与系统时间之和。失败行列单次终止耗时和已观测资源，产物体积只列完成的索引。

| 项目 | 工具 | 建库秒，中位数［范围］或失败耗时 | CPU 秒 | 产物 MiB |
|---|---|---:|---:|---:|
| CPython | CodeIndex | 28.87［28.80–29.00］ | 30.72 | 255.53 |
| CPython | OpenGrok | 10.20［9.28–11.97］ | 99.56 | 192.58 |
| CPython | Zoekt | 8.82［8.54–8.85］ | 9.34 | 266.11 |
| CPython | CGC | 363.95［363.36–364.83］ | 301.05 | 77.71 |
| VS Code | CodeIndex | 4.70［4.67–4.72］ | 7.80 | 183.45 |
| VS Code | OpenGrok | 11.90［11.41–12.91］ | 122.31 | 174.47 |
| VS Code | Zoekt | 9.67［9.56–9.69］ | 10.62 | 245.68 |
| VS Code | CGC | 519.24［518.06–520.49］ | 440.32 | 82.57 |
| LLVM | CodeIndex | 47.39，失败 | 51.20 | — |
| LLVM | OpenGrok | 80.90［79.06–89.23］ | 848.55 | 2680.15 |
| LLVM | Zoekt | 29.95，失败 | 47.46 | — |
| LLVM | CGC | 1800 秒预算超时 | — | — |

| 项目 | 工具 | GNU 最大 RSS MiB | 采样进程树 RSS MiB | cgroup 峰值 GiB |
|---|---|---:|---:|---:|
| CPython | CodeIndex | 386.0 | 405.4 | 0.596 |
| CPython | OpenGrok | 1404.2 | 1404.3 | 1.679 |
| CPython | Zoekt | 793.7 | 774.4 | 1.011 |
| CPython | CGC | 3152.2 | 3191.0 | 3.718 |
| VS Code | CodeIndex | 581.7 | 558.3 | 0.702 |
| VS Code | OpenGrok | 1658.5 | 1661.3 | 1.947 |
| VS Code | Zoekt | 808.5 | 788.7 | 0.841 |
| VS Code | CGC | 3210.5 | 3249.5 | 3.592 |
| LLVM | CodeIndex，失败 | 560.2 | 560.7 | 3.609 |
| LLVM | OpenGrok | 2258.1 | 2257.1 | 4.247 |
| LLVM | Zoekt，失败 | 1578.7 | 1581.9 | 2.354 |
| LLVM | CGC，超时 | — | 317.4 | 0.346 |

LLVM 的 CodeIndex 日志记录 Ctags `SIGSEGV`；Zoekt 的 `require_ctags` 模式记录 `parser_overflow.c` 响应异常。该原始测试文件含 16,384 层大括号，[单文件诊断](results/heldout/ctags-llvm-overflow-diagnostic.json) 使用相同 CodeIndex 解析选项复现返回码 `-11`，文件摘要保持不变。OpenGrok 也记录 Ctags 退出码 139，但继续完成建库。原始日志分别见 [CodeIndex](results/heldout/codeindex-llvm-build.stderr)、[Zoekt](results/heldout/zoekt-llvm-build.stderr)、[OpenGrok](results/heldout/opengrok-llvm-build.stderr)。

CGC 的 LLVM 尝试达到预算后清理了全部后代，监督器实际耗时 1800.15 秒。GNU time 随 scope 终止，wall、CPU 和最大 RSS 记录缺失；进程树 RSS 和 cgroup 峰值来自独立观测。该次失败为超时，未耗尽 12 GiB 内存预算。具体耗时阶段尚未定位。

CPython 的第一轮 CodeIndex 阶段记录中，解析及入库耗时 26.202 秒，占总构建 28.810 秒的约 91%。GNU time 的用户与系统 CPU 合计 30.72 秒，约相当于平均使用 1.06 个核。当前 [并行解析器](../src/parsers/parallel.js) 只把 JS/TS 分配给 worker，Python 仍通过同步批次解析并入库，因此该负载未获得 JS/TS 专项路径的收益。原生任务计时包含异步回调等待，具体记录见 [构建阶段](results/heldout/codeindex-cpython-build.stderr) 和 [CPU 时间](results/heldout/codeindex-cpython-build.time)。

GNU time 最大 RSS、采样进程树 RSS 总和、cgroup 峰值分别报告。进程 RSS 相加可能重复计算共享页，0.25 秒采样可能漏峰值，cgroup 还包含文件缓存。采样未覆盖任务时记为 null。产物体积包含该工具完整索引，硬链接按 inode 去重，独立输入与 Git 不计入产物。

## 符号定位、内容检索与覆盖

| 项目 | 工具 | 已索引输入文件 | 符号 hit@10 | 内容 hit@10 | 热查询 ms | 首次查询 ms | 加载 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| CPython | CodeIndex | 5019/5019 | 8/8 | 0/2 | 0.795 | 0.978 | 1.12 |
| CPython | OpenGrok | 5019/5019 | 8/8 | 1/2 | 0.697 | 1.341 | 174.11 |
| CPython | Zoekt | 5019/5019 | 8/8 | 2/2 | 0.178 | 0.451 | 7.33 |
| CPython | CGC | 3575/5019 | 7/8 | 1/2 | 0.199 | 0.260 | 1906.56 |
| VS Code | CodeIndex | 8071/8071 | 8/8 | 2/2 | 0.701 | 1.093 | 1.16 |
| VS Code | OpenGrok | 8071/8071 | 7/8 | 2/2 | 0.604 | 1.093 | 165.74 |
| VS Code | Zoekt | 8071/8071 | 8/8 | 2/2 | 0.507 | 1.039 | 8.16 |
| VS Code | CGC | 7571/8071 | 8/8 | 1/2 | 0.234 | 0.282 | 1729.09 |
| LLVM | OpenGrok | 158039/158039 | 5/8 | 1/2 | 0.876 | 3.011 | 182.04 |

LLVM 的另外三个工具未形成完整可查询索引，其覆盖和查询标为未测。

文件覆盖只衡量输入路径是否进入索引。CodeIndex 的 CPython 为 3115 个完整解析文件、1830 个不支持语言文件、74 个 Python partial 文件；VS Code 为 5986 个完整解析文件、2083 个不支持语言文件、2 个 Python partial 文件。CPython 的 74 个文件中，10 个记录 SyntaxError，另 64 个共享一次 Python 批次的 `ValueError: field 'value' is required for Constant`。当前 Python 解析运行时为 3.12，输入包含 Python 3.14 语法与故意构造的测试文件。VS Code 的两个 Python 文件均为着色测试样例。完整路径和错误见 [CPython 解析诊断](results/heldout/codeindex-cpython-parser-status.json) 与 [VS Code 解析诊断](results/heldout/codeindex-vscode-parser-status.json)。`complete` 是解析器状态，也可能存在漏提取，调用题提供了这样的实例。

CGC 的 CPython 缺失 1444 个输入文件，VS Code 缺失 500 个；CGC 的文件规则和支持范围与共同输入集合不同。其 `PyLong_FromLong` 漏题对应目标文件中的同名 Function/Class 节点缺失，`Objects/longobject.c` 文件节点本身存在。其余 15 个目标节点存在，返回源码范围覆盖声明行，见 [CPython 定义诊断](results/heldout/cgc-cpython-definitions.json) 和 [VS Code 定义诊断](results/heldout/cgc-vscode-definitions.json)。

OpenGrok 的 VS Code `URI` 定义项存在，漏题来自前十文件排名。LLVM 的 `LLVMContext`、`APInt` 在目标文件有定义项但未进入前十；`DominatorTree` 的目标文件缺少对应定义项。八道 LLVM 符号题中仅四道返回片段覆盖预期声明行，进一步区别于 5/8 的文件命中。见 [VS Code](results/heldout/opengrok-vscode-audit.json)、[LLVM 定义诊断](results/heldout/opengrok-llvm-audit.json) 及 [LLVM 行号证据](results/heldout/opengrok-llvm-symbol-evidence.json)。

Zoekt 的两个成功项目路径覆盖完整，CPython 有 4 个文件、VS Code 有 99 个文件以 `NOT-INDEXED` 正文占位保存。其余分别 5015、7972 个文件通过 CRC64 内容校验，Git revision 和源码摘要均一致。具体占位路径见 [CPython](results/heldout/zoekt-cpython-audit.json) 和 [VS Code](results/heldout/zoekt-vscode-audit.json)。

每项目固定八个符号题、两个内容题，题目及预期源码行在开测前提交。`hit@10` 表示前十个不同文件包含预期路径。定义存在、声明行位置和查询排名分别检查。CodeIndex/OpenGrok 的定义诊断与 CGC 的按文件图节点诊断用于解释漏题，独立于计分接口。

每题首次调用后再测二十次，热查询统计先取每题中位数，再跨题和三次构建汇总。首次调用共享已打开的进程与预热输入。CodeIndex 计时为 metadata-only，读取证据另计；OpenGrok、Zoekt 和 CGC 沿用各自返回正文的接口，返回工作量不同。

内容题在 CodeIndex 上使用符号/文档 FTS，在其他工具上使用各自正文或内容接口。内容命中单列，按功能范围解释。适配器展示的短片段另核对路径、行号和源码，声明行命中表示该摘要覆盖预期行。CGC 的适配器仅展示完整 `source` 字段的前三行，摘要没有覆盖目标行时，仍需查看完整字段。CodeIndex 的完整证据另由证据接口审计。

## 调用关系与来源证据

| 项目 | CodeIndex | CGC |
|---|---:|---:|
| CPython | 4/4 | 4/4 |
| VS Code | 2/3 | 3/3 |
| LLVM | 未测，建库失败 | 未测，建库超时 |

CodeIndex 未检出 VS Code 的 `disposeIfDisposable → isDisposable`。源码调用在 `lifecycle.ts:354`，按精确名字和文件查询也未找到调用者符号；另外两项 `combinedDisposable` 调用通过。该缺口保留在 [调用结果](results/heldout/codeindex-vscode-relations.json) 和解析诊断中。

CodeIndex 的 105 条完整证据通过 snapshot、摘要及字节切片检查。全部工具共核对 546 个返回片段，路径均存在；其中 537 个按返回行号直接匹配源码，9 个不匹配均来自 CGC 的 CPython C 函数。3 个属于符号查询，6 个属于内容查询。它们的源码从返回类型开始，而行号指向后一行函数名；全部片段均能在返回行号的前一行匹配，见 [偏移诊断](results/heldout/cgc-cpython-line-alignment-diagnostic.json)。原始不匹配记录保留，分数保持原样。

关系题共十一项：CPython 四项、VS Code 三项、LLVM 四项，均有预先核对的调用位置。CodeIndex 使用 Cscope 或 SQL 关系，CGC 使用公共调用查询接口。分数衡量这些已知调用对的检出情况，完整图的精确率需要额外负例与语义标注。OpenGrok、Zoekt 的文本引用结果独立于直接调用关系。

CodeIndex 额外核验返回证据的 snapshot 身份、blob SHA-256、输入摘要以及 UTF-8 字节切片。Zoekt 核对索引内容校验和与 Git revision，单列以 `NOT-INDEXED` 保存的正文占位文件。所有工具的返回片段都与固定输入源码核对。

## 单文件更新与恢复

下表为单次操作耗时，单位秒。CGC 的 noop 为登记检查，变化更新使用 watch；其余为各工具正常更新命令。LLVM 仅 OpenGrok 有可更新索引。

| 项目 | 工具 | 无变化 | 单文件变化 | 显式 Zoekt delta |
|---|---|---:|---:|---:|
| CPython | CodeIndex | 0.09 | 1.92 | — |
| CPython | OpenGrok | 1.71 | 1.52 | — |
| CPython | Zoekt | 0.02 | 8.53 | 0.11 |
| CPython | CGC | 4.02 | 66.53 | — |
| VS Code | CodeIndex | 0.11 | 1.32 | — |
| VS Code | OpenGrok | 2.51 | 1.85 | — |
| VS Code | Zoekt | 0.02 | 9.78 | 0.09 |
| VS Code | CGC | 5.69 | 95.46 | — |
| LLVM | OpenGrok | 13.82 | 11.94 | — |

所有变化更新均检出新探针，保留原来已命中的题目和调用；既有漏题仍按原基线记录。两次 Zoekt delta 均未回退全量。恢复后所有探针消失，原题和既有调用保持。

CodeIndex 的 CPython 对照全量构建为 28.98 秒，完整等价审计为 4.78 秒，比较 5019 个文件、148170 个符号、392843 条关系；VS Code 分别为 4.69、5.08 秒，比较 8071 个文件、39722 个符号、434643 条关系。两项均通过，包含完整 Cscope 正文、逐文件符号和父节点、SQL 关系及源码摘要。对照与审计耗时独立于更新耗时。结果见 [CPython 等价检查](results/heldout/codeindex-cpython-update-equivalence.json)、[VS Code 等价检查](results/heldout/codeindex-vscode-update-equivalence.json)。

三个项目的源码字节、修改文件 mtime、Git revision 和原索引或发布指针均恢复。CodeIndex 保留更新生成的未发布代；CGC 查询可能刷新 Redis 运行元数据。恢复报告见 [CPython](results/heldout/cpython-updates.json)、[VS Code](results/heldout/vscode-updates.json)、[LLVM](results/heldout/llvm-updates.json)。另外，旧基准 154381 个文件和新输入 171129 个文件均逐一核对了原来源及隔离副本的摘要、Git 状态和文件集合，见 [旧输入保全](results/heldout/competitors-input-preservation.json) 与 [新输入保全](results/heldout/heldout-input-preservation.json)。

各项目先做无变化更新，再在同一个源文件末尾添加唯一的无参、返回 42 的函数。CPython 修改 `Python/pylifecycle.c`，VS Code 修改 `src/vs/base/common/lifecycle.ts`，LLVM 修改 `llvm/lib/IR/LLVMContext.cpp`，随后提交隔离输入 Git。更新后检查新函数、原题和已有调用。

Zoekt 同时测默认更新与 `-delta -submodules=false`，保存回退日志。CGC 的无变化命令只检查项目登记，单文件变化使用真实 watch handler，包含全仓 import 准备、处理和持久化，计时范围从 handler 开始，文件事件投递与防抖在范围之外。

CodeIndex 更新后独立完整重建同一输入，与增量结果逐文件比对符号、父节点、SQL 关系、源码摘要和完整 Cscope 正文。对照构建与完整审计各有 1800 秒预算，耗时单列。每组实验最终恢复源码字节、mtime、Git revision、原索引或发布指针，再确认探针消失、原查询和关系保持。

## 复现与原始记录

执行顺序和参数见 [实验协议](heldout/README.md)。[汇总 JSON](results/heldout/summary.json) 由 `benchmarks/heldout/summarize.py` 从原始结果生成；[结果目录](results/heldout/) 保存全部测量 JSON、stdout、stderr、GNU time、覆盖、证据和恢复报告。首次构建使用 `<tool>-<corpus>` 前缀，重复构建使用 `repeat2-`、`repeat3-`，源码准备记录单列为 `preparation-*`。

[最终核验记录](results/heldout/final-verification.json) 汇总冻结产品与题集、工具摘要、旧生产发布指针、更新恢复、mtime、逐题稳定性及无残留测量 scope 的检查结果。诊断脚本和完整原始记录一同交付。

上一轮性能优化与消融见 [性能报告](index-performance.md)，旧项目四工具对比见 [原横向对比](index-tool-comparison.md)。本报告验证冻结后的产品在新输入上的表现。新输入上的优化前后加速倍数需要同输入的旧产品版本测量。
