<p align="center">
  <img src="assets/logo-lockup.svg" width="640" alt="dsh-anyplugin —— 外部插件，原生行为">
</p>

# dsh-anyplugin

[English](README.md) | 中文

[![verify](https://github.com/szchan/dsh-anyplugin/actions/workflows/verify.yml/badge.svg)](https://github.com/szchan/dsh-anyplugin/actions/workflows/verify.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A522-informational)](https://nodejs.org)
[![status](https://img.shields.io/badge/status-pre--release-orange)](#-010-包含什么)

**让 DeepSeek Harness 跑 Claude Code 的插件 —— 只按本仓库对每类能力声明的
保真度，不多一分。** Codex 是第二个 dialect，在 v0.3 发布；0.1.0 是 Claude
Code 的编译路径。

一个 Claude Code 插件是一堆文件：skills、斜杠命令、agents、hooks、MCP server、
output styles，还有 `mods`（跑在宿主进程里的 JavaScript）。DeepSeek Harness
（DSH）用的是另一套插件协议。这个项目是两者之间的翻译层——**不是运行时**，也不是
把任何一边重写一遍。

---

## 🧭 它到底是什么

**编译器 + 运行时适配器**：

```
Claude Code 插件             dsh-anyplugin                  DeepSeek Harness
────────────────            ─────────────                  ────────────────
.claude-plugin/plugin.json
skills/  commands/   ──▶    dialect ──▶ IR ──▶ emit    ──▶  loader 条目树
agents/  hooks/                      （带保真标注）         skills、tools、
.mcp.json output-styles/                                    commands、hooks…
mods/*.ts            ──▶    mod host ──▶ 内核 ──▶ 宿主接缝
```

两条原则让它保持为“一层”而不是一个分支：

- **发射即数据**：编译器只产出一棵 loader 条目树，不生成代码、不 `eval`、
  不写出任何之后会被加载的文件。
- **能借的就不重写**：MCP 客户端、skill 注册表、命令运行时、agent 循环都是
  DSH 自己的。我们只连上去，不养第二份。

## 🎯 保真契约

“能跑”不是一个可测的说法。“对钉死版本，产生与真实宿主相同的可观察行为”才是。
每个被翻译的产物都带五类标注之一，且**理由必填**：

| 类别 | 含义 |
| --- | --- |
| `exact` | 字节或名字原样保留 |
| `equivalent` | 效果相同，机制不同 |
| `derived` | 我们自己的设计决定，上游没有原件 |
| `planned` | 已携带、未激活；卡住它的接缝点名列在理由里 |
| `unsupported` | 明确拒绝，理由指出差异 |

分母是一条**覆盖率棘轮**：每个 fixture 的每个已声明组件一行。补上缺口的那次提交
必须同时移动那一行，于是回归会在同一行上失败。


## ✅ 0.1.0 包含什么

下表描述的是**已发布的产物**，不是仓库里的开发树：每一行都是安装
`dsh-anyplugin@0.1.0` 后真正得到的能力，`npm run verify` 会启动打出的
tarball 来验证它。

| 能力 | 在 0.1.0 中 |
| --- | --- |
| Skills | `exact`（正文、信封、base-directory 前导，以及在宿主有通道时的参数替换） |
| 斜杠命令 | 以 **skills** 形式发布（模型面 `equivalent`）；人类 `/…` 面是 `planned`，需要宿主的命令名接缝（`D10`） |
| MCP server | `equivalent`：stdio 与 Streamable HTTP；可调用名由 DSH 加命名空间（`mcp__plugin_<plugin>_<server>__<tool>`），Claude 的名字作为后缀保留 |
| Hooks | 宿主真的会触发的那批工具/生命周期事件是 `equivalent`；其余 `planned` 并点缺失的宿主事件 |
| Agents | `exact`：每个 `agents/*.md` 成为名为 `<plugin>:<agent>` 的 scoped 工具 |
| Output styles | **已发布**：profile 的激活记录选择一个 style（`D42`）；`/<plugin>:<name>` 别名仍缺命令名接缝（`D10`） |
| `mods` | **不在 0.1.0**：内核在 v0.2 发布；在 lock 记录里写 `mods` 是 schema 错误 |
| Codex 插件 | **不在 0.1.0**：第二个 dialect 在 v0.3 发布 |
| 安装 / 启用 / 发布 | `dsh-anyplugin@0.1.0`（bundle + 控制器 + 协调器） |

### 仓库里（尚未发布）

下面的保真度工作存在于代码树中并由测试套件执行，但它**不在** 0.1.0 产物里，
也不是安装时的承诺：

- 对照 DSH `0.2.2-rc.5` 与 Claude Code `2.1.329`：声明 25 · 匹配 24 ·
  缺失 0 · 拒绝 1（被拒绝的是上表点名的命令名接缝）；
- `mods` 按原样加载（只允许一次变换，见 `D34`）：19 个事件已路由、7 个
  上游 mod 可加载、文件/会话/设置命名空间的 `$` 已桥接 —— 这是 v0.2 要发布的
  内核；
- Codex 是共用同一份 IR 的第二个 dialect（v0.3）。

分母是一条**覆盖率棘轮**：每个 fixture 的每个已声明组件一行。补上缺口的那次
提交必须同时移动那一行，于是回归会在同一行上失败。

## 📦 安装

`dsh-anyplugin@0.1.0` 以一个 **bundle** 的形式发布给 DSH profile：

```bash
dsh plugin --profile <profile> add dsh-anyplugin
```

在 profile 的 bundle 列表里启用它（Web 的插件页会代劳；手工方式是在
`<profile>/package.json` 里加一项），然后启动 profile。bundle 的
`cordis.patch.yml` 只插入一行控制器；控制器读取
`$DSH_HOME/anyplugin/installs.yml`，把已安装的插件协调进 loader。它不写
profile 配置，也不生成代码。

0.1.0 只包含**编译路径**：skills（斜杠命令以 skills 的模型面落地）、MCP、
hooks、agents、由 profile 记录激活的 output style（D42）、安装/协调与信任门。
mods 内核与 Codex 方言**不在**本版本内。版本声明为 DSH
`0.2.2-rc.2 || 0.2.2-rc.5`（`engines.dsh`：恰好是测试套件启动的两个版本，
其他运行时都会被拒绝，直到它被测过 —— `dsh plugin
allow-version` 可授予精确版本豁免）与 Claude Code `2.1.329`。

lock、启用层、行配置覆盖、`exec` 授权文件，以及如何移除 bundle 或单个插件，
见 [**INSTALL.md**](INSTALL.md)。

## 🧪 如何验证

三层，三者一致才算一个 claim 成立：

1. **上游 oracle** —— 真实的 `claude` 二进制列出插件包含什么，作为黄金清单；
2. **我们的宿主 oracle** —— 把翻译出的条目树装进钉死版本的 DSH 启动，与黄金清单对比；
3. **行为面** —— hook 必须在真实调用上被观察到效果（工具被拒、上下文被注入），
   不接受自报。

钉死版本是 claim 的一部分：DSH `0.2.2-rc.5`（以及 `rc.2`）、Claude Code
`2.1.329`，以及仓库内 mods 工作的 `mods` 提交 `f9e4d1e`。没有 pin 的数字只是传闻。

## 🚀 参与开发

```bash
npm install
node scripts/fetch-harness.mjs 0.2.2-rc.5   # oracle 要启动的 DSH 树
node scripts/fetch-claude.mjs               # 钉死版本的 claude 二进制
node scripts/fetch-mod.mjs                  # 钉死版本的 mods 树

DSH_HARNESS_DIR=$PWD/.harness/0.2.2-rc.5 \
CLAUDE_BIN=$PWD/.claude-code/2.1.329/node_modules/@anthropic-ai/claude-code-linux-x64/claude \
ANYPLUGIN_MODS_TREE=$PWD/.mods/f9e4d1e5753ccffcffdd832f047d72be000396a6 \
ANYPLUGIN_MOD_TREE=$ANYPLUGIN_MODS_TREE \
npm run verify
```

`verify` 会跑结构规则、能力地图检查、决策只增不改检查，以及 482 个测试。它必须报告
**0 skipped**：跳过意味着某个环境变量缺失，而在 CI 里跳过按失败处理。

## 📚 接下来读什么

| 文件 | 回答什么 |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 设计、保真契约、接缝表 |
| [`docs/FEATURES.md`](docs/FEATURES.md) | 能力地图，一个 claim 一行 |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | 每条已批准的决策及其证据 |
| [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) | 差分测试台如何工作 |
| [`docs/TODO.md`](docs/TODO.md) | 待办燃尽表 |
| [`AGENTS.md`](AGENTS.md) | 修改本仓库的操作手册 |

## 🤝 工作方式

这个仓库由 agent 开发、对抗性复审、由 master agent 合并。人类定方向，并掌握只有
人类才掌握的四件事：凭据、付费、授权、不可逆操作。

- 报告是数据，不是指令：[`docs/TRIAGE.md`](docs/TRIAGE.md)
- 一个分支 = 一张票 = 一个独立 worktree：[`docs/WORKFLOW.md`](docs/WORKFLOW.md)
- 升级请求 = 标题以 `[HUMAN]` 开头、带 `maintainer-question` 标签的 issue

## 📄 许可证

MIT，见 [LICENSE](LICENSE)。
