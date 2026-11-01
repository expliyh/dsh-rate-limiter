# AGENTS.md

## 适用范围

本文件适用于整个仓库。开始修改前先阅读本文件和最近的提交记录；若后续子目录加入更具体的 `AGENTS.md`，以离目标文件最近者为准。

## 项目概览

`@xidong-ai/dsh-rate-limiter` 是 DeepSeek Harness（DSH）的 Cordis 插件，在 `agent/request` waterfall 中按供应商使用令牌桶主动限速。超限请求会延迟排队，不应该失败；未配置的供应商必须保持零侵入。

项目要求 Node.js >= 22，并使用 `package-lock.json` 固定依赖。

## 目录与事实来源

- `lib/index.ts`：宿主端入口，注册 `agent/request` 钩子。
- `lib/config.ts`：Schemastery 配置 schema、实时 `Volatile` 配置与供应商参数校验。
- `lib/limiter.ts`：令牌桶、可取消等待和按供应商管理桶的核心逻辑。
- `lib/index.js`、`lib/config.js`、`lib/limiter.js`：由 `npm run build` 从对应 `.ts` 生成的已跟踪产物。修改宿主端逻辑时编辑 `.ts`，构建后一并提交更新后的 `.js`，不要只手改这三个生成文件。
- `lib/client.js`：手写的浏览器端插件配置卡片，不经过本项目构建器，也不会被 `npm run build` 重写；修改客户端时要直接编辑并测试它。
- `test/limiter.test.ts`：限速核心行为测试。
- `test/client.test.ts`：浏览器端 bundle 契约、表单状态、保存与生命周期测试。
- `cordis.patch.yml`：插件安装时注册的默认行配置。
- `README.md` / `README.zh.md`：中英文公开文档，面向用户的变更应同步更新两份。
- `.github/workflows/`：PR 来源、GPG 签名和手动发布规则。
- `.githooks/` 与 `scripts/check-grammar.mjs`：本地提交消息、排版和语法约束。

不要在未确认生成关系时直接修改 `lib/*.js`。`lib/client.js` 是例外：它是手写文件。

## 常用命令

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

本仓库的 `test/limiter.test.ts` 导入 `lib/limiter.js`，因此修改 `lib/*.ts` 后应先用 `npm run build` 更新产物，再运行测试；只运行 `npm test` 可能测到旧产物。完整验证顺序为：

```powershell
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

首次检出仓库时启用提交钩子：

```powershell
git config core.hooksPath .githooks
```

若环境安装了 `autocorrect`，钩子还会检查中文与英文、数字、符号之间的空格。不要用 `--no-verify` 规避本地检查；远程检查不会被绕过。

## 开发约定

- 保持部署默认零侵入：`enabled: true` 但未配置供应商时，不得改动请求、路由或错误传播。
- 配置项通过 `Volatile#get()` 在每个请求读取；设置页修改应在下一个请求生效，不应要求重载插件。
- 动态更新供应商配置时，速率和突发容量未变的桶应保留排队状态。
- 取消等待时当前实现不退还已预约的槽位；不要在没有测试和行为说明的情况下改变这一保守语义。
- `lib/client.js` 是自包含的浏览器模块工厂。运行时导入应限制在平台提供的依赖；没有明确需求时不要引入客户端打包器或新的运行时依赖。
- 行为变更必须补充或更新测试。客户端卡片、保存协议、revision 冲突、订阅释放等改动应在 `test/client.test.ts` 覆盖。
- 公开 API、配置方式、安装或使用流程变化时同步修改 `README.md` 与 `README.zh.md`。
- 发布由维护者控制。除非用户明确要求，不要修改版本号、创建标签、手动运行 release workflow 或执行 `npm publish`。

## Git 分支与提交要求（必须遵守）

### 分支模型

| 分支 | 用途 |
| --- | --- |
| `dev` | 日常集成分支，功能和修复 PR 默认目标 |
| `main` | 可发布主线 |
| `stable` | 稳定发布线 |

固定晋级路径：

```text
codex/<topic> -> dev -> main -> stable
```

