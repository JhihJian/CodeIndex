# Linux 三分钟索引方案实验

本文记录独立原型。方案现已接入正式命令，生产实现的性能和回归记录见 [linux-native.md](linux-native.md)。

在与流式基线相同的 Linux v6.12 工作区上，Ctags + 紧凑 SQLite + Cscope 组合原型从启动到发布耗时 **116.84 秒**，低于 180 秒。该结果覆盖符号检索、源码快照，以及 C/C++ 调用者和被调用函数查询。原型与正式 CodeIndex 的完整关系模型、导航摘要和导出产物采用不同的实现与验收范围。

## 测试条件

- 固定 Git 提交：`e81dbc9fe6c78c547c2ce7a3354b52479b26edd9`。
- 扫描 86,363 个文本文件，共 1,212,793,499 字节，与流式基线使用同一文件集合；其中 C/C++ 输入文件为 59,746 个。
- Ryzen 7 255、16 个逻辑 CPU、约 19.3 GiB 内存，Node.js 24.13.1。
- Universal Ctags 5.9.0，Ubuntu 软件包 `5.9.20210829.0-1`；Cscope 15.9，软件包 `15.9-2`。
- 使用全新输出目录，从源码重新生成索引，未复用解析缓存。操作系统文件缓存已预热，未进行冷盘测量。
- 每个方案完成一次全量测量。结果是本机原型实验，后续验收还需重复运行和扩展覆盖测试。

## 实测结果

| 方案 | 墙钟时间 | 包含内容 |
| --- | ---: | --- |
| 既有 CodeIndex 流式版本 | 1,930.66 s | 现有符号、关系、导航、SQLite、源码和 JSONL 产物 |
| Ctags 单独提取 | 33.96 s | 原始 tags 输出 |
| Ctags 符号索引原型 | 62.44 s | 扫描、源码保存、tags 入库、SQLite/FTS、证据核验、发布 |
| Cscope 单独构建 | 52.63 s | C/C++ 交叉引用和倒排索引 |
| **Ctags + SQLite + Cscope 组合原型** | **116.84 s** | 符号索引原型的全部步骤，加交叉引用、调用查询核验和发布 |

组合耗时来自一次完整命令运行，独立步骤的耗时仅用于辅助理解。

组合原型提取 6,106,709 条 tags，包括宏、函数、声明、变量、成员、枚举值等。不同解析器的分类和识别规则不同，tags 数量应与原 CodeIndex 的 4,616,281 个符号分别解读。

SQLite 数据库为 836,956,160 字节，含源码和 Cscope 的完整原型快照共 4,117,027,275 字节，约 3.83 GiB。GNU time 报告最大 RSS 为 2,534,564 KiB，约 2.42 GiB，主 Node 进程最大 RSS 约 403 MiB。GNU time 的数值包含子进程资源记录，不能作为所有进程同时占用内存的总峰值。

## 组合阶段耗时

| 阶段 | 耗时 |
| --- | ---: |
| 文件扫描与摘要 | 6.65 s |
| Ctags 符号提取 | 29.55 s |
| 保存源码与文件元数据 | 4.59 s |
| tags 逐行入库 | 11.28 s |
| SQLite 索引与 FTS | 10.34 s |
| Cscope 交叉引用与倒排索引 | 54.16 s |
| 符号和调用证据核验 | 0.14 s |

Ctags、SQLite 和 Cscope 顺序执行。该原型通过成熟的原生解析工具和精简的存储结构达到当前耗时，尚未采用并行解析池。

## 核验范围

四个目标函数均通过 SQLite 精确检索与 FTS 检索，结束行存在，源码范围有效，保存的源码 blob 与 digest 一致：

- `fs/exec.c::do_execveat_common`
- `net/ipv4/tcp_ipv4.c::tcp_v4_syn_recv_sock`
- `fs/open.c::vfs_open`
- `kernel/sched/fair.c::pick_next_task_fair`

每个函数还执行了 Cscope 的调用者和被调用函数查询，共八组。每条返回记录检查了文件属于已索引集合、行号处于快照源码范围，以及源码 digest。结果如下：

| 函数 | 被调用函数记录 | 调用者记录 |
| --- | ---: | ---: |
| `do_execveat_common` | 19 | 4 |
| `tcp_v4_syn_recv_sock` | 49 | 1 |
| `vfs_open` | 2 | 5 |
| `pick_next_task_fair` | 15 | 2 |

八次查询单次耗时为 11.1–13.0 ms，包含 Cscope 命令进程启动。此前正式版本报告使用预热后的重复测量中位数，两者测量方法不同。快照目录原子发布后，另外验证了 `vfs_open` 调用者查询仍能返回 `fs/namei.c`。

四个函数的被调用记录数与此前 Tree-sitter 样本一致。这些检查证明所测功能可用，完整语义等价性仍需更多样本验证。

## 方案选择

| 路线 | 当前证据 | 能力边界 |
| --- | --- | --- |
| Ctags + Cscope + SQLite | 本机组合原型 116.84 秒 | 快速符号与 C/C++ 交叉引用；现有自然语言导航、关系类型和跨语言行为需要逐项接入与回归 |
| 原生并行 Tree-sitter 提取器 + 紧凑存储 | 可保持现有解析路线，180 秒目标尚待实测 | 要重写遍历、调度和存储关键路径；Tree-sitter 本身已经是原生解析器 |
| Clang/SCIP 编译语义索引 | 本轮未测量 | 适用于需要类型消歧与编译语义的场景，需准备对应编译配置，暂不作为三分钟目标的首选 |

建议优先评估第一条路线作为 Linux/C 仓库的快速后端，保留源码证据和常用调用查询。生产接入前需要验证跨目录同名符号、宏、函数指针、条件编译、C++ 重载与继承，以及 Python/JS/TS 原有行为。原型中的 Cscope 只针对 C/C++ 构建交叉引用，其他语言关系尚未接入。

正式版本现有的逐节点导航摘要、显式父子节点、统一 SQL 关系表、关系置信度以及全量 JSONL 审计导出均不属于本次原型交付范围。若这些产物必须在 180 秒内全部具备，需要单独计入下一轮端到端验收。JSONL 可以设计成显式按需导出，但应明确这一行为调整。

当前正式 `index/query/update` 命令保持原有实现，原型仅作为可复现的替代方案实验。

## 复现

将工具安装到独立目录后，运行：

```bash
node --max-old-space-size=2048 benchmarks/ctags-prototype.mjs \
  /data/dev/bench-repos/linux-benchmark \
  /tmp/codeindex-fast-fresh \
  /path/to/ctags-universal \
  /path/to/cscope
```

省略最后一个参数时只构建符号索引。输出目录应为全新目录。Cscope 内部调用系统 `env` 和 `sort`，原型显式使用 `/usr/bin:/bin`，并检查 `.in` 和 `.po` 倒排索引存在；仅检查进程退出码不足以判断其构建成功。实验发现本机自定义 `env` 会使 Cscope 的倒排索引静默降级，标准工具路径下已成功重测。

原始记录包括：

- [`linux-ctags-symbol-prototype.json`](results/linux-ctags-symbol-prototype.json)
- [`linux-ctags-cscope-prototype.json`](results/linux-ctags-cscope-prototype.json)
- [`linux-ctags-cscope-prototype.time`](results/linux-ctags-cscope-prototype.time)
- [`linux-ctags-cscope-prototype.progress.stderr`](results/linux-ctags-cscope-prototype.progress.stderr)
- [`linux-fast-prototype-environment.json`](results/linux-fast-prototype-environment.json)
