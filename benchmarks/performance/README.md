# 性能迭代复现

本目录测量 CodeIndex 在固定 PageIndex、TypeScript、Linux 输入上的全量、查询、无变化和单文件更新，结果见 [性能报告](../index-performance.md)。Linux 规模的命令及全部后代统一置于 12 GiB、禁 swap 的 systemd scope。各测量串行执行，运行期间保持其他性能任务停止。

## 前置条件

使用支持用户级 systemd scope 和 cgroup v2 的 Linux，安装 Node `^22.16.0 || >=24.0.0`、Python 3、GNU time、Universal Ctags 和 Cscope 15.9，并运行 `npm ci`。工具选择和安全边界见 [原生运行说明](../../docs/native-index.md)。

固定输入、清单和旧版索引沿用 [竞品复现步骤](../competitors/README.md)。同一输入目录同时供基线和优化实现使用，保持绝对路径和内容一致。基线结果的 `environment.json` 保存真实被测版本；仓库 HEAD 单独记录为 `baselineArtifactCheckout`。本次为被测代码 `9222f7e`、资料版本 `7904b7d`、优化代码 `b42ddc4`，宏尾部和跨行字符串引用修复及 Linux 最终复测代码为 `413a915`。

## 正式测量

以下命令在 CodeIndex 根目录执行，示例假定基线资料和 `.data/competitors` 位于当前仓库。输出目录必须全新，已有 `environment.json` 或非空 store 会触发拒绝。

```bash
python3 benchmarks/performance/run.py \
  --baseline-root "$PWD" \
  --inputs "$PWD/.data/competitors/inputs" \
  --store-root "$PWD/.data/performance-reproduction" \
  --results benchmarks/results/performance/reproduction
```

脚本核对逐文件摘要及 Git 跟踪集合，预读源码和 Git 文件，然后运行全量、查询、覆盖/证据审计、全量等价比较、无变化更新、单文件探针更新及恢复检查。全量时间包含校验和发布，独立审计单独记录。

每个被测命令通过 `benchmarks/competitors/measure.py` 执行，设置 `MemoryMax=12G`、`MemorySwapMax=0`。构建和审计默认超时 1800 秒，更新 300 秒。正式构建清除 `NODE_OPTIONS`，使用 Node 自动堆设置和 worker 的 256 MiB 老生代请求。等价审计单进程采用 2048 MiB old-space。RSS、采样进程树 RSS 和 cgroup peak 分开记录。

每次更新前保存原 revision、文件摘要和发布指针。正常退出及可处理异常均恢复输入与指针，并核验探针消失。若测量 scope 仍有后代，脚本保留恢复记录并拒绝并发恢复。外部强制杀死 runner 后，可根据 `*-update-verification.json` 中的 `originalRevision`、`pointer` 和 `originalPointer` 恢复，但应先确认对应 scope 已退出。

## 单 worker 消融

```bash
python3 benchmarks/performance/run.py \
  --baseline-root "$PWD" \
  --inputs "$PWD/.data/competitors/inputs" \
  --store-root "$PWD/.data/performance-serial-reproduction" \
  --results benchmarks/results/performance/serial-reproduction \
  --corpora typescript --workers 1 --build-only
```

该模式保留查询和证据审计，省去完整事实等价及更新流程。用于观察并行度对耗时和内存的影响。正式轮的全量事实审计及单元测试另行覆盖结果一致性。

## 更新快照等价审计

更新后恢复发布指针时保留新快照。以下命令按 snapshotId 找到基线与优化版本的同内容更新快照，临时生成只改变探针文件摘要的清单，并只读比对。结果目录必须全新。

```bash
python3 benchmarks/competitors/measure.py \
  --output benchmarks/results/performance/update-audit-reproduction \
  --memory-gib 12 --seconds 600 -- \
  python3 benchmarks/performance/audit-updates.py \
    --baseline-stores "$PWD/.data/competitors/codeindex" \
    --optimized-stores "$PWD/.data/performance-reproduction" \
    --inputs "$PWD/.data/competitors/inputs" \
    --run-results benchmarks/results/performance/reproduction \
    --results benchmarks/results/performance/update-audit-reproduction-results
```

该审计可用 `--corpora linux` 单独检查 Linux 修复复测，届时将 store 和 run-results 指向相应目录。`summarize.py` 汇总本次已归档的目录布局，执行命令为：

```bash
python3 benchmarks/performance/summarize.py
```

`equivalence.mjs` 同时接受 store 目录和直接快照目录。对每个文件比较符号字段/父级身份、SQL 关系/来源身份，并验证源码 blob 和 tree 摘要。原生内容另行校验，具体检查口径见报告。

## 记录与解释

`*.json` 保存资源及验证结果，`*.stdout`、`*.stderr`、`*.time` 保存原始输出。`storage.json` 对发布快照按 inode 去重，包含 SQLite、源码与 native 产物。`summary.json` 汇总正式轮、基线及单 worker 结果。

`initial` 与 `round-2` 保留实验历史。PageIndex、TypeScript 使用 `final`，Linux 使用修复宏尾部及跨行字符串引用后的 `final-linux`；`summarize.py` 按此选择结果。首轮全局 old-space 覆盖了 worker 的请求值，且探针签名不同；第二轮已校正这些条件，保留分片拼接；第三轮直接消费 Ctags 分片。补充更新审计发现 Cscope 15.9 的宏尾部作用域及跨行字符串问题后，对这类文件强制重新解析，并再次执行 Linux 全量、更新和完整等价审计。失败记录及修复前后的最小回归均保留。原始日志中的绝对路径和目录名对应各轮执行时的工作目录。

完成后运行 `node benchmarks/competitors/verify-inputs.mjs` 核验全部固定输入与原始来源，并检查发布指针恢复记录。命令会更新历史 `input-verification.json`，正常情况下其内容保持一致。
