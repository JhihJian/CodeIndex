# 竞品实测与复现

结果见 [代码索引工具对比](../index-tool-comparison.md)，原始命令、标准输出、错误输出和资源记录见 [results/competitors](../results/competitors/)。脚本从隔离的源码副本建库，不修改原仓库。

## 固定环境

- CodeIndex：`9222f7efca28db10c90f06becd5799196d433e27`，Node.js 24.13.1。
- CodeGraphContext：0.6.13，Python 3.12，默认 FalkorDB Lite。依赖锁定清单为 [cgc-dependencies.txt](../results/competitors/cgc-dependencies.txt)。`SCIP_INDEXER=false`、`ENABLE_AUTO_WATCH=false`，默认 `INDEX_SOURCE=true`。
- OpenGrok：1.14.20，Java 21，索引进程 `-Xmx8g`，启用默认 xref 生成。
- Zoekt：`572f5e4a3a37532300298e2ba38513c15b2e0319`，Go 1.27.3。使用 `zoekt-git-index`，默认并行度 4，文件上限显式设为 5 MiB，要求 Ctags。
- 共享 Universal Ctags 5.9.0；CodeIndex 另用 Cscope 15.9。可通过 `CODEINDEX_CTAGS` 指定 Ctags 可执行文件。
- Linux 主机需要 GNU time、支持内存限制的 systemd 用户 scope、Git 和 `cp --reflink=auto`。完整环境见 [environment.json](../results/competitors/environment.json)。

安装、下载、编译、语法包首次下载均在正式测量前完成。OpenGrok 发行包 SHA-256 为 `f33d78f950ba7ed974caa9153120e4f26f9c7f4d63c1f48b7a0350e12d8e346d`。本轮工具目录为 `/data/dev/benchmark-tools`，包含 `cgc-venv`、`opengrok-1.14.20`、Zoekt 源码及编译后的二进制。

可使用独立虚拟环境安装锁定的 CGC 依赖：

```bash
uv venv --python 3.12 /data/dev/benchmark-tools/cgc-venv
uv pip install --python /data/dev/benchmark-tools/cgc-venv/bin/python -r benchmarks/results/competitors/cgc-dependencies.txt
```

先用小仓库完成各工具的建库与查询烟测，并确保 `tree-sitter-language-pack` 所需语法包已缓存。Zoekt 在本机 Git 版本不支持其 `cat-file --filter` 用法时自动回退 go-git，本轮采用该正常回退路径。

## 编译查询与审计适配器

在 CodeIndex 工作目录执行 Java 编译：

```bash
javac -cp '/data/dev/benchmark-tools/opengrok-1.14.20/lib/*' \
  -d /data/dev/benchmark-tools benchmarks/competitors/OpenGrokQuery.java benchmarks/competitors/OpenGrokAudit.java
```

在上述固定提交的 Zoekt 源码目录中执行 Go 编译：

```bash
go build -o /data/dev/benchmark-tools/zoekt-git-index ./cmd/zoekt-git-index
go build -o /data/dev/benchmark-tools/zoekt-query /data/dev/CodeIndex/benchmarks/competitors/zoekt-query.go
go build -o /data/dev/benchmark-tools/zoekt-audit /data/dev/CodeIndex/benchmarks/competitors/zoekt-audit.go
```

## 输入与运行顺序

`prepare-inputs.mjs` 接受如下 JSON 配置。源目录需要预先检出指定版本，具体版本和文件清单摘要见 [inputs.json](../results/competitors/inputs.json)。

```json
[
  {"name":"pageindex","source":"/data/github/PageIndex"},
  {"name":"typescript","source":"/data/dev/bench-repos/typescript-benchmark"},
  {"name":"linux","source":"/data/dev/bench-repos/linux-benchmark"}
]
```

脚本使用 CodeIndex 扫描器选出最多 5 MiB 的文本文件，逐文件复制并校验摘要，再创建只有一个初始提交的独立 Git 仓库。所有工具接收同一份文件集合，各自保留原有语言支持和忽略规则。本轮 PageIndex 输入含本地未跟踪的 `docs/codeindex-architecture.md`（22,456 字节，SHA-256 `9b7f350c40c12051d4a8d10c3b9bd090d64350ff601cef411b5c7b58a2b75e1f`），精确输入由上游提交与该额外文件共同组成。精确复跑应使用保留的输入副本或匹配文件清单摘要的输入。Linux 来自 v6.12 源码包，其 SHA-256 为 `b1a2562be56e42afb3f8489d4c2a7ac472ac23098f1ef1c1e40da601f54625eb`，另含基准工作区的 `.code-review-graph/.gitignore`。

