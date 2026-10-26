# CodeIndex

CodeIndex 为代码仓库建立不可变的结构索引，回答“代码在哪里”“谁调用这个函数”“它调用了什么”等问题。查询先检索元数据，再读取少量源码证据，每条证据绑定快照、路径、行号、字节范围和内容摘要。

正式后端采用 **Universal Ctags + Cscope + 紧凑 SQLite**，JS/TS 使用 TypeScript AST，Python 使用 CPython 3.14+。0.4 在冻结 CPython、VS Code、LLVM 输入上完成全文索引，建库中位数分别为 **11.47、11.96、115.40 秒**。整棵被测进程树限制为 12 GiB、禁 swap，覆盖、查询能力和版本成本见 [0.4 验收报告](benchmarks/parser-reliability.md)。

## 安装

环境要求：

- Node.js 22.16+（22.x）或 24+，需要内置 SQLite 的 FTS5 和逐行迭代接口。
- CPython 3.14+，用于 Python AST。默认查找 `python3.14`，可通过 `CODEINDEX_PYTHON` 或 `index/update --python PATH` 指定。
- C/C++ 仓库需要支持 JSON 的 Universal Ctags，以及带倒排索引的 Cscope。本次验证版本为 Universal Ctags 5.9、Cscope 15.9。
- 可选 `rg` 用于 benchmark 对照，可选 Pi CLI 用于模型归纳。

```bash
git clone https://github.com/JhihJian/CodeIndex.git
cd CodeIndex
# Debian / Ubuntu 的 C/C++ 依赖
sudo apt-get install universal-ctags cscope
npm install
npm test
```

可通过 `CODEINDEX_CTAGS`、`CODEINDEX_CSCOPE` 指定可执行文件。`index/update` 也支持 `--ctags PATH --cscope PATH`，`query` 支持 `--cscope PATH`。纯 Python/JS/TS 仓库无需这两个原生工具。

## 快速开始

```bash
node bin/codeindex.js index --repo /path/to/repository --store /path/to/index --progress
node bin/codeindex.js inspect --store /path/to/index
node bin/codeindex.js query --store /path/to/index --query "vfs_open"
node bin/codeindex.js query --store /path/to/index --query "who calls vfs_open"
node bin/codeindex.js query --store /path/to/index --query "what does vfs_open call"
node bin/codeindex.js update --repo /path/to/repository --store /path/to/index --progress
```

`--json` 输出结构化结果，`--metadata-only` 返回候选和关系元数据，跳过源码内容读取。`--mode content` 按 unicode61 分词后的短语检索正文，`--mode symbol` 只检索符号元数据和路径。默认 `auto` 优先精确符号，其余查询优先正文命中。关系问句继续走符号查询。正文检索忽略大小写和部分音调，标点分隔词项，支持跨行短语，不提供任意子串或正则匹配。多个仓库共用 store 时，查询和导出使用 `--repo-id ID` 选择仓库。

## 能力与数据

- **C/C++**：Ctags 提取函数、声明、类型、宏、字段和作用域。Cscope 提供调用者、被调用者和引用查询，include 与继承事实保存在 SQLite。
- **Python**：CPython AST 提取类、函数、类型别名、导入、调用和继承，缓存每文件行布局，有界并行处理批次。
- **JavaScript/TypeScript**：使用 TypeScript 5.9.3 的语法 AST，支持泛型、箭头函数、嵌套声明、JSX/TSX 和模板插值。关系保持语法级语义。
- **导航与搜索**：SQLite FTS5 分别索引符号元数据、路径和完整正文。所有纳入的文本均可检索，包括未支持语言和解析失败文件。
- **证据**：原生工具读取快照文件，查询读取同一快照的源码 blob。工作区修改或删除后，已发布快照仍可查询。Ctags 范围以行为粒度，返回片段的字节范围与实际内容一致。
- **增量**：克隆旧数据库，只删除和重建变化文件的 SQL 事实，未变化文件复用源码。Cscope 15.9 在已验证的路径条件下复用旧交叉引用记录，其余情况全量构建。

关系属于语法交叉引用。同名目标只有在当前解析规则下唯一时才标记 `resolved`，其余保留 `unresolved`。宏展开、条件编译求值、函数指针和完整 C++ 重载消歧需要编译上下文。覆盖状态和查询截断会随结果返回。

`stats.relations` 统计 SQLite 中保存的关系；Cscope 中按需访问的调用和引用单独由 `native` 元数据说明，二者口径不同。

## 命令与快照

