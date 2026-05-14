import { normalizePath, Notice, Plugin, TFile } from "obsidian";

import {
  buildMarkdownDocument,
  ensureFolderExists,
  getUniqueMarkdownPath,
  resolveOutputDirectory
} from "./markdown";
import { MathpixApiClient } from "./mathpix-api";
import { PdfParserProvider, PdfQueueModal } from "./modal";
import { MineruApiClient, MineruDownloadedAsset, MineruExtractResult } from "./mineru-api";
import { AnythingToMdSettingTab, AnythingToMdSettings, DEFAULT_SETTINGS } from "./settings";
import { HtmlTableEditorModal } from "./table-editor-modal";
import { convertHtmlTablesToMarkdown, hasHtmlTable, isLikelyMineruMarkdown } from "./table-tools";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

interface ConvertPdfOptions {
  provider: PdfParserProvider;
  queueMode?: boolean;
  queueIndex?: number;
  queueTotal?: number;
  queueNotice?: Notice;
}

interface ConvertPdfResult {
  filePath: string;
  status: "success" | "failed" | "skipped";
  outputPath?: string;
  assetCount?: number;
  message?: string;
}

export default class AnythingToMdPlugin extends Plugin {
  settings: AnythingToMdSettings = DEFAULT_SETTINGS;
  private statusBarEl?: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new AnythingToMdSettingTab(this.app, this));
    this.statusBarEl = this.addStatusBarItem();
    this.clearStatus();

    this.addCommand({
      id: "convert-pdf-to-markdown",
      name: "Convert PDFs to Markdown (Queue)",
      callback: () => {
        const convertiblePdfFiles = this.getConvertiblePdfFiles();
        if (convertiblePdfFiles.length === 0) {
          new Notice("没有可转换的 PDF（手动忽略项与已转换文件已过滤）", 9000);
          return;
        }

        new PdfQueueModal(this.app, convertiblePdfFiles, (selectedFiles, provider) => {
          void this.convertPdfQueue(selectedFiles, provider);
        }).open();
      }
    });

    this.addCommand({
      id: "edit-active-markdown-html-tables",
      name: "MinerU: 编辑当前 Markdown 的 HTML 表格",
      checkCallback: (checking) => {
        const activeFile = this.app.workspace.getActiveFile();
        const canRun = Boolean(activeFile && activeFile.extension.toLowerCase() === "md");
        if (canRun && !checking && activeFile) {
          void this.openHtmlTableEditor(activeFile);
        }
        return canRun;
      }
    });

    this.addCommand({
      id: "convert-existing-mineru-html-tables",
      name: "MinerU: 批量将历史 MinerU HTML 表格转为 Markdown",
      callback: () => {
        void this.convertExistingMineruHtmlTables();
      }
    });
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<AnythingToMdSettings> & { mathpixApiKey?: string };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

    if ((!this.settings.mathpixAppId || !this.settings.mathpixAppKey) && raw?.mathpixApiKey) {
      const migrated = splitMathpixCredential(raw.mathpixApiKey);
      if (migrated) {
        this.settings.mathpixAppId = migrated.appId;
        this.settings.mathpixAppKey = migrated.appKey;
        await this.saveSettings();
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private getConvertiblePdfFiles(): TFile[] {
    const manualIgnoreEntries = this.getManualIgnoreEntries();
    return this.app.vault
      .getFiles()
      .filter((file) => file.extension.toLowerCase() === "pdf")
      .filter((file) => !this.isManuallyIgnored(file.path, manualIgnoreEntries))
      .filter((file) => !this.findExistingMarkdownPath(file));
  }

  private async convertPdfQueue(selectedFiles: TFile[], provider: PdfParserProvider): Promise<void> {
    const queue = [...selectedFiles].sort((a, b) => a.path.localeCompare(b.path));
    if (queue.length === 0) {
      return;
    }

    const providerLabel = provider === "mathpix" ? "Mathpix" : "MinerU";

    if (queue.length === 1) {
      await this.convertPdf(queue[0], { provider });
      return;
    }

    const queueNotice = new Notice(`${providerLabel}: 队列准备开始（0/${queue.length}）`, 0);
    const results: ConvertPdfResult[] = [];

    try {
      for (let index = 0; index < queue.length; index += 1) {
        const file = queue[index];
        const result = await this.convertPdf(file, {
          provider,
          queueMode: true,
          queueIndex: index + 1,
          queueTotal: queue.length,
          queueNotice
        });
        results.push(result);
      }
    } finally {
      queueNotice.hide();
    }

    const successCount = results.filter((result) => result.status === "success").length;
    const failedCount = results.filter((result) => result.status === "failed").length;
    const skippedCount = results.filter((result) => result.status === "skipped").length;
    const firstFailure = results.find((result) => result.status === "failed");
    const firstFailureName = firstFailure ? firstFailure.filePath.split("/").pop() ?? firstFailure.filePath : "";
    const failureHint = firstFailure?.message ? `；首个失败：${firstFailureName} - ${firstFailure.message}` : "";

    this.setStatus(`${providerLabel}: 队列完成 ${successCount}/${queue.length}`);
    new Notice(
      `${providerLabel}: 队列完成，成功 ${successCount}，跳过 ${skippedCount}，失败 ${failedCount}${failureHint}`,
      12000
    );
    window.setTimeout(() => this.clearStatus(), 5000);
  }

  private async convertPdf(pdfFile: TFile, options?: ConvertPdfOptions): Promise<ConvertPdfResult> {
    const manualIgnoreEntries = this.getManualIgnoreEntries();
    const queueMode = Boolean(options?.queueMode);
    const provider = options?.provider ?? "mineru";
    const providerLabel = provider === "mathpix" ? "Mathpix" : "MinerU";

    if (this.isManuallyIgnored(pdfFile.path, manualIgnoreEntries)) {
      const message = "该 PDF 命中手动忽略规则，已跳过";
      if (!queueMode) {
        new Notice(`${providerLabel}: ${message}`, 9000);
      }
      return { filePath: pdfFile.path, status: "skipped", message };
    }

    const existingMarkdownPath = this.findExistingMarkdownPath(pdfFile);
    if (existingMarkdownPath) {
      const message = `已存在对应 Markdown，已跳过 → ${existingMarkdownPath}`;
      if (!queueMode) {
        new Notice(`${providerLabel}: ${message}`, 9000);
      }
      return { filePath: pdfFile.path, status: "skipped", message };
    }

    if (provider === "mathpix") {
      return this.convertPdfWithMathpix(pdfFile, options);
    }

    return this.convertPdfWithMineru(pdfFile, options);
  }

  private async convertPdfWithMineru(pdfFile: TFile, options?: ConvertPdfOptions): Promise<ConvertPdfResult> {
    const queueMode = Boolean(options?.queueMode);
    const apiToken = normalizeToken(this.settings.apiToken);
    if (!apiToken) {
      const message = "请先在插件设置中填写 API Token";
      if (!queueMode) {
        new Notice(`MinerU: ${message}`, 9000);
      }
      return { filePath: pdfFile.path, status: "failed", message };
    }

    const notice = options?.queueNotice ?? new Notice("MinerU: 正在创建上传任务…", 0);
    const ownsNotice = !options?.queueNotice;
    this.updateProgressNotice(notice, `正在创建上传任务：${pdfFile.name}`, options);
    this.setStatus(`MinerU: 准备处理 ${pdfFile.name}`);

    try {
      const apiClient = new MineruApiClient({
        apiToken,
        modelVersion: this.settings.modelVersion,
        enableFormula: this.settings.enableFormula,
        enableTable: this.settings.enableTable
      });

      const { batchId, uploadUrl } = await apiClient.requestBatchUploadUrl(pdfFile.name);
      this.updateProgressNotice(notice, `正在上传 PDF：${pdfFile.name}`, options);
      this.setStatus(`MinerU: 上传中 ${pdfFile.name}`);

      const pdfBinary = await this.app.vault.readBinary(pdfFile);
      await apiClient.uploadFile(uploadUrl, pdfBinary);

      this.updateProgressNotice(notice, `上传完成，开始解析：${pdfFile.name}`, options);
      this.setStatus(`MinerU: 解析中 ${pdfFile.name}`);

      const extractResult = await this.pollUntilDone(apiClient, batchId, pdfFile.name, notice, options);
      if (!extractResult.fullZipUrl) {
        throw new Error("解析完成但未返回 full_zip_url");
      }

      this.updateProgressNotice(notice, `正在下载并提取资源：${pdfFile.name}`, options);
      this.setStatus(`MinerU: 下载结果 ${pdfFile.name}`);
      const downloadBundle = await apiClient.downloadExtractionBundle(extractResult.fullZipUrl);
      const tableConversion = this.settings.autoConvertHtmlTablesToMarkdown
        ? convertHtmlTablesToMarkdown(downloadBundle.markdown)
        : { content: downloadBundle.markdown, convertedCount: 0, detectedCount: 0 };
      const latexNormalized = this.settings.enableFormula
        ? normalizeLatexDelimitersForObsidian(tableConversion.content)
        : tableConversion.content;

      const outputDirectory = resolveOutputDirectory({
        overrideDirectory: this.settings.outputDirectoryOverride,
        pdfPath: pdfFile.path,
        vaultName: this.app.vault.getName()
      });
      await ensureFolderExists(this.app.vault, outputDirectory);
      const assetCount = await this.saveAssets(outputDirectory, downloadBundle.assets);

      const outputPath = getUniqueMarkdownPath(this.app.vault, outputDirectory, pdfFile.basename);
      const markdownDoc = buildMarkdownDocument(pdfFile, latexNormalized);
      await this.app.vault.create(outputPath, markdownDoc);

      if (ownsNotice) {
        notice.hide();
      }
      this.setStatus(`MinerU: 已完成 ${pdfFile.name}`);
      const resourceHint = assetCount > 0 ? `（资源 ${assetCount} 个）` : "";
      const tableHint = tableConversion.convertedCount > 0 ? `（表格转换 ${tableConversion.convertedCount} 个）` : "";
      if (!queueMode) {
        new Notice(`MinerU: 转换完成 → ${outputPath}${resourceHint}${tableHint}`, 9000);
      }
      return { filePath: pdfFile.path, status: "success", outputPath, assetCount };
    } catch (error) {
      if (ownsNotice) {
        notice.hide();
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`MinerU: 失败 ${pdfFile.name}`);
      if (!queueMode) {
        new Notice(`MinerU 转换失败：${message}`, 12000);
      }
      console.error("[anything-to-md] conversion failed", error);
      return { filePath: pdfFile.path, status: "failed", message };
    } finally {
      if (ownsNotice) {
        window.setTimeout(() => this.clearStatus(), 3000);
      }
    }
  }

  private async convertPdfWithMathpix(pdfFile: TFile, options?: ConvertPdfOptions): Promise<ConvertPdfResult> {
    const queueMode = Boolean(options?.queueMode);
    const auth = normalizeMathpixAuth(this.settings.mathpixAppId, this.settings.mathpixAppKey);
    if (!auth) {
      const message = "请先在插件设置中填写 MATHPIX_APP_ID 和 MATHPIX_APP_KEY";
      if (!queueMode) {
        new Notice(`Mathpix: ${message}`, 9000);
      }
      return { filePath: pdfFile.path, status: "failed", message };
    }

    const notice = options?.queueNotice ?? new Notice("Mathpix: 正在创建上传任务…", 0);
    const ownsNotice = !options?.queueNotice;
    this.updateProgressNotice(notice, `正在上传 PDF：${pdfFile.name}`, options);
    this.setStatus(`Mathpix: 上传中 ${pdfFile.name}`);

    try {
      const apiClient = new MathpixApiClient({
        appId: auth.appId,
        appKey: auth.appKey
      });
      const pdfBinary = await this.app.vault.readBinary(pdfFile);
      const markdown = await apiClient.convertPdfToMarkdown(pdfFile.name, pdfBinary);

      const outputDirectory = resolveOutputDirectory({
        overrideDirectory: this.settings.outputDirectoryOverride,
        pdfPath: pdfFile.path,
        vaultName: this.app.vault.getName()
      });

      await ensureFolderExists(this.app.vault, outputDirectory);
      const outputPath = getUniqueMarkdownPath(this.app.vault, outputDirectory, pdfFile.basename);
      const markdownDoc = buildMarkdownDocument(pdfFile, markdown);
      await this.app.vault.create(outputPath, markdownDoc);

      if (ownsNotice) {
        notice.hide();
      }
      this.setStatus(`Mathpix: 已完成 ${pdfFile.name}`);
      if (!queueMode) {
        new Notice(`Mathpix: 转换完成 → ${outputPath}`, 9000);
      }
      return { filePath: pdfFile.path, status: "success", outputPath };
    } catch (error) {
      if (ownsNotice) {
        notice.hide();
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Mathpix: 失败 ${pdfFile.name}`);
      if (!queueMode) {
        new Notice(`Mathpix 转换失败：${message}`, 12000);
      }
      console.error("[anything-to-md] mathpix conversion failed", error);
      return { filePath: pdfFile.path, status: "failed", message };
    } finally {
      if (ownsNotice) {
        window.setTimeout(() => this.clearStatus(), 3000);
      }
    }
  }

  private async pollUntilDone(
    apiClient: MineruApiClient,
    batchId: string,
    fileName: string,
    notice: Notice,
    options?: ConvertPdfOptions
  ): Promise<MineruExtractResult> {
    const start = Date.now();

    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const result = await apiClient.getBatchResult(batchId, fileName);
      if (!result) {
        this.updateProgressNotice(notice, `等待任务进入解析队列：${fileName}`, options);
        this.setStatus("MinerU: 等待队列");
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (result.state === "done") {
        return result;
      }
      if (result.state === "failed") {
        throw new Error(result.errMsg || "MinerU 返回 failed");
      }

      const label = mapStateLabel(result.state);
      if (result.progress?.totalPages) {
        const text = `${label}：${result.progress.extractedPages} / ${result.progress.totalPages} 页`;
        this.updateProgressNotice(notice, `${fileName} ${text}`, options);
        this.setStatus(`MinerU: ${text}`);
      } else {
        this.updateProgressNotice(notice, `${fileName} ${label}…`, options);
        this.setStatus(`MinerU: ${label}`);
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error("解析轮询超时，请稍后重试");
  }

  private updateProgressNotice(notice: Notice, message: string, options?: ConvertPdfOptions): void {
    const providerLabel = options?.provider === "mathpix" ? "Mathpix" : "MinerU";
    if (options?.queueMode && options.queueIndex && options.queueTotal) {
      notice.setMessage(`${providerLabel}: [${options.queueIndex}/${options.queueTotal}] ${message}`);
      return;
    }
    notice.setMessage(`${providerLabel}: ${message}`);
  }

  private setStatus(text: string): void {
    this.statusBarEl?.setText(text);
  }

  private clearStatus(): void {
    this.setStatus("Anything to MD: Idle");
  }

  private getManualIgnoreEntries(): string[] {
    return this.settings.manualIgnoreEntries
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^\/+|\/+$/g, ""))
      .map((line) => normalizePath(line));
  }

  private isManuallyIgnored(filePath: string, manualIgnoreEntries: string[]): boolean {
    if (manualIgnoreEntries.length === 0) {
      return false;
    }

    const normalizedPath = normalizePath(filePath);
    const segments = normalizedPath.split("/");
    const fileName = (segments[segments.length - 1] || "").toLowerCase();

    for (const entry of manualIgnoreEntries) {
      const normalizedEntry = normalizePath(entry);
      const lowerEntry = normalizedEntry.toLowerCase();
      if (!lowerEntry) {
        continue;
      }

      if (normalizedEntry.includes("/")) {
        if (
          normalizedPath.toLowerCase() === lowerEntry ||
          normalizedPath.toLowerCase().startsWith(`${lowerEntry}/`)
        ) {
          return true;
        }
        continue;
      }

      if (lowerEntry.endsWith(".pdf")) {
        if (fileName === lowerEntry) {
          return true;
        }
        continue;
      }

      if (segments.some((segment) => segment.toLowerCase() === lowerEntry)) {
        return true;
      }
    }

    return false;
  }

  private findExistingMarkdownPath(pdfFile: TFile): string | undefined {
    for (const candidatePath of this.getCandidateMarkdownPaths(pdfFile)) {
      const existing = this.app.vault.getAbstractFileByPath(candidatePath);
      if (existing instanceof TFile) {
        return candidatePath;
      }
    }
    return undefined;
  }

  private getCandidateMarkdownPaths(pdfFile: TFile): string[] {
    const vaultName = this.app.vault.getName();
    const paths: string[] = [];

    const autoDirectory = resolveOutputDirectory({
      overrideDirectory: "",
      pdfPath: pdfFile.path,
      vaultName
    });
    paths.push(normalizePath(`${autoDirectory}/${pdfFile.basename}.md`));

    const override = this.settings.outputDirectoryOverride.trim();
    if (override) {
      const overrideDirectory = resolveOutputDirectory({
        overrideDirectory: override,
        pdfPath: pdfFile.path,
        vaultName
      });
      const overridePath = normalizePath(`${overrideDirectory}/${pdfFile.basename}.md`);
      if (!paths.includes(overridePath)) {
        paths.push(overridePath);
      }
    }

    return paths;
  }

  private async saveAssets(outputDirectory: string, assets: MineruDownloadedAsset[]): Promise<number> {
    let writtenCount = 0;

    for (const asset of assets) {
      const relativePath = normalizePath(asset.relativePath).replace(/^\/+/, "");
      if (!relativePath || relativePath.startsWith("..") || relativePath.includes("/../")) {
        continue;
      }

      const targetPath = normalizePath(outputDirectory ? `${outputDirectory}/${relativePath}` : relativePath);
      const targetFolder = targetPath.includes("/") ? targetPath.slice(0, targetPath.lastIndexOf("/")) : "";
      if (targetFolder) {
        await ensureFolderExists(this.app.vault, targetFolder);
      }

      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, asset.data);
        writtenCount += 1;
        continue;
      }

      if (existing) {
        throw new Error(`资源文件路径冲突：${targetPath}`);
      }

      await this.app.vault.createBinary(targetPath, asset.data);
      writtenCount += 1;
    }

    return writtenCount;
  }

  private async openHtmlTableEditor(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    if (!hasHtmlTable(content)) {
      new Notice("当前笔记没有 HTML 表格可编辑", 6000);
      return;
    }

    new HtmlTableEditorModal(this.app, file, content, async (nextContent) => {
      await this.app.vault.modify(file, nextContent);
    }).open();
  }

  private async convertExistingMineruHtmlTables(): Promise<void> {
    const markdownFiles = this.app.vault.getMarkdownFiles();
    if (markdownFiles.length === 0) {
      new Notice("Vault 中没有 Markdown 文件", 5000);
      return;
    }

    const progressNotice = new Notice(`MinerU: 正在扫描历史笔记（0/${markdownFiles.length}）`, 0);
    let candidateFiles = 0;
    let convertedFiles = 0;
    let convertedTables = 0;

    try {
      for (let index = 0; index < markdownFiles.length; index += 1) {
        const file = markdownFiles[index];
        if ((index + 1) % 20 === 0 || index === markdownFiles.length - 1) {
          progressNotice.setMessage(`MinerU: 扫描中（${index + 1}/${markdownFiles.length}）`);
        }

        const content = await this.app.vault.cachedRead(file);
        if (!hasHtmlTable(content) || !isLikelyMineruMarkdown(content)) {
          continue;
        }

        candidateFiles += 1;
        const converted = convertHtmlTablesToMarkdown(content);
        if (converted.convertedCount === 0 || converted.content === content) {
          continue;
        }

        await this.app.vault.modify(file, converted.content);
        convertedFiles += 1;
        convertedTables += converted.convertedCount;
      }
    } finally {
      progressNotice.hide();
    }

    if (candidateFiles === 0) {
      new Notice("MinerU: 未找到包含 HTML 表格的历史 MinerU Markdown", 8000);
      return;
    }

    new Notice(`MinerU: 批量转换完成，文件 ${convertedFiles}/${candidateFiles}，表格 ${convertedTables}`, 12000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function mapStateLabel(state: string): string {
  switch (state) {
    case "waiting-file":
      return "等待文件上传";
    case "pending":
      return "排队中";
    case "running":
      return "解析中";
    case "converting":
      return "格式转换中";
    default:
      return state;
  }
}

function normalizeToken(rawToken: string): string {
  return rawToken.trim().replace(/^Bearer\s+/i, "");
}

function normalizeMathpixAuth(rawAppId: string, rawAppKey: string): { appId: string; appKey: string } | undefined {
  const appId = rawAppId.trim();
  const appKey = rawAppKey.trim();
  if (!appId || !appKey) {
    return undefined;
  }
  return { appId, appKey };
}

function splitMathpixCredential(raw: string): { appId: string; appKey: string } | undefined {
  const normalized = raw.trim();
  for (const delimiter of [":", "|"]) {
    const index = normalized.indexOf(delimiter);
    if (index > 0 && index < normalized.length - 1) {
      return {
        appId: normalized.slice(0, index).trim(),
        appKey: normalized.slice(index + 1).trim()
      };
    }
  }
  return undefined;
}

function normalizeLatexDelimitersForObsidian(markdown: string): string {
  return markdown
    .replace(/\\\[((?:.|\n)*?)\\\]/g, (_match, content: string) => {
      const body = content.trim();
      return body ? `$$${body}$$` : _match;
    })
    .replace(/\\\(((?:.|\n)*?)\\\)/g, (_match, content: string) => {
      const body = content.trim();
      return body ? `$${body}$` : _match;
    });
}