```bash
node benchmarks/competitors/prepare-inputs.mjs .data/competitors/sources.json .data/competitors/inputs
python3 benchmarks/competitors/run-builds.py --tools /data/dev/benchmark-tools
python3 benchmarks/competitors/run-audits.py --tools /data/dev/benchmark-tools
python3 benchmarks/competitors/run-updates.py --tools /data/dev/benchmark-tools
python3 benchmarks/competitors/run-delta-updates.py --tools /data/dev/benchmark-tools
node benchmarks/competitors/verify-inputs.mjs
python3 benchmarks/competitors/summarize.py
```

脚本保留已有测量。重新测量时应使用独立工作副本，将已有 `.data/competitors` 和 `benchmarks/results/competitors` 归档后，从空输出目录开始。已有结果目录中的环境和依赖清单应先保留。构建脚本可用 `--corpora`、`--tool-names` 选择未测组合。

## 测量与验收口径

全量建库串行执行，每次最多 1,800 秒、12 GiB、禁用 swap。构建前预读源码和 Git 对象，使用新索引目录。CGC 的 PageIndex 记录紧接安装烟测，文件缓存已被访问，但未通过其余组合的显式预读循环。这里的结果属于文件缓存预热条件。

GNU time 记录被测命令的完整墙钟时间与最大 RSS。测量器另采样同时存活的后代进程 RSS 总和、可读取的 cgroup `memory.peak`，并记录含监督进程的墙钟时间。RSS 相加可能重复共享页，短进程或末尾峰值可能落在 0.25 秒采样间隔内，cgroup 还计入文件缓存。缺失值保留为 null。早期短操作的进程树采样有时只采到启动器，主报告因此采用 GNU time RSS；后续测量新增 `workloadSampled`，确认未采到被测进程时将该项置 null。OOM 使用 systemd 的 `Result=oom-kill` 确认，失败或超时后清理该 scope 剩余进程。

查询分别调用 CodeIndex `queryIndex`、OpenGrok `SearchEngine`、Zoekt directory searcher、CGC `CodeFinder`。每题在一个已打开索引的进程中执行一次首次查询、20 次后续查询。`coldMs` 字段实际表示该题首次查询，后面的题共享进程缓存。它不表示冷盘或独立进程冷启动。公共命中指标为前 10 个不同文件中包含目标路径；CodeIndex 测 metadata-only，源码证据另计时，其他适配器各自返回的字段范围见源码。

覆盖审计逐项对照输入清单。CodeIndex 校验快照、SHA-256 和源码字节范围；Zoekt 校验工作树 SHA-256 与固定清单一致、索引 Git 版本与输入提交一致，再校验 CRC64-ISO，并单列 `NOT-INDEXED` 占位文件；OpenGrok 去重实际路径，额外用路径限定查询区分排序失误和定义缺失。关系样例的人工核对位置在 [relation-cases.json](relation-cases.json)，只覆盖少量直接调用。

更新测试每次最多 300 秒，先测试无变化输入，再在同一个文件追加一个唯一函数并提交隔离 Git 副本。新函数和原问题集均在更新后查询。Zoekt 分别测默认模式和显式 `-delta`。本轮仅加 `-delta` 会因默认子模块索引而回退全量，`run-delta-updates.py` 复用相同变更提交，补测 `-delta -submodules=false` 并检查回退日志。CGC 重复 `index` 只用于观察已登记仓库行为；单文件实验准备全仓库导入映射后，直接调用实际 watch 的同步处理函数，分别记录准备和处理时间。完整墙钟时间包含进程启动、导入准备及数据库保存，排除文件事件投递和默认两秒防抖。CGC 的 CLI `update` 是删除仓库图后重建，与该 watch 实验不同。

更新前复制原索引。结束时恢复输入提交、OpenGrok/Zoekt/CGC 原产物和 CodeIndex 发布指针；CodeIndex 新生成的不可变历史快照可保留。恢复信息在操作期间写入 `.data/competitors/update-backups/<corpus>/`，正常恢复后再次查询：确认新函数消失、原题命中保持，并检查 CodeIndex/CGC 的已有调用样例。恢复验证通过后清理备份。新函数仅存在于已记录的临时提交和更新查询记录中。
