# 未参与调优项目的横向对比

本轮复用 [代码索引工具对比验证 Flow](../../docs/flows/index-tool-comparison/FLOW.md)，检验 CodeIndex 0.3 的收益能否推广到 VS Code、CPython 和 LLVM。选择版本、题目和预算后冻结配置，性能结果用于检验假设，任何工具的失败和未命中均保留。

## 固定范围

| 项目 | 版本或提交 | 选择理由 |
|---|---|---|
| VS Code | 1.105.0，`03c265b1adee71ac88f833e065f7bb956b60550a` | 真实 TypeScript 应用，与 TypeScript 编译器仓库的测试数据分布不同 |
| CPython | 3.14.0，`ebf955df7a89ed0c7968f79faec1de49f61ed7cb` | C 解释器、Python 标准库与测试组成的混合项目 |
| LLVM | 21.1.0，`3623fe661ae35c6c80ac221f14d85be76aa870f1`，完整 llvm-project 官方源码包 | 大型 C++ 工程，包含编译器子项目和测试 |

源码从固定提交的归档提取，记录压缩包 SHA-256，并创建只有一次提交的本地来源仓库。来源 Git revision 为本地快照身份，上游身份由上表提交和归档摘要共同标识。已有 LLVM 压缩包未通过 gzip 完整性检查，原文件保留。固定提交的 codeload 下载速度较慢且不支持断点续传，开测前改为官方 21.1.0 完整源码发行包，通过八段范围请求下载，并通过 xz 完整性检查和源码版本核对。

全部工具使用同一份扫描器选出的文本文件，单文件最多 5 MiB。逐文件冻结清单，隔离 Git 副本通过 `.git/info/attributes` 关闭换行、编码和过滤器转换，并核对每个 Git blob 与工作树原始字节的 SHA-1，防止 Git 后端读取不同内容。原仓库的 `.gitattributes` 保持原样。文件清单摘要、语言分布及扫描排除项随结果保存。

CodeIndex 产品代码固定为 `362cbce6e00f7f13018bbecd91ab72f2e051ed9c`。其他工具沿用上轮版本：OpenGrok 1.14.20、Zoekt `572f5e4a3a37532300298e2ba38513c15b2e0319`、CodeGraphContext 0.6.13/FalkorDB Lite；共享 Ctags 5.9，CodeIndex 使用 Cscope 15.9。CGC `INDEX_SOURCE=true`、`SCIP_INDEXER=false`、`ENABLE_AUTO_WATCH=false`。下载、安装和输入准备在正式计时之前完成。

## 测量与验收

- 所有被测命令及后代统一 `MemoryMax=12G`、`MemorySwapMax=0`，全部串行执行。运行器使用文件锁防止并发启动测量阶段。
- 全量预算 1800 秒，更新、查询和审计预算 300 秒。各工具保留自身默认限制，包括 CodeIndex 原生构建默认 180 秒。超时、OOM 或其他失败单列，完整构建失败的组合不继续查询、更新或重复建库。
- 建库和符号查询均完成的组合做三次全新建库，每次预读源码及 Git 文件，按轮换后的工具顺序执行。保留三次原始时间、CPU、内存、体积和查询结果，汇总中位数及范围。主索引用于后续验收，重复索引在记录完成后清理，以控制磁盘占用。
- 每个项目预先固定八个符号定位题、两个内容检索题和少量直接调用。符号题以预期路径进入前十个不同文件为共同指标，同时记录是否返回预先确认的声明行。内容题另列，CodeIndex 使用其符号/文档 FTS，其他工具使用正文或内容查询接口，具体功能范围分别解释。
- 每题记录首次查询及后续二十次查询。首次查询共享进程，属于首次调用，不代表冷盘。CodeIndex 计时采用 metadata-only，证据另计；其他工具返回内容沿用各自公共接口。
- 逐项审计文件覆盖、定义存在、正文占位或缺失、源码片段、摘要与证据范围。直接调用仅比较 CodeIndex 与 CGC，全文引用命中不算调用关系。
- 更新先测无变化，再在相同文件末尾添加唯一的无参、返回 42 的函数并提交隔离副本。检查新函数、原题以及已有调用。Zoekt 测默认更新和 `-delta -submodules=false`；CGC 无变化是登记检查，变化测试调用实际 watch handler，含全仓 import 准备和保存，排除文件事件投递与防抖。
- CodeIndex 的增量结果另与相同更新输入的独立完整重建对照，检查所有文件的符号、父节点、SQL 关系、源码摘要及完整 Cscope 正文。对照构建与等价审计预算各 1800 秒，耗时单列。
- 每次更新后恢复源码、mtime、Git revision 和原索引/发布指针，检查探针消失、原查询和关系保持。恢复失败保留备份及恢复记录，阻止后续继续。

## 执行

在 CodeIndex 根目录执行。`--data` 必须为本轮独立数据目录，复现时使用新的目录，避免覆盖已有数据。环境和题集均应先保存并提交。

```bash
node benchmarks/competitors/prepare-inputs.mjs \
  /path/to/heldout/sources.json /path/to/heldout/inputs

python3 benchmarks/heldout/run-builds.py \
  --data /path/to/heldout --tools /path/to/benchmark-tools
python3 benchmarks/heldout/run-audits.py \
  --data /path/to/heldout --tools /path/to/benchmark-tools
python3 benchmarks/heldout/run-updates.py \
  --data /path/to/heldout --tools /path/to/benchmark-tools
```

各运行器支持 `--corpora`、`--tool-names` 和 `--results`。重复建库默认三次，可用 `--repetitions` 调整；正式结论采用预先约定的三次。已存在的测量保留，失败组合不会被重新解释为成功。修复测量器时，应先归档受影响记录，并说明最小补测范围。

查询和审计适配器复用 [competitors](../competitors/README.md)，原始结果写入 `benchmarks/results/heldout`，旧轮次结果保持原样。更新恢复信息位于数据目录的 `update-backups` 及结果目录的 `*-updates.json`。最终汇总分别评价速度、资源、覆盖、证据和更新，功能范围不同的工具按具体负载比较。