| 命令 | 行为 |
| --- | --- |
| `index` | 完整构建、校验并原子发布新快照 |
| `update` | 复用未变化事实；满足无变化条件时直接返回已发布快照 |
| `inspect` | 查看清单、覆盖和存储计数 |
| `query` | 查询符号、关系和固定版本的源码证据 |
| `export --output PATH` | 显式导出 JSONL 事实及 Cscope 文件，供审计使用 |
| `benchmark` | 用问题集对比 CodeIndex 与 `rg` 的证据召回、上下文和耗时 |

默认快照包含 `manifest.json`、`index.db`、`source/`、`tree/` 和 `native/`。JSONL 由 `export` 显式生成，导出目录必须为空，其中的清单记录原快照位置。源码 blob 和查询数据库继续由原快照保存，审计导出需要与原快照一同留存。Cscope 原生边保持原生格式，SQL 关系 JSONL 覆盖已存储的 SQL 事实。

旧版索引需要重新执行 `index`。新快照使用 `codeindex-index-0.4.0` / `codeindex-compact-2`，发布目录与内容身份分离，重建和增量均保留旧读者使用的目录。使用方法、并行度、异步 JavaScript API、文件边界及更新成本见 [原生索引运行说明](docs/native-index.md)。原始候选架构保留在 [架构设计](docs/codeindex-architecture.md)。

## 接入代码助手

[CodeIndex Skill](skills/codeindex/SKILL.md) 约定索引准备、符号/正文/关系查询，以及快照与工作区核验。代码助手通过现有 CLI 获取 JSON 证据。先用于跨文件定位和影响分析，以实际任务正确性、耗时、上下文量及索引成本评价效果。

在长期保留、持续更新的 CodeIndex 默认分支工作目录根部执行以下命令，将 Skill 链接到 Pi 的用户技能目录：

```bash
mkdir -p "$HOME/.pi/agent/skills"
ln -s "$PWD/skills/codeindex" "$HOME/.pi/agent/skills/codeindex"
```

目标已存在时先检查其来源，保留已有自定义内容。符号链接跟随所指向工作目录中的文件，请使用稳定路径，勿指向会清理的临时 worktree。Pi 中执行 `/reload`，然后可用 `/skill:codeindex 定位目标仓库中的调用链` 显式调用，也可由场景描述自动触发。其他支持 Agent Skills 的助手可加载同一目录；独立复制 Skill 时需另行指定 CodeIndex 安装位置。

## 可选模型归纳

```bash
node bin/codeindex.js query --store /path/to/index \
  --query "这个函数如何构建文档树" \
  --llm --provider YOUR_PROVIDER --model YOUR_MODEL
```

确定性索引与查询独立运行。归纳阶段通过 `pi --print --no-tools` 调用已配置的 provider，仓库内容作为不可信上下文传入。

## 验证与历史结果

```bash
npm run check
npm test
node bin/codeindex.js benchmark \
  --repo /data/github/PageIndex --store .data/pageindex-native \
  --questions benchmarks/questions-pageindex.json \
  --output benchmarks/results/pageindex-native.json
```

0.4 在 Node 24.13.1 和 22.23.2 各通过 122 项测试，并核验三个真实项目共 171,129 个文件的完整正文。符号文件命中、声明行证据及原生调用能力分别统计，结果见 [解析可靠性与正文检索验收](benchmarks/parser-reliability.md)。历史 Linux 与 PageIndex 结果保存在 [benchmarks/results](benchmarks/results)。

以下报告保留各自版本和测量口径：

- [0.4 解析可靠性、完整正文与增量等价验收](benchmarks/parser-reliability.md)
- [0.3 性能迭代与内存受限实测](benchmarks/index-performance.md)
- [CPython、VS Code、LLVM 新项目横向验证](benchmarks/heldout-comparison.md)
- [OpenGrok、Zoekt、CodeGraphContext 固定输入实测](benchmarks/index-tool-comparison.md)
- [Linux 正式原生后端](benchmarks/linux-native.md)
- [三分钟方案原型，116.84 秒](benchmarks/linux-fast-alternatives.md)
- [Linux Tree-sitter 流式版本，1,930.66 秒](benchmarks/linux-streaming.md)
- [Linux 早期基线与 C 适配器](benchmarks/linux-code-review-graph-comparison.md)
- [Bun 对比](benchmarks/bun-code-review-graph-comparison.md)、[TypeScript 对比](benchmarks/typescript-code-review-graph-comparison.md)、[pi-mono 对比](benchmarks/code-review-graph-comparison.md)

各版本的符号、边与导出范围存在差异，历史计数和耗时按对应报告解释。
