# 原生索引运行说明

CodeIndex 0.2 使用紧凑 SQLite 保存符号与轻量关系，并通过 Cscope 查询 C/C++ 交叉引用。全量构建的关键路径是扫描、保存源码、符号提取、索引构建、原生交叉引用和发布校验。

## 构建与发布

`index` 总是完整构建。扫描器为纳入范围的文本文件计算摘要，构建器将内容保存到 `source/<sha256>`，并为原生工具生成 `tree/<仓库相对路径>`。`tree` 与已保存的 blob 使用硬链接，活跃工作区文件独立保存。复制时发现内容与扫描摘要不同，构建立即失败。

Ctags 输出逐行写入 SQLite。Python AST 和 JS/TS 提取结果按批次消费。建库结束时批量建立 FTS 与 B-tree，随后生成并验证 Cscope 数据库、倒排索引及文件映射。发布前检查符号范围与外键。

快照目录使用内容身份加独立的生成标识。`published.json` 通过原子替换切换目录，已有查询继续使用原目录。失败构建清理临时目录，保留原发布指针。内容、解析器版本、数据库格式、文件大小限制和工具版本共同参与快照身份。

## 更新成本

`update` 比较文件摘要，克隆旧数据库，只删除和重提取变化、删除文件的记录。FTS 触发器维护增量索引，未变化文件复用旧 blob。公共符号 ID 由路径身份、名称、类型、作用域和位置组成，独立于 SQLite rowid。

SQL 关系在查询时解析目标，因此删除或重命名目标后，旧的原始调用记录会按当前快照重新判定。Cscope 每次实际更新均重建整个 C/C++ 交叉引用索引。Linux 单文件更新中，该阶段约占 58 秒，是主要成本。

无变化快路径会核对构建配置、工具版本和必要产物。Git revision 与干净状态相同时可直接返回；其他情况扫描内容摘要再判断。此快路径沿用 Git 状态判断范围，Git 忽略文件的独立改动应使用 `index` 强制重新扫描。

## 查询与证据

FTS 限定候选数量，随后加载候选符号的详细元数据。父节点按作用域和包含范围查找，目录导航按路径索引读取，构建阶段省去全库导航摘要物化。

C/C++ 调用与引用通过 Cscope 按需查询。Python/JS/TS 调用、导入、继承和 C include 等事实从 SQL 读取。目标解析优先考虑当前文件与作用域，并限定相应语言组，歧义目标保留 `unresolved`。关系查询默认最多返回 256 条，原生截断及超过 4,096 条 SQL 目标候选会给出提示。

`--metadata-only` 读取查询数据库和必要的原生交叉引用产物。源码证据阶段按需读取 blob，验证 SHA-256，再按预算裁剪。输出 `startByte/endByte` 对应实际返回的 UTF-8 内容，默认最多 60 行。Ctags 位置以源码行为粒度；Python/JS 的范围使用各自解析器提供的信息。

`stats.relations` 只统计 SQL 关系。`native.files` 是 C/C++ 主要输入数，`native.indexedFiles` 是 Cscope 实际文件数。Cscope 允许沿已保存文件白名单内的 include 扩展；统计交叉引用范围时应使用实际文件数。

## 原生工具边界

- 构建需要 Universal Ctags 的 JSON 输出与 Cscope 倒排索引能力。查询原生关系只需要 Cscope。
- `CODEINDEX_CTAGS` / `CODEINDEX_CSCOPE` 或命令行路径用于选择工具。
- 原生子进程固定使用 `/usr/bin:/bin` 和 `LC_ALL=C`，以确保 Cscope 内部 `env/sort` 行为稳定。
- 默认原生构建单次超时 180 秒、查询 10 秒，可通过 `CODEINDEX_NATIVE_TIMEOUT_MS` 调整；捕获输出默认上限 32 MiB，可通过 `CODEINDEX_NATIVE_MAX_OUTPUT_BYTES` 调整。
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

- `test/production.test.js`：原生增量、旧读者、重命名、JS/TS 导入、UTF-8 证据、产物恢复和审计导出。
- `test/native-tools.test.js`：真实工具、路径、迁移、倒排损坏、超时和错误诊断。
- `test/compact-store.test.js`：FTS、稳定身份、增量隔离和偏移。
- `test/streaming.test.js`：批次消费、失败清理、配置变化及全量/增量一致性。
- `benchmarks/verify-linux-native.mjs`：Linux C 定位、双向调用、源码摘要和范围核验，`--update` 可执行自动恢复的单文件更新测量。

Linux 正式结果见 [性能报告](../benchmarks/linux-native.md)。Tree-sitter 流式实现的历史说明保留在 [streaming-index.md](streaming-index.md)。