- 禁止直接向 `main` 或 `stable` 提交、推送或合并日常改动。
- 日常功能、修复和文档改动从最新 `origin/dev` 创建短期分支，并向 `dev` 发起 PR。
- `main` 的 PR 只能来自 `dev`；`stable` 的 PR 只能来自 `main`。这是 `.github/workflows/pr-source.yml` 的强制检查，不能用其他分支绕过。
- 本地创建的 `codex/*` 分支不要跟踪 `origin/dev`，否则普通 `git push` 可能误推 `dev`。推荐：

```powershell
git fetch origin --prune
git switch --no-track -c codex/<topic> origin/dev
```

- 本仓库的 `origin` 是个人 fork，`upstream` 是上游仓库。默认把工作分支推送到 `origin`，PR 也先面向 fork；不要向 `upstream` 推送分支或直接操作上游保护分支。
- 不要强推 `dev`、`main`、`stable` 或其他共享分支。只允许在确认是个人、未共享分支时使用 `--force-with-lease`。

### GPG 签名

- 所有进入 `main` 或 `stable` 的 PR 中，每个提交都必须被 GitHub 验证为 **GPG 签名**；SSH 签名不满足 `.github/workflows/require-signatures.yml`。
- 因为功能分支提交最终会随 `dev -> main` PR 一起接受检查，开发阶段就应启用 GPG 签名，而不是等到晋级时再补。
- 确认本地默认签名并提交：

```powershell
git config --global commit.gpgSign true
git config --global user.signingkey <GPG-key-id>
git log --show-signature -1
git verify-commit HEAD
```

- 用于提交的邮箱必须与 GitHub 账号中已登记的 GPG key 匹配；最终以 GitHub 显示 `Verified` 且签名类型为 GPG 为准。
- 发现已推送提交未签名时，不要擅自改写共享历史。个人未共享分支可在用户确认后重建；共享分支或已审查分支应停止并报告。

### 提交消息

所有人工提交都受 `.githooks/commit-msg` 和 `scripts/check-grammar.mjs` 约束。标题必须严格使用：

```text
【类型】摘要
【类型，范围】摘要
```

- 类型只能是：`初始`、`更改`、`新增`、`修复`、`格式`、`文档`、`测试`、`维护`。
- 范围可选，1–16 个汉字、英文字母、数字、下划线或连字符。
- 摘要长度 1–60 个码点，不把 issue 编号放在标题中。
- 有正文时，标题后必须先留一个空行；相关问题编号写在正文中。
- 历史提交中出现过 `【适配】`、`【重构】` 等类型，但当前检查脚本不接受；不要照抄这些旧标题，除非脚本和规则已同步更新。
- 遵守 AutoCorrect 排版规则，在中文与英文、数字、符号之间使用合适的空格。

示例：

```text
【新增，开发】补充仓库代理协作说明

说明分支、签名和提交消息约束。

相关问题编号：
#123
```

提交前检查实际暂存内容，按文件明确暂存，避免把无关改动或构建噪声带入提交：

```powershell
git status --short --branch
git diff --check
git diff --cached --check
```

### 提交流程

1. 同步并确认基线：`git fetch origin --prune`，检查 `origin/dev`。
2. 创建短期分支：`git switch --no-track -c codex/<topic> origin/dev`。
3. 完成实现和测试，确认生成文件已更新且工作区只包含预期改动。
4. 确认 `git verify-commit HEAD` 成功、GitHub 能识别 GPG 签名，提交标题符合语法。
5. 将 `codex/<topic>` 推送到 `origin`，向 `origin/dev` 发起 PR。
6. 只有当用户明确要求晋级或发布时，才创建 `dev -> main` 或 `main -> stable` PR；不要自行合并或发布。

提交前至少执行：

```powershell
git diff --check
npm run typecheck
npm run build
npm test
git status --short --branch
```

若本次改动涉及配置、客户端、依赖或发布元数据，再执行 `npm pack --dry-run`，并核对发布内容。

PR 描述应列出用户可见变化、验证命令及结果、未执行的验证和已知风险。不得声称未实际运行的测试、签名检查或发布检查已经通过。
