# 解析可靠性验收运行器

本目录验收 CodeIndex 0.4 的解析隔离、正文覆盖、查询证据和增量完整等价。结果与解释见 [验收报告](../parser-reliability.md)。产品固定为 `dec7a41`，最终结果在 `benchmarks/results/reliability`，修复前记录在 `reliability-pre-review`。

## 输入与边界

使用 [heldout 题集和输入清单](../heldout/README.md)，将冻结输入复制到独立的 `DATA/inputs`。`DATA` 的目录名固定为 `reliability`。复制使用 `cp -a --reflink=auto`，保留 Git 和 mtime，文件 inode 与旧输入独立。更新运行器拒绝符号链接输入路径、共享 inode 的待写文件，以及数据目录外的 store。

原 heldout 更新运行器直接修改其指定副本；本轮使用本目录的运行器。旧输入、旧结果和生产指针保持只读。所有测试、建库、审计和更新通过 `benchmarks/competitors/measure.py` 限制整棵进程树为 12 GiB、禁 swap，逐个运行。`Study` 锁同一 DATA 目录，测量结束检查后代清理。

## 执行

```bash
# DATA 指向新建的独立 reliability 目录，TOOLS 为既有工具目录
python3 benchmarks/heldout/run-builds.py \
  --data "$DATA" --tools "$TOOLS" \
  --results benchmarks/results/reliability --tool-names codeindex

# 每个 corpus 为 cpython、vscode 或 llvm
python3 benchmarks/competitors/measure.py \
  --output "benchmarks/results/reliability/$corpus-audit" \
  --memory-gib 12 --seconds 1800 -- \
  node benchmarks/reliability/audit.mjs \
  "$DATA/indexes/codeindex/$corpus" "$corpus" "$DATA/inputs/$corpus.files.json"

python3 benchmarks/competitors/measure.py \
  --output "benchmarks/results/reliability/$corpus-relations" \
  --memory-gib 12 --seconds 300 -- \
  node benchmarks/competitors/codeindex-relations.mjs \
  "$DATA/indexes/codeindex/$corpus" "$corpus" benchmarks/heldout/relation-cases.json

python3 benchmarks/reliability/run-updates.py \
  --data "$DATA" --tools "$TOOLS" \
  --results benchmarks/results/reliability --tool-names codeindex
```

更新过程保存源码原文、revision、mtime 和发布指针，新增一个函数、一个 helper 调用和正文短语，测量更新后与全量 oracle 比较。`finally` 恢复原输入和指针，核验探针消失。失败报告和恢复备份保留，重新运行前先检查恢复状态；已存在的测量记录按名称复用。

`audit.mjs` 检查每个文件的 FTS 正文摘要、逐题命中、目标行覆盖和每条返回证据的字节内容。文件命中与声明行命中分别统计。`run-updates.py` 要求更新保持已有命中，已有 LLVM C++ 能力缺口仍按原值报告。

`equivalence.mjs` 逐文件比较公共身份、字节数、行布局、解析状态、完整 FTS 正文、符号父节点和 SQL 关系，验证源码 blob 与 tree 摘要。原生部分流式比较整份 Cscope 正文、路径映射、倒排字典和每条 posting。

Cscope 15.9 的 posting 含主库绝对字节偏移。全量 oracle 放在 `oracles/codeindex`，增量库放在等长的 `indexes/codeindex`，校验器要求主库头部字节数相同。posting 比较使用本轮 x86-64 ABI 的 24 字节布局，忽略末尾 4 个未初始化填充字节，其他 20 字节完整参与 SHA-256。字典比较覆盖 PARAM、块指针、每项 term、posting 数量与位置、superindex，跳过结构填充及未使用块空间。这些格式假设仅属于本机基准校验器。

`recheck-equivalence.py` 为早期验收结果补充完整文件布局与附属索引比较。它使用保存的更新 revision 和未发布增量快照重建 oracle，结束后再次恢复输入。最终严格结果保存在 CPython 的 `*-strict-equivalence.json`、VS Code/LLVM 的 `*-final-equivalence.json` 和三项目的 `*-strict-result.json`。`verify-final.py` 完成独立 PageIndex 副本回归、旧两组输入保全、新副本恢复状态、生产指针和历史结果检查，并记录环境。`summarize.py` 读取原始结果并要求有效测试、严格等价及恢复全部通过。

## 测试与原始记录

Node 24.13.1 和 Node 22.23.2 分别执行完整 122 项测试。使用明确的 Node 可执行路径；需要设置 PATH 时使用 `/usr/bin/env`。有效记录为 `checks/node24.*`、`checks/node22-verified.*`，并同时核验退出状态和实际测试数量。

首次 Node 22 命令命中了本机名为 `env` 的环境设置脚本，记录为零秒成功但未执行测试，原记录保留。LLVM 的首次附属索引比较在生成巨大 Buffer 差异信息时耗尽 V8 堆；输入与发布指针已恢复，校验器改用流式摘要及等长头部后进行严格复验。上述记录均由最终汇总显式标记为无效或已被替代。
