import { FileSystemAdapter, Modal, normalizePath, Notice, Plugin, TFile } from "obsidian";
import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";

import {
  buildMarkdownDocument,
  buildMarkdownDocumentWithSource,
  ensureFolderExists,
  getUniqueMarkdownPath,
  resolveOutputDirectory
} from "./markdown";
import { FileQueueModal, PdfParserProvider } from "./modal";
import { MathpixApiClient } from "./mathpix-api";
import { MineruApiClient, MineruDownloadedAsset, MineruExtractResult } from "./mineru-api";
import { DEFAULT_SETTINGS, MineruPluginSettings, MineruSettingTab } from "./settings";
import { HtmlTableEditorModal } from "./table-editor-modal";
import { applyMarkdownTableHealthChecks, convertHtmlTablesToMarkdown, hasHtmlTable, isLikelyMineruMarkdown } from "./table-tools";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const execFileAsync = promisify(execFile);

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

interface ConvertTexOptions {
  pandocCommand: string;
  queueMode?: boolean;
  queueIndex?: number;
  queueTotal?: number;
  queueNotice?: Notice;
}

interface ConvertTexResult {
  filePath: string;
  status: "success" | "failed" | "skipped";
  outputPath?: string;
  message?: string;
}

interface PandocInstallCommand {
  label: string;
  command: string;
  args: string[];
}

interface FolderColumnDropRule {
  pathPattern: string;
  pathPatternLower: string;
  columnNames: string[];
}

