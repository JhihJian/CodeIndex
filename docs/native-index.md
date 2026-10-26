# 原生索引运行说明

CodeIndex 0.4 使用紧凑 SQLite 保存完整正文、符号与轻量关系，并通过 Cscope 查询 C/C++ 交叉引用。扫描并冻结源码后，符号构建与 Cscope 并行执行，全部任务结束并通过校验后原子发布。

## 构建与发布

`index` 总是完整构建。扫描器为纳入范围的文本文件计算摘要，构建器将内容保存到 `source/<sha256>`，并为原生工具生成 `tree/<仓库相对路径>`。`tree` 与已保存的 blob 使用硬链接，活跃工作区文件独立保存。复制时发现内容与扫描摘要不同，构建立即失败。

Ctags 每批最多 256 文件或 8 MiB，大文件独占，结果按输入顺序逐行写入 SQLite。Python 使用 CPython 3.14+，每文件缓存行布局，由异步子进程解析。JS/TS 使用锁定的 TypeScript 5.9.3 语法 AST。两类脚本分别以最多 64 文件或 4 MiB 为一批，大文件独占，Python 池结束后才启动 JS/TS 池。JS/TS worker 请求的老生代上限为 256 MiB，Node 全局 `--max-old-space-size` / `NODE_OPTIONS` 可覆盖此设置；严格内存预算仍由 cgroup 执行。完成结果按稳定批次顺序消费，SQLite 保持单写入者。正文在冻结源码阶段写入独立 FTS5 表，构建末尾检查正文覆盖与 FTS 完整性，建立符号与路径 FTS、B-tree，并等待 Cscope 数据库、倒排索引和文件映射校验完成。发布前检查符号范围与外键。

语法错误按文件标记 `partial`。Ctags 与 Python 子进程只有明确的 SIGSEGV 才拆分失败批次，丢弃失败输出，单文件崩溃还须通过已知正常输入探针，额外尝试最多 128 次且共享总时间预算。Ctags 失败文件保留源码和 Cscope 输入。启动、普通非零退出、内存、超时、取消、协议损坏和存储错误会终止构建。目录或文件读取失败同样终止，避免增量将读失败当成删除。

快照目录使用内容身份加独立的生成标识。`published.json` 通过原子替换切换目录，已有查询继续使用原目录。失败构建清理临时目录，保留原发布指针。内容、解析器版本、数据库格式、文件大小限制、TypeScript 版本、Python 可执行路径与版本和原生工具版本共同参与快照身份。

## 更新成本

`update` 比较文件摘要，克隆旧数据库，只删除和重提取变化、删除文件的记录。FTS 触发器维护增量索引，未变化文件复用旧 blob。公共符号 ID 由路径身份、名称、类型、作用域和位置组成，独立于 SQLite rowid。

SQL 关系在查询时解析目标，因此删除或重命名目标后，旧的原始调用记录会按当前快照重新判定。Cscope 15.9 在路径条件满足时复用旧交叉引用记录，仍需遍历旧库并重建全局倒排索引。

复用仅复制旧 `cscope.out`，在副本中等字节长度替换 cwd。全部摘要变化路径都参与判断，包括 `.inc`、`.def` 等被 include 的文本。变化文件在新 staging tree 中先解除与 blob 的硬链接，再设置严格大于种子库的秒级 mtime，使用 `-U` 强制检查删除与 include 变化。Cscope 15.9 的 `copyinverted()` 会丢失部分宏尾部引用的作用域，并将跨行源码片段误当成标识符。因此流式检查旧库，对含非空宏尾部或这类源码片段的文件也强制重新解析。旧快照、共享 blob 和工作树均不修改。使用文件名 alias、cwd 含空白、header 长度不等、种子格式不符或其他 Cscope 版本时全量构建。输入安全检查失败直接终止，构建失败保留旧发布版本。

## 并行度与调用接口

CLI `index` / `update` 支持 `--workers 1..8`，也可设置 `CODEINDEX_WORKERS`，默认取可用 CPU 数与 4 的较小值。该参数分别限制 Python 批次、JS/TS 池和 Ctags 分片，Cscope 是另一个独立任务。小于 256 KiB 或仅一个 JS/TS 文件时直接串行解析。原生构建使用独立进程组，超时或构建取消会终止其后代，等待退出后清理 staging。

JavaScript 的 `indexRepository()` 和 `runBenchmark()` 返回 Promise，调用方必须 `await`。`loadIndex()` 和查询仍为同步接口：

```js
const result = await indexRepository(repo, store, { workers: 4 });
const index = loadIndex(store);
try { /* 查询固定快照 */ } finally { index.close(); }
```

`stats.stages` 记录串行协调步骤的等待与处理时间，`native-cross-references` 是最后等待 Cscope 的耗时。`stats.nativeTaskMs` 记录与其他阶段重叠的原生任务时间，不能再次加到阶段总和。`nativeBuildMode` 为 `full`、`incremental` 或 `none`。worker 数量和老生代限制并非整棵进程树内存上限，严格资源预算应由 cgroup 设置 `MemoryMax` 和 `MemorySwapMax`。

无变化快路径会核对构建配置、工具版本和必要产物。Git revision 与干净状态相同时可直接返回；其他情况扫描内容摘要再判断。此快路径沿用 Git 状态判断范围，Git 忽略文件的独立改动应使用 `index` 强制重新扫描。

## 查询与证据

