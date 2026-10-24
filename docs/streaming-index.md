# 流式索引构建（历史版本）

本文对应 `190b85e` / `c142e61` 的 Tree-sitter 流式实现。当前版本的构建、更新和导出方式见 [原生索引运行说明](native-index.md)。

CodeIndex 将解析结果逐文件写入临时 SQLite，再通过数据库关联生成包含树、关系和导航。内存中保留文件清单与当前解析批次，符号和关系总量由磁盘承载。

## 执行方式

```bash
node --max-old-space-size=2048 bin/codeindex.js index \
  --repo /path/to/repository --store .data/repository --progress --json

node --max-old-space-size=2048 bin/codeindex.js update \
  --repo /path/to/repository --store .data/repository --progress --json
```

`--progress` 将扫描、解析入库、父子关系、包含树、关系解析、导航、数据库索引、校验和导出进度写入 stderr。stdout 保留最终 JSON。`stats.buildMs` 包含解析、数据库构建、校验和 JSONL 导出时间。`stats.stages` 记录阶段耗时。

`--max-old-space-size` 设置 V8 老生代堆上限。进程 RSS 还包括年轻代堆、SQLite 缓存、Buffer 和原生解析器内存，主进程与解析子进程的总内存需另行测量。

## 数据处理

1. 扫描仓库，保留路径、语言、大小和 digest 等文件元数据。
2. Python 和 C/C++ 解析按最多 64 个文件或累计 4 MiB 源码分批执行。超过 4 MiB 的单个文件独立处理，仍受扫描文件大小上限限制。
3. 每个文件的源码 blob、符号、原始关系和解析缓存写入磁盘，完成后释放该批对象。SQLite 每 256 个文件提交一次事务。
4. 标准符号键索引负责父符号定位，按文件名、符号名和限定名建立唯一候选表。SQLite 在磁盘临时表中解析关系，未确定目标保留为 `unresolved`。
5. 导航按稳定顺序选择前 12 个子节点生成摘要，逐行写入导航和 FTS5。增量和全量构建使用相同排序。
6. 校验源码 digest、符号范围和关系端点，逐行导出 JSONL，最后原子切换发布指针。普通异常会清理该次构建的临时目录，SIGKILL 等强制终止可能留下未发布目录。

SQLite 构建使用独立的 `.build-*` 目录，临时库采用 DELETE journal 与 `synchronous=OFF`，优先批量写入性能。该目录在校验完成前不参与查询。此设置保证进程级发布隔离，不提供整机断电时的持久化保证。

增量构建先比较文件 digest，再逐行读取旧 `parsed.jsonl`，复用未变化文件的解析结果。删除文件不会进入新快照。关系和导航基于当前全部文件重新计算。Git revision、工作区状态与构建配置一致时，直接返回已发布 manifest。

快照身份包含源码清单摘要、索引 schema、解析器版本和文件大小限制。解析器或 schema 升级会生成新的快照，旧快照仍可读取。

## 回归验证

```bash
npm run check
npm test
node --max-old-space-size=128 benchmarks/streaming-memory.mjs
```

低内存脚本创建 500 个 Python 文件、100,000 个函数和 99,500 条调用关系，验证全量构建、单文件更新、499 个文件解析复用，以及新符号可查询。脚本在退出时清理测试数据。该脚本用于资源回归测试，真实项目吞吐量另行测量。

本机实测全量 13.704 s，单文件更新 8.072 s，最大 RSS 402.3 MiB。命令设置的老生代上限为 128 MiB，V8 报告的总堆上限为 320 MiB。原始结果见 [`streaming-memory.json`](../benchmarks/results/streaming-memory.json)。

Linux 全量快照可用以下命令核验，`--update` 会临时为 `fs/open.c` 追加注释、测量单文件增量，并在结束时恢复原文件和发布指针：

```bash
node --max-old-space-size=2048 benchmarks/verify-linux-streaming.mjs .data/linux-stream-v5 --update
```

该脚本检查四个目标函数的源码证据与 digest、字节范围、调用关系端点，以及元数据查询的读取边界。

测试还覆盖 UTF-8 跨块读取、消费者异常传播、构建失败后旧快照可用、数据库文件丢失后的重建恢复、全量与增量快照及导航一致性、相对导入，以及 C 类型引用不会重复生成定义符号。全部 12 项测试已在 Node.js 22.16.0 和 24.13.1 上通过，最低版本运行记录见 [`node-22.16-tests.stdout`](../benchmarks/results/node-22.16-tests.stdout)。

C 解析器仅将带定义体的 struct、union、enum、class 计为类型定义。旧版将类型引用也计为符号，因此前后符号总数需要结合提取范围解读。
