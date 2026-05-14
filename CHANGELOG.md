# Changelog

## v0.6.0

- 队列命令改名为 `Convert PDFs to Markdown (Queue)`。
- 设置面板拆分为：共用设置、MinerU 设置、Mathpix 设置（API Key）。
- 队列中新增“解析方式”选择（MinerU / Mathpix）。
- 保留 MinerU 专属表格编辑与历史批量转换命令。

## v0.5.0

- 新增命令：`MinerU: 编辑当前 Markdown 的 HTML 表格`（可视化编辑并保存）。
- 新增命令：`MinerU: 批量将历史 MinerU HTML 表格转为 Markdown`。
- 新增设置：`HTML 表格自动转 Markdown`（默认开启），对新转换结果自动处理。

## v0.4.1

- 修复队列弹窗宽度估算与长路径显示，减少横向拥挤。
- 优化开始按钮文案，显示当前待转换数量。
- 修复队列列表中文本显示细节，避免标签被压缩时的可读性问题。

## v0.4.0

- 命令升级为队列模式：`MinerU: Convert PDFs to Markdown (Queue)`。
- 新增可折叠目录树选择器，支持搜索、单文件/文件夹勾选与队列面板管理。
- 队列执行按顺序转换，并在结束后展示成功/跳过/失败汇总。

## v0.3.1

- 从 MinerU `full_zip_url` 结果包中提取并写入 `images/...` 等本地资源文件，修复图片引用缺失问题。
- 转换成功提示新增资源写入数量。

## v0.3.0

- API 调用从 `fetch` 切换为 Obsidian `requestUrl`，提升桌面端稳定性。
- 设置面板新增“手动忽略文件/文件夹”。
- 可转换列表过滤升级：基于手动忽略规则 + 已转换去重，不再硬编码 `Figures`。

## v0.2.0

- 新增过滤规则：`Figures` 目录下 PDF 全局忽略。
- 新增去重规则：若自动输出目录或手动覆盖目录中已存在同名 Markdown，则从可转换列表移除。

## v0.1.0

- 首版复刻：支持在 Vault 中选择 PDF，通过 MinerU API 上传、轮询解析并写入 Markdown。
- 支持基础设置：API Token、输出目录覆盖、解析公式、解析表格、模型版本。
- 支持解析进度提示与转换结果通知。