FTS 限定候选数量，随后加载候选符号的详细元数据。正文使用独立的文件级 FTS5，覆盖所有纳入文本，随增删改名更新。CLI `--mode auto|symbol|content` 对应 `queryIndex` 的 `searchMode`。正文模式将整条查询转成 unicode61 短语，支持跨行、忽略大小写和部分音调，不支持任意子串或正则。默认模式优先精确符号，其余查询优先正文候选，两个通道分别排序。父节点按作用域和包含范围查找，目录导航按路径索引读取，构建阶段省去全库导航摘要物化。

C/C++ 调用与引用通过 Cscope 按需查询。Python/JS/TS 调用、导入、继承和 C include 等事实从 SQL 读取。目标解析优先考虑当前文件与作用域，并限定相应语言组，歧义目标保留 `unresolved`。关系查询默认最多返回 256 条，原生截断及超过 4,096 条 SQL 目标候选会给出提示。

`--metadata-only` 读取查询数据库和必要的原生交叉引用产物。源码证据阶段按需读取 blob，验证 SHA-256，再按预算裁剪。输出 `startByte/endByte` 对应实际返回的 UTF-8 内容，默认最多 60 行。正文证据通过 FTS 实际高亮位置定位，`match` 保存完整匹配范围，超出行预算时 `truncated=true`。Ctags 位置以源码行为粒度；Python/JS/TS 解析器统一提供 UTF-16 列，由构建器转换为 UTF-8 字节。

`stats.relations` 只统计 SQL 关系。`native.files` 是 C/C++ 主要输入数，`native.indexedFiles` 是 Cscope 实际文件数。Cscope 允许沿已保存文件白名单内的 include 扩展；统计交叉引用范围时应使用实际文件数。

## 原生工具边界

- 构建需要 Universal Ctags 的 JSON 输出与 Cscope 倒排索引能力。查询原生关系只需要 Cscope。
- Python 默认使用 `python3.14`，`CODEINDEX_PYTHON` 或 `--python PATH` 可指定运行时，启动时验证版本与语法能力。`CODEINDEX_PARSER_TIMEOUT_MS` 设置 Python 池共享预算，默认 180 秒。
- `CODEINDEX_CTAGS` / `CODEINDEX_CSCOPE` 或命令行路径用于选择工具。
- 原生子进程固定使用 `/usr/bin:/bin` 和 `LC_ALL=C`，以确保 Cscope 内部 `env/sort` 行为稳定。
- 默认原生构建预算 180 秒，Ctags 拆分重试共享这段预算；查询默认 10 秒，可通过 `CODEINDEX_NATIVE_TIMEOUT_MS` 调整；捕获输出默认上限 32 MiB，可通过 `CODEINDEX_NATIVE_MAX_OUTPUT_BYTES` 调整。
- Cscope 退出码为零后仍会核验倒排文件、数据库文件清单和诊断。损坏产物会阻止发布或查询。
- 文件名包含空白时使用临时别名视图。控制字符、双引号和反斜杠路径被拒绝；空白文件名与额外 include 闭包同时出现时会报错。
- 实际存在的快照外 include 会被拒绝；缺失的 generated header 保持缺失，不会补读工作区内容。
- 当前 Cscope 使用 `-k`，未配置项目 `-I` 搜索路径。完整 C/C++ 输入仍逐文件索引，include 搜索、条件编译、宏展开和调用目标类型判定遵循工具的语法级能力。

## 审计导出与存储

```bash
node bin/codeindex.js export --store /path/to/index --output /path/to/empty-audit-directory
```

导出目录必须为空。产物包含文件、符号、包含关系、SQL 关系 JSONL，以及原生 Cscope 数据和清单。原生边维持 Cscope 格式，源码 blob 与 SQLite 仍存放在清单引用的原快照中。归档时应一起保存原快照，查询命令继续指向 store。

默认构建省去 `parsed.jsonl`、全量导航 JSONL 及全部关系的重复物化。导出会遍历符号和已保存关系，其耗时单独计算。

## 验证入口

实际 0.4 验收环境为 Node 24.13.1 / 22.23.2、CPython 3.14.2、TypeScript 5.9.3。完整正文、三项目构建、增量恢复和已知 C++ 查询缺口见 [解析可靠性验收](../benchmarks/parser-reliability.md)。

- `test/content-search.test.js`：正文短语、真实命中字节证据、metadata-only、精确名称候选、增删改名与旧读者。
- `test/javascript-ast.test.js`、`test/python-ast.test.js`：真实 AST 语法、词法父节点、调用、运行时边界与布局缓存。
- `test/parser-protocol.test.js`、`test/parser-coordinates.test.js`：协议错误、越界坐标、LF/UTF-16/UTF-8 转换、特殊换行及删除最后一个 Python 输入。
- `test/performance.test.js`：并行等价、宏尾部及跨行字符串引用、连续秒级增量、旧快照不变和取消清理。
- `test/production.test.js`：原生增量、旧读者、重命名、JS/TS 导入、UTF-8 证据、产物恢复和审计导出。
- `test/native-tools.test.js`：真实工具、路径、迁移、倒排损坏、超时和错误诊断。
- `test/compact-store.test.js`：FTS、稳定身份、增量隔离和偏移。
- `test/streaming.test.js`：批次消费、失败清理、配置变化及全量/增量一致性。
- `benchmarks/verify-linux-native.mjs`：Linux C 定位、双向调用、源码摘要和范围核验，`--update` 可执行自动恢复的单文件更新测量。

0.3 的全量、更新与内存测量见 [性能迭代报告](../benchmarks/index-performance.md)，0.2 的验收记录见 [Linux 原生后端](../benchmarks/linux-native.md)。Tree-sitter 流式实现的历史说明保留在 [streaming-index.md](streaming-index.md)。