export default class MineruPdfConverterPlugin extends Plugin {
  settings: MineruPluginSettings = DEFAULT_SETTINGS;
  private statusBarEl?: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new MineruSettingTab(this.app, this));
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

        new FileQueueModal<PdfParserProvider>(this.app, convertiblePdfFiles, {
          title: "选择要转换的 PDF（队列模式）",
          searchName: "搜索 PDF",
          searchDesc: "按文件名或路径筛选",
          emptyText: "当前没有可转换 PDF",
          emptyTextNoMatch: "没有匹配的 PDF",
          providerName: "解析方式",
          providerDesc: "本次队列统一使用该方式解析",
          providerOptions: [
            { id: "mineru", label: "MinerU" },
            { id: "mathpix", label: "Mathpix" }
          ],
          defaultProvider: "mineru",
          startButtonLabel: (provider) => (provider === "mathpix" ? "开始队列转换（Mathpix）" : "开始队列转换（MinerU）"),
          onSubmit: (selectedFiles, provider) => {
            void this.convertPdfQueue(selectedFiles, provider ?? "mineru");
          }
        }).open();
      }
    });

    this.addCommand({
      id: "convert-tex-to-markdown",
      name: "Convert TeX to Markdown (Queue)",
      callback: () => {
        const convertibleTexFiles = this.getConvertibleTexFiles();
        if (convertibleTexFiles.length === 0) {
          new Notice("没有可转换的 TeX（手动忽略项与已转换文件已过滤）", 9000);
          return;
        }

        new FileQueueModal(this.app, convertibleTexFiles, {
          title: "选择要转换的 TeX（队列模式）",
          searchName: "搜索 TeX",
          searchDesc: "按文件名或路径筛选",
          emptyText: "当前没有可转换 TeX",
          emptyTextNoMatch: "没有匹配的 TeX",
          startButtonLabel: () => "开始队列转换（Pandoc）",
          onSubmit: (selectedFiles) => {
            void this.convertTexQueue(selectedFiles);
          }
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

  onunload(): void {
    this.clearStatus();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<MineruPluginSettings> & { mathpixApiKey?: string };
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
      .filter((file) => this.canConvertFile(file, manualIgnoreEntries));
  }

  private getConvertibleTexFiles(): TFile[] {
    const manualIgnoreEntries = this.getManualIgnoreEntries();
    return this.app.vault
      .getFiles()
      .filter((file) => file.extension.toLowerCase() === "tex")
      .filter((file) => this.canConvertFile(file, manualIgnoreEntries));
  }

  private canConvertFile(file: TFile, manualIgnoreEntries: string[]): boolean {
    return !this.isManuallyIgnored(file.path, manualIgnoreEntries) && !this.findExistingMarkdownPath(file);
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
    const failureHint = firstFailure?.message
      ? `；首个失败：${firstFailureName} - ${firstFailure.message}`
      : "";

    this.setStatus(`${providerLabel}: 队列完成 ${successCount}/${queue.length}`);
    new Notice(
      `${providerLabel}: 队列完成，成功 ${successCount}，跳过 ${skippedCount}，失败 ${failedCount}${failureHint}`,
      12000
    );
    window.setTimeout(() => this.clearStatus(), 5000);
  }

  private async convertTexQueue(selectedFiles: TFile[]): Promise<void> {
    const queue = [...selectedFiles].sort((a, b) => a.path.localeCompare(b.path));
    if (queue.length === 0) {
      return;
    }

    const pandocCommand = await this.ensurePandocAvailable();
    if (!pandocCommand) {
      return;
    }

    if (queue.length === 1) {
      await this.convertTex(queue[0], { pandocCommand });
      return;
    }

    const queueNotice = new Notice(`Pandoc: 队列准备开始（0/${queue.length}）`, 0);
    const results: ConvertTexResult[] = [];

    try {
      for (let index = 0; index < queue.length; index += 1) {
        const file = queue[index];
        const result = await this.convertTex(file, {
          pandocCommand,
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

    this.setStatus(`Pandoc: 队列完成 ${successCount}/${queue.length}`);
    new Notice(
      `Pandoc: 队列完成，成功 ${successCount}，跳过 ${skippedCount}，失败 ${failedCount}${failureHint}`,
      12000
    );
    window.setTimeout(() => this.clearStatus(), 5000);
  }

  private updateProgressNotice(notice: Notice, message: string, options?: ConvertPdfOptions): void {
    const providerLabel = options?.provider === "mathpix" ? "Mathpix" : "MinerU";
    if (options?.queueMode && options.queueIndex && options.queueTotal) {
      notice.setMessage(`${providerLabel}: [${options.queueIndex}/${options.queueTotal}] ${message}`);
      return;
    }
    notice.setMessage(`${providerLabel}: ${message}`);
  }

  private updateTexProgressNotice(notice: Notice, message: string, options?: ConvertTexOptions): void {
    if (options?.queueMode && options.queueIndex && options.queueTotal) {
      notice.setMessage(`Pandoc: [${options.queueIndex}/${options.queueTotal}] ${message}`);
      return;
    }
    notice.setMessage(`Pandoc: ${message}`);
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
      return {
        filePath: pdfFile.path,
        status: "skipped",
        message
      };
    }

    const existingMarkdownPath = this.findExistingMarkdownPath(pdfFile);
    if (existingMarkdownPath) {
      const message = `已存在对应 Markdown，已跳过 → ${existingMarkdownPath}`;
      if (!queueMode) {
        new Notice(`${providerLabel}: ${message}`, 9000);
      }
      return {
        filePath: pdfFile.path,
        status: "skipped",
        message
      };
    }

    if (provider === "mathpix") {
      return this.convertPdfWithMathpix(pdfFile, options);
    }

    return this.convertPdfWithMineru(pdfFile, options);
  }

  private async convertTex(texFile: TFile, options: ConvertTexOptions): Promise<ConvertTexResult> {
    const manualIgnoreEntries = this.getManualIgnoreEntries();
    const queueMode = Boolean(options?.queueMode);

    if (this.isManuallyIgnored(texFile.path, manualIgnoreEntries)) {
      const message = "该 TeX 命中手动忽略规则，已跳过";
      if (!queueMode) {
        new Notice(`Pandoc: ${message}`, 9000);
      }
      return {
        filePath: texFile.path,
        status: "skipped",
        message
      };
    }

    const existingMarkdownPath = this.findExistingMarkdownPath(texFile);
    if (existingMarkdownPath) {
      const message = `已存在对应 Markdown，已跳过 → ${existingMarkdownPath}`;
      if (!queueMode) {
        new Notice(`Pandoc: ${message}`, 9000);
      }
      return {
        filePath: texFile.path,
        status: "skipped",
        message
      };
    }

    const notice = options.queueNotice ?? new Notice("Pandoc: 正在准备转换…", 0);
    const ownsNotice = !options.queueNotice;
    this.updateTexProgressNotice(notice, `正在读取 TeX：${texFile.name}`, options);
    this.setStatus(`Pandoc: 准备处理 ${texFile.name}`);

    try {
      const outputDirectory = resolveOutputDirectory({
        overrideDirectory: this.settings.outputDirectoryOverride,
        pdfPath: texFile.path,
        vaultName: this.app.vault.getName()
      });

      await ensureFolderExists(this.app.vault, outputDirectory);
      const outputPath = getUniqueMarkdownPath(this.app.vault, outputDirectory, texFile.basename);

      this.updateTexProgressNotice(notice, `正在执行 Pandoc：${texFile.name}`, options);
      this.setStatus(`Pandoc: 转换中 ${texFile.name}`);
      const markdownBody = await this.runPandocToMarkdown(texFile, options.pandocCommand);
      const markdownDoc = buildMarkdownDocumentWithSource(texFile, markdownBody, "source_tex");
      await this.app.vault.create(outputPath, markdownDoc);

      if (ownsNotice) {
        notice.hide();
      }
      this.setStatus(`Pandoc: 已完成 ${texFile.name}`);
      if (!queueMode) {
        new Notice(`Pandoc: 转换完成 → ${outputPath}`, 9000);
      }
      return {
        filePath: texFile.path,
        status: "success",
        outputPath
      };
    } catch (error) {
      if (ownsNotice) {
        notice.hide();
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Pandoc: 失败 ${texFile.name}`);
      if (!queueMode) {
        new Notice(`Pandoc 转换失败：${message}`, 12000);
      }
      console.error("[mineru-pdf-converter] pandoc conversion failed", error);
      return {
        filePath: texFile.path,
        status: "failed",
        message
      };
    } finally {
      if (ownsNotice) {
        window.setTimeout(() => this.clearStatus(), 3000);
      }
    }
  }

  private async convertPdfWithMineru(pdfFile: TFile, options?: ConvertPdfOptions): Promise<ConvertPdfResult> {
    const queueMode = Boolean(options?.queueMode);
    const apiToken = normalizeToken(this.settings.apiToken);
    if (!apiToken) {
      const message = "请先在插件设置中填写 API Token";
      if (!queueMode) {
        new Notice(`MinerU: ${message}`, 9000);
      }
      return {
        filePath: pdfFile.path,
        status: "failed",
        message
      };
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
      const tableHealth = this.settings.enableMarkdownTableHealthCheck
        ? applyMarkdownTableHealthChecks(tableConversion.content, {
            dropColumnNames: this.getDropColumnNamesForPath(pdfFile.path)
          })
        : { content: tableConversion.content, touchedTableCount: 0, removedRowCount: 0, removedColumnCount: 0 };
      const latexNormalized = this.settings.enableFormula
        ? normalizeLatexDelimitersForObsidian(tableHealth.content)
        : tableHealth.content;

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
      const healthHint =
        tableHealth.removedRowCount > 0 || tableHealth.removedColumnCount > 0
          ? `（表格清理：空行 ${tableHealth.removedRowCount}，列 ${tableHealth.removedColumnCount}）`
          : "";
      if (!queueMode) {
        new Notice(`MinerU: 转换完成 → ${outputPath}${resourceHint}${tableHint}${healthHint}`, 9000);
      }
      return {
        filePath: pdfFile.path,
        status: "success",
        outputPath,
        assetCount
      };
    } catch (error) {
      if (ownsNotice) {
        notice.hide();
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`MinerU: 失败 ${pdfFile.name}`);
      if (!queueMode) {
        new Notice(`MinerU 转换失败：${message}`, 12000);
      }
      console.error("[mineru-pdf-converter] conversion failed", error);
      return {
        filePath: pdfFile.path,
        status: "failed",
        message
      };
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
      return {
        filePath: pdfFile.path,
        status: "failed",
        message
      };
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
      const tableHealth = this.settings.enableMarkdownTableHealthCheck
        ? applyMarkdownTableHealthChecks(markdown, {
            dropColumnNames: this.getDropColumnNamesForPath(pdfFile.path)
          })
        : { content: markdown, touchedTableCount: 0, removedRowCount: 0, removedColumnCount: 0 };

      const outputDirectory = resolveOutputDirectory({
        overrideDirectory: this.settings.outputDirectoryOverride,
        pdfPath: pdfFile.path,
        vaultName: this.app.vault.getName()
      });

      await ensureFolderExists(this.app.vault, outputDirectory);
      const outputPath = getUniqueMarkdownPath(this.app.vault, outputDirectory, pdfFile.basename);
      const markdownDoc = buildMarkdownDocument(pdfFile, tableHealth.content);
      await this.app.vault.create(outputPath, markdownDoc);

      if (ownsNotice) {
        notice.hide();
      }
      this.setStatus(`Mathpix: 已完成 ${pdfFile.name}`);
      const healthHint =
        tableHealth.removedRowCount > 0 || tableHealth.removedColumnCount > 0
          ? `（表格清理：空行 ${tableHealth.removedRowCount}，列 ${tableHealth.removedColumnCount}）`
          : "";
      if (!queueMode) {
        new Notice(`Mathpix: 转换完成 → ${outputPath}${healthHint}`, 9000);
      }
      return {
        filePath: pdfFile.path,
        status: "success",
        outputPath
      };
    } catch (error) {
      if (ownsNotice) {
        notice.hide();
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Mathpix: 失败 ${pdfFile.name}`);
      if (!queueMode) {
        new Notice(`Mathpix 转换失败：${message}`, 12000);
      }
      console.error("[mineru-pdf-converter] mathpix conversion failed", error);
      return {
        filePath: pdfFile.path,
        status: "failed",
        message
      };
    } finally {
      if (ownsNotice) {
        window.setTimeout(() => this.clearStatus(), 3000);
      }
    }
  }

  private async ensurePandocAvailable(): Promise<string | undefined> {
    const command = this.getPandocCommand();
    const check = await this.checkPandocAvailable(command);
    if (check.available) {
      return command;
    }

    if (!check.missing) {
      new Notice(`Pandoc 启动失败：${check.error ?? "未知错误"}`, 12000);
      return undefined;
    }

    const confirmed = await this.confirmPandocInstall();
    if (!confirmed) {
      new Notice("Pandoc 未安装，已取消转换", 9000);
      return undefined;
    }

    const installResult = await this.installPandoc();
    if (!installResult.success) {
      new Notice(`Pandoc 安装失败：${installResult.message ?? "未知错误"}`, 12000);
      return undefined;
    }

    const postCheck = await this.checkPandocAvailable(command);
    if (!postCheck.available) {
      const hint = this.settings.pandocPath?.trim() ? "，请检查设置中的 Pandoc 路径" : "";
      new Notice(`Pandoc 安装完成但仍未检测到命令：${command}${hint}`, 12000);
      return undefined;
    }

    return command;
  }

  private getPandocCommand(): string {
    const configured = this.settings.pandocPath?.trim();
    return configured ? configured : "pandoc";
  }

  private async checkPandocAvailable(
    command: string
  ): Promise<{ available: boolean; missing?: boolean; error?: string }> {
    try {
      await execFileAsync(command, ["--version"], { windowsHide: true });
      return { available: true };
    } catch (error) {
      if (isCommandNotFound(error)) {
        return { available: false, missing: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, error: message };
    }
  }

  private confirmPandocInstall(): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false;
      const modal = new Modal(this.app);
      modal.onOpen = () => {
        const { contentEl } = modal;
        contentEl.empty();
        contentEl.createEl("h2", { text: "未检测到 Pandoc" });
        contentEl.createEl("p", {
          text: "TeX 转 Markdown 需要 Pandoc。是否现在尝试自动安装？"
        });

        const actionsEl = contentEl.createDiv({ cls: "mineru-confirm-actions" });
        const cancelButton = actionsEl.createEl("button", { text: "取消" });
        cancelButton.addEventListener("click", () => {
          resolved = true;
          modal.close();
          resolve(false);
        });

        const installButton = actionsEl.createEl("button", { text: "安装 Pandoc" });
        installButton.addClass("mod-cta");
        installButton.addEventListener("click", () => {
          resolved = true;
          modal.close();
          resolve(true);
        });
      };
      modal.onClose = () => {
        if (!resolved) {
          resolve(false);
        }
      };
      modal.open();
    });
  }

  private async installPandoc(): Promise<{ success: boolean; message?: string }> {
    const installCommand = await this.resolvePandocInstallCommand();
    if (!installCommand) {
      return {
        success: false,
        message: "未找到可用的自动安装方式，请手动安装 Pandoc 后重试。"
      };
    }

    const notice = new Notice(`Pandoc: 正在安装（${installCommand.label}）…`, 0);
    this.setStatus("Pandoc: 安装中");
    try {
      await execFileAsync(installCommand.command, installCommand.args, {
        windowsHide: true,
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[mineru-pdf-converter] pandoc install failed", error);
      return { success: false, message };
    } finally {
      notice.hide();
      window.setTimeout(() => this.clearStatus(), 3000);
    }
  }

  private async resolvePandocInstallCommand(): Promise<PandocInstallCommand | undefined> {
    if (process.platform === "darwin") {
      if (await this.commandExists("brew")) {
        return {
          label: "brew install pandoc",
          command: "brew",
          args: ["install", "pandoc"]
        };
      }
      return undefined;
    }

    if (process.platform === "win32") {
      if (await this.commandExists("winget")) {
        return {
          label: "winget install pandoc",
          command: "winget",
          args: ["install", "--id", "JohnMacFarlane.Pandoc", "-e"]
        };
      }
      if (await this.commandExists("choco")) {
        return {
          label: "choco install pandoc",
          command: "choco",
          args: ["install", "pandoc", "-y"]
        };
      }
      if (await this.commandExists("scoop")) {
        return {
          label: "scoop install pandoc",
          command: "scoop",
          args: ["install", "pandoc"]
        };
      }
      return undefined;
    }

    if (process.platform === "linux") {
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      const hasSudo = !isRoot && (await this.commandExists("sudo"));
      const sudoPrefix = hasSudo ? ["-n"] : [];

      if (await this.commandExists("apt-get")) {
        return hasSudo
          ? {
              label: "sudo apt-get install pandoc",
              command: "sudo",
              args: [...sudoPrefix, "apt-get", "install", "-y", "pandoc"]
            }
          : {
              label: "apt-get install pandoc",
              command: "apt-get",
              args: ["install", "-y", "pandoc"]
            };
      }
      if (await this.commandExists("dnf")) {
        return hasSudo
          ? {
              label: "sudo dnf install pandoc",
              command: "sudo",
              args: [...sudoPrefix, "dnf", "install", "-y", "pandoc"]
            }
          : {
              label: "dnf install pandoc",
              command: "dnf",
              args: ["install", "-y", "pandoc"]
            };
      }
      if (await this.commandExists("pacman")) {
        return hasSudo
          ? {
              label: "sudo pacman -S pandoc",
              command: "sudo",
              args: [...sudoPrefix, "pacman", "-S", "--noconfirm", "pandoc"]
            }
          : {
              label: "pacman -S pandoc",
              command: "pacman",
              args: ["-S", "--noconfirm", "pandoc"]
            };
      }
      if (await this.commandExists("zypper")) {
        return hasSudo
          ? {
              label: "sudo zypper install pandoc",
              command: "sudo",
              args: [...sudoPrefix, "zypper", "--non-interactive", "install", "pandoc"]
            }
          : {
              label: "zypper install pandoc",
              command: "zypper",
              args: ["--non-interactive", "install", "pandoc"]
            };
      }
    }

    return undefined;
  }

  private async commandExists(command: string): Promise<boolean> {
    try {
      await execFileAsync(command, ["--version"], { windowsHide: true });
      return true;
    } catch (error) {
      return !isCommandNotFound(error);
    }
  }

  private async runPandocToMarkdown(texFile: TFile, pandocCommand: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("当前 vault 不支持本地文件系统路径");
    }

    const texFullPath = adapter.getFullPath(texFile.path);
    const workingDir = path.dirname(texFullPath);
    const args = ["--from=latex", "--to=markdown", "--wrap=preserve", texFullPath];

    const result = await execFileAsync(pandocCommand, args, {
      cwd: workingDir,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    });

    if (result.stderr && result.stderr.trim()) {
      console.warn("[mineru-pdf-converter] pandoc warnings", result.stderr);
    }

    return result.stdout ?? "";
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

  private setStatus(text: string): void {
    this.statusBarEl?.setText(text);
  }

  private clearStatus(): void {
    this.setStatus("MD Converter: Idle");
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
    let removedRows = 0;
    let removedColumns = 0;

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
        const tableHealth = this.settings.enableMarkdownTableHealthCheck
          ? applyMarkdownTableHealthChecks(converted.content, {
              dropColumnNames: this.getDropColumnNamesForPath(file.path)
            })
          : { content: converted.content, touchedTableCount: 0, removedRowCount: 0, removedColumnCount: 0 };
        if (converted.convertedCount === 0 && tableHealth.touchedTableCount === 0) {
          continue;
        }

        if (tableHealth.content === content) {
          continue;
        }

        await this.app.vault.modify(file, tableHealth.content);
        convertedFiles += 1;
        convertedTables += converted.convertedCount;
        removedRows += tableHealth.removedRowCount;
        removedColumns += tableHealth.removedColumnCount;
      }
    } finally {
      progressNotice.hide();
    }

    if (candidateFiles === 0) {
      new Notice("MinerU: 未找到包含 HTML 表格的历史 MinerU Markdown", 8000);
      return;
    }

    new Notice(
      `MinerU: 批量转换完成，文件 ${convertedFiles}/${candidateFiles}，表格 ${convertedTables}，清理空行 ${removedRows}，清理列 ${removedColumns}`,
      12000
    );
  }

  private getDropColumnNamesForPath(filePath: string): string[] {
    const rules = this.getFolderColumnDropRules();
    if (rules.length === 0) {
      return [];
    }

    const normalizedPath = normalizePath(filePath).toLowerCase();
    const segments = normalizedPath.split("/");
    const resolved: string[] = [];
    const seen = new Set<string>();

    for (const rule of rules) {
      const matched = rule.pathPattern.includes("/")
        ? normalizedPath === rule.pathPatternLower || normalizedPath.startsWith(`${rule.pathPatternLower}/`)
        : segments.includes(rule.pathPatternLower);

      if (!matched) {
        continue;
      }

      for (const name of rule.columnNames) {
        const key = name.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        resolved.push(name);
      }
    }

    return resolved;
  }

  private getFolderColumnDropRules(): FolderColumnDropRule[] {
    return this.settings.folderColumnDropRules
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const parts = line.split("=>");
        if (parts.length < 2) {
          return undefined;
        }
        const rawPathPattern = normalizePath(parts[0].trim().replace(/^\/+|\/+$/g, ""));
        const columnNames = parts
          .slice(1)
          .join("=>")
          .split(/[，,]/)
          .map((name) => name.trim())
          .filter((name) => name.length > 0);

        if (!rawPathPattern || columnNames.length === 0) {
          return undefined;
        }

        return {
          pathPattern: rawPathPattern,
          pathPatternLower: rawPathPattern.toLowerCase(),
          columnNames
        };
      })
      .filter((rule): rule is FolderColumnDropRule => Boolean(rule));
  }
}

function isCommandNotFound(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  return false;
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
