import { normalizePath, Notice, Plugin, TFile } from "obsidian";

import {
  buildMarkdownDocument,
  ensureFolderExists,
  getUniqueMarkdownPath,
  resolveOutputDirectory
} from "./markdown";
import { MineruApiClient, MineruDownloadedAsset, MineruExtractResult } from "./mineru-api";
import { PdfQueueModal } from "./modal";
import { AnythingToMdSettingTab, AnythingToMdSettings, DEFAULT_SETTINGS } from "./settings";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

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
      name: "MinerU: Convert PDFs to Markdown (Queue)",
      callback: () => {
        const convertiblePdfFiles = this.getConvertiblePdfFiles();
        if (convertiblePdfFiles.length === 0) {
          new Notice("没有可转换的 PDF（手动忽略项与已转换文件已过滤）", 9000);
          return;
        }

        new PdfQueueModal(this.app, convertiblePdfFiles, (selectedFiles) => {
          void this.convertPdfQueue(selectedFiles);
        }).open();
      }
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

  private async convertPdfQueue(selectedFiles: TFile[]): Promise<void> {
    const queue = [...selectedFiles].sort((a, b) => a.path.localeCompare(b.path));
    if (queue.length === 0) {
      return;
    }

    if (queue.length === 1) {
      await this.convertPdf(queue[0], false, 1, 1);
      return;
    }

    const queueNotice = new Notice(`MinerU: 队列准备开始（0/${queue.length}）`, 0);
    const results: ConvertPdfResult[] = [];

    try {
      for (let index = 0; index < queue.length; index += 1) {
        const file = queue[index];
        const result = await this.convertPdf(file, true, index + 1, queue.length, queueNotice);
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

    this.setStatus(`MinerU: 队列完成 ${successCount}/${queue.length}`);
    new Notice(
      `MinerU: 队列完成，成功 ${successCount}，跳过 ${skippedCount}，失败 ${failedCount}${failureHint}`,
      12000
    );
    window.setTimeout(() => this.clearStatus(), 5000);
  }

  private async convertPdf(
    pdfFile: TFile,
    queueMode: boolean,
    queueIndex: number,
    queueTotal: number,
    queueNotice?: Notice
  ): Promise<ConvertPdfResult> {
    const manualIgnoreEntries = this.getManualIgnoreEntries();
    if (this.isManuallyIgnored(pdfFile.path, manualIgnoreEntries)) {
      const message = "该 PDF 命中手动忽略规则，已跳过";
      if (!queueMode) {
        new Notice(`MinerU: ${message}`, 9000);
      }
      return { filePath: pdfFile.path, status: "skipped", message };
    }

    const existingMarkdownPath = this.findExistingMarkdownPath(pdfFile);
    if (existingMarkdownPath) {
      const message = `已存在对应 Markdown，已跳过 → ${existingMarkdownPath}`;
      if (!queueMode) {
        new Notice(`MinerU: ${message}`, 9000);
      }
      return { filePath: pdfFile.path, status: "skipped", message };
    }

    const apiToken = normalizeToken(this.settings.apiToken);
    if (!apiToken) {
      const message = "请先在插件设置中填写 API Token";
      if (!queueMode) {
        new Notice(`MinerU: ${message}`, 9000);
      }
      return { filePath: pdfFile.path, status: "failed", message };
    }

    const notice = queueNotice ?? new Notice("MinerU: 正在创建上传任务…", 0);
    const ownsNotice = !queueNotice;
    this.updateProgressNotice(notice, `正在创建上传任务：${pdfFile.name}`, queueMode, queueIndex, queueTotal);
    this.setStatus(`MinerU: 准备处理 ${pdfFile.name}`);

    try {
      const apiClient = new MineruApiClient({
        apiToken,
        modelVersion: this.settings.modelVersion,
        enableFormula: this.settings.enableFormula,
        enableTable: this.settings.enableTable
      });

      const { batchId, uploadUrl } = await apiClient.requestBatchUploadUrl(pdfFile.name);

      this.updateProgressNotice(notice, `正在上传 PDF：${pdfFile.name}`, queueMode, queueIndex, queueTotal);
      this.setStatus(`MinerU: 上传中 ${pdfFile.name}`);

      const pdfBinary = await this.app.vault.readBinary(pdfFile);
      await apiClient.uploadFile(uploadUrl, pdfBinary);

      this.updateProgressNotice(notice, `上传完成，开始解析：${pdfFile.name}`, queueMode, queueIndex, queueTotal);
      this.setStatus(`MinerU: 解析中 ${pdfFile.name}`);

      const extractResult = await this.pollUntilDone(apiClient, batchId, pdfFile.name, notice, queueMode, queueIndex, queueTotal);
      if (!extractResult.fullZipUrl) {
        throw new Error("解析完成但未返回 full_zip_url");
      }

      this.updateProgressNotice(notice, `正在下载并提取资源：${pdfFile.name}`, queueMode, queueIndex, queueTotal);
      this.setStatus(`MinerU: 下载结果 ${pdfFile.name}`);
      const downloadBundle = await apiClient.downloadExtractionBundle(extractResult.fullZipUrl);

      const outputDirectory = resolveOutputDirectory({
        overrideDirectory: this.settings.outputDirectoryOverride,
        pdfPath: pdfFile.path,
        vaultName: this.app.vault.getName()
      });
      await ensureFolderExists(this.app.vault, outputDirectory);
      const assetCount = await this.saveAssets(outputDirectory, downloadBundle.assets);

      const outputPath = getUniqueMarkdownPath(this.app.vault, outputDirectory, pdfFile.basename);
      const markdownDoc = buildMarkdownDocument(pdfFile, downloadBundle.markdown);
      await this.app.vault.create(outputPath, markdownDoc);

      if (ownsNotice) {
        notice.hide();
      }
      this.setStatus(`MinerU: 已完成 ${pdfFile.name}`);
      const resourceHint = assetCount > 0 ? `（资源 ${assetCount} 个）` : "";
      if (!queueMode) {
        new Notice(`MinerU: 转换完成 → ${outputPath}${resourceHint}`, 9000);
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
      console.error("[anything-to-md] conversion failed", error);
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

  private updateProgressNotice(
    notice: Notice,
    message: string,
    queueMode: boolean,
    queueIndex: number,
    queueTotal: number
  ): void {
    if (queueMode) {
      notice.setMessage(`MinerU: [${queueIndex}/${queueTotal}] ${message}`);
      return;
    }
    notice.setMessage(`MinerU: ${message}`);
  }

  private async pollUntilDone(
    apiClient: MineruApiClient,
    batchId: string,
    fileName: string,
    notice: Notice,
    queueMode: boolean,
    queueIndex: number,
    queueTotal: number
  ): Promise<MineruExtractResult> {
    const start = Date.now();

    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const result = await apiClient.getBatchResult(batchId, fileName);
      if (!result) {
        this.updateProgressNotice(notice, `等待任务进入解析队列：${fileName}`, queueMode, queueIndex, queueTotal);
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
        this.updateProgressNotice(notice, `${fileName} ${text}`, queueMode, queueIndex, queueTotal);
        this.setStatus(`MinerU: ${text}`);
      } else {
        this.updateProgressNotice(notice, `${fileName} ${label}…`, queueMode, queueIndex, queueTotal);
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
