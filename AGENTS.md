# AGENTS.md (long-term)

适用范围：仓库根目录（`obsidian-anything-to-md-converter`）。

## 1. Commit hygiene

- 仅按文件路径精确暂存（explicit paths）。
- 不使用 `git add .`。
- 一个 commit 只做一类目的（单一功能或单一修复）。
- `dev-logs/` 禁止暂存（禁止进入任何 commit）。

## 2. Version synchronization (must keep)

每次版本提交必须同步以下文件：

1. `manifest.json` 的 `version`
2. `package.json` 的 `version`
3. `package-lock.json` 顶层 `version`
4. `CHANGELOG.md` 对应版本条目

## 3. Version bump policy (must follow)

- 新功能：升级 **minor**（`0.x.0 -> 0.(x+1).0`）
- 纯修复：升级 **patch**（`0.x.y -> 0.x.(y+1)`）

## 4. dev-logs policy

- 开发日志统一放在根目录：`dev-logs/`
- 每个版本对应一个日志文件（如 `dev-logs/v0.7.0.md`）
- `dev-logs/` 仅用于本地长期审计（你 + 助手使用）
- `dev-logs/` 永不 commit，永不 push，永不上传
- 每条日志固定包含：`决策记录` / `排障路径` / `回归风险点` / `验证样本` / `可复用清单`

## 5. Documentation placement

- 使用说明与当前行为：`README.md`
- 版本历史：`CHANGELOG.md`
- 规范与长期约束：`AGENTS.md`

## 6. Quality gate before reporting done

至少满足：

1. `npm run build`
2. `npx tsc --noEmit`

当改动涉及转换主流程时，增加：

3. 至少 1 个真实转换冒烟（输出 markdown 可落盘）
4. 若涉及队列逻辑，至少 2 个文件队列转换并核对汇总计数

## 7. Code structure conventions

- Provider 适配器分层：`src/mineru-api.ts` / `src/mathpix-api.ts`
- 核心编排集中在 `src/main.ts`，尽量避免把复杂逻辑塞入 UI 层
- 表格逻辑统一复用 `src/table-tools.ts`，不要重复造轮子

## 8. Efficiency and token-saving rules

- 先查已有实现再新增逻辑，优先复用现有函数。
- 读代码优先“定点读”（按文件/区段），避免无差别全量扫描。
- 输出变更说明时聚焦“行为变化 + 关键文件”，避免冗长重复。
- 调试优先最小复现，先修主链路，再扩展边界用例。
- 写/更新 `CHANGELOG.md` 与 `dev-logs/` 时，先读取最新条目并按现有风格续写；不要在 `AGENTS.md` 内嵌大模板。

## 9. Project memory (high-value findings)

- `fetch -> requestUrl` 在 Obsidian 桌面端更稳定（跨域/网络环境更稳）。
- PDF 结果下载必须同时处理 markdown 与资源文件（如 `images/...`）。
- 队列能力变更容易引发布局与可用性回归，需同步看交互与计数一致性。
- 表格链路建议走“HTML 转 Markdown + 健康检查”两段式，维护成本更低。
