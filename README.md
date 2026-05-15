# Obsidian Anything to MD Converter

Obsidian 本地插件：目标是把不同类型文件转换为 Markdown。  
当前主能力是 **PDF -> Markdown**（MinerU / Mathpix 双通道）。

---

## 1. 当前能力：MinerU 与 Mathpix 的 PDF 转 Markdown

### 1.1 使用方式（当前版本）

1. 将插件放到：`<Vault>/.obsidian/plugins/obsidian-anything-to-md-converter/`
2. 在 Obsidian 中启用插件：**Obsidian Anything to MD Converter**
3. 在插件设置里填写所需配置（见下文）
4. 命令面板执行：`Convert PDFs to Markdown (Queue)`
5. 在弹窗中选择解析方式（MinerU / Mathpix），勾选一个或多个 PDF，开始队列转换

### 1.2 解析通道与流程

#### MinerU 通道（当前主力）

- 认证：`Authorization: Bearer <API Token>`
- 流程：
  1. 申请上传地址（返回 `batch_id` + 预签名 URL）
  2. 上传 PDF
  3. 轮询解析进度
  4. 下载 `full_zip_url` 结果包
  5. 提取 `full.md` + 资源文件（如 `images/...`）并落盘

#### Mathpix 通道

- 认证：`MATHPIX_APP_ID` + `MATHPIX_APP_KEY`
- 流程：
  1. 上传 PDF 到 Mathpix
  2. 轮询任务状态
  3. 下载 `.md` 结果
  4. 应用统一后处理并落盘

### 1.3 当前设置项（按分组）

- 共用：
  - 输出目录（可选覆盖）
  - 手动忽略文件/文件夹
  - 表格健康检查
  - 按文件夹移除列规则
- MinerU：
  - API Token
  - 解析公式
  - 解析表格
  - HTML 表格自动转 Markdown
  - 模型版本（pipeline / vlm）
- Mathpix：
  - `MATHPIX_APP_ID`
  - `MATHPIX_APP_KEY`

### 1.4 输出与过滤规则

- 默认输出目录：`PDF 所在文件夹同级/原文件夹名_MD`
  - 例：`.../QP/a.pdf` -> `.../QP_MD/a.md`
- 若设置了“输出目录覆盖”，则写入指定目录
- 去重：若目标 Markdown 已存在，会从可转换列表排除
- 忽略：`手动忽略文件/文件夹` 支持相对路径、文件名、目录名
- MinerU 结果会保留资源文件（图片等）到 Markdown 同目录相对路径

### 1.5 表格相关能力（当前已上线）

- 新转换文件可自动把 HTML 表格转 Markdown（可关）
- 命令：`MinerU: 编辑当前 Markdown 的 HTML 表格`
- 命令：`MinerU: 批量将历史 MinerU HTML 表格转为 Markdown`
- 表格健康检查：
  - 删除全空行/全空列
  - 支持按目录规则移除指定列

---

## 2. 即将加入：TeX -> Markdown

下一步将加入 **TeX -> Markdown** 转换能力，重点是让非命令行用户也能一键用起来。

### 2.1 目标

- 在 Obsidian 内直接选择 `.tex` 文件并转换为 `.md`
- 将常用 Pandoc 能力封装到插件命令与设置中
- 保持与现有 PDF 转换一致的输出目录、日志与通知体验

### 2.2 计划实现方向（当前规划）

- 新增 TeX 转换命令（支持单文件/批量）
- 提供可配置参数（例如数学公式、引用、代码块处理策略）
- 失败时给出可读错误信息（而不是只显示命令失败）

> TeX 功能属于“即将开发”，本 README 会在功能落地后同步更新细节。

---

## 3. 后续路线：更多文件类型 -> Markdown

项目长期目标是 **Anything to MD**，后续会逐步扩展更多输入类型。

### 3.1 方向

- 文档类：Word、PPT、HTML、网页剪藏等
- 结构化文本类：LaTeX、纯文本扩展格式等
- 图像/扫描类：通过 OCR 或多模态 API 转换

### 3.2 统一设计原则

- 同一套编排体验：选择文件 -> 选择转换方式 -> 队列执行 -> 汇总结果
- Provider 适配器分层：每种转换能力独立实现，主流程统一调度
- 统一后处理：目录策略、去重、资源落盘、表格清洗、可观测提示

---

## 开发（本仓库）

```bash
npm install
npm run build
npx tsc --noEmit
```

---

## 文档说明

- 当前使用与行为：`README.md`
- 版本历史与功能演进：`CHANGELOG.md`
- 长期维护规范：`AGENTS.md`
