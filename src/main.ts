import { normalizePath, Notice, Plugin, TFile } from "obsidian";

import {
  buildMarkdownDocument,
  ensureFolderExists,
  getUniqueMarkdownPath,
  resolveOutputDirectory
} from "./markdown";
import { MineruApiClient, MineruExtractResult } from "./mineru-api";
import { PdfSelectModal } from "./modal";
import { AnythingToMdSettingTab, AnythingToMdSettings, DEFAULT_SETTINGS } from "./settings";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

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
      name: "MinerU: Convert PDF to Markdown",
      callback: () => {
        const pdfFiles = this.getConvertiblePdfFiles();
        if (pdfFiles.length === 0) {
          new Notice("没有可转换的 PDF（Figures 与已转换文件已过滤）", 9000);
          return;
        }

        new PdfSelectModal(this.app, pdfFiles, (file) => {
          void this.convertPdf(file);
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
    return this.app.vault
      .getFiles()
      .filter((file) => file.extension.toLowerCase() === "pdf")
      .filter((file) => !this.isInFiguresFolder(file.path))
      .filter((file) => !this.findExistingMarkdownPath(file));
  }

  private async convertPdf(pdfFile: TFile): Promise<void> {
    const apiToken = normalizeToken(this.settings.apiToken);
    if (!apiToken) {
      new Notice("请先在插件设置中填写 API Token", 9000);
      return;
    }

    const notice = new Notice(`正在创建上传任务：${pdfFile.name}`, 0);
    this.setStatus(`转换中：${pdfFile.name}`);

    try {
      const apiClient = new MineruApiClient({
        apiToken,
        modelVersion: this.settings.modelVersion,
        enableFormula: this.settings.enableFormula,
        enableTable: this.settings.enableTable
      });

      const { batchId, uploadUrl } = await apiClient.requestBatchUploadUrl(pdfFile.name);

      notice.setMessage(`正在上传 PDF：${pdfFile.name}`);
      const pdfBinary = await this.app.vault.readBinary(pdfFile);
      await apiClient.uploadFile(uploadUrl, pdfBinary);

      notice.setMessage(`上传完成，等待解析：${pdfFile.name}`);
      const extractResult = await this.pollUntilDone(apiClient, batchId, pdfFile.name, notice);
      if (!extractResult.fullZipUrl) {
        throw new Error("解析完成但未返回 full_zip_url");
      }

      notice.setMessage(`正在下载结果：${pdfFile.name}`);
      const markdownBody = await apiClient.downloadMarkdownFromZip(extractResult.fullZipUrl);

      const outputDirectory = resolveOutputDirectory({
        overrideDirectory: this.settings.outputDirectoryOverride,
        pdfPath: pdfFile.path,
        vaultName: this.app.vault.getName()
      });
      await ensureFolderExists(this.app.vault, outputDirectory);

      const outputPath = getUniqueMarkdownPath(this.app.vault, outputDirectory, pdfFile.basename);
      const markdownDoc = buildMarkdownDocument(pdfFile, markdownBody);
      await this.app.vault.create(outputPath, markdownDoc);

      notice.hide();
      this.setStatus(`转换完成：${pdfFile.name}`);
      new Notice(`转换完成 → ${outputPath}`, 9000);
    } catch (error) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`转换失败：${pdfFile.name}`);
      new Notice(`MinerU 转换失败：${message}`, 12000);
      console.error("[anything-to-md] conversion failed", error);
    } finally {
      window.setTimeout(() => this.clearStatus(), 3000);
    }
  }

  private async pollUntilDone(
    apiClient: MineruApiClient,
    batchId: string,
    fileName: string,
    notice: Notice
  ): Promise<MineruExtractResult> {
    const start = Date.now();

    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const result = await apiClient.getBatchResult(batchId, fileName);
      if (!result) {
        notice.setMessage(`等待任务进入解析队列：${fileName}`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (result.state === "done") {
        return result;
      }
      if (result.state === "failed") {
        throw new Error(result.errMsg || "MinerU 返回 failed");
      }

      if (result.progress?.totalPages) {
        notice.setMessage(`${mapStateLabel(result.state)}：${result.progress.extractedPages} / ${result.progress.totalPages} 页`);
      } else {
        notice.setMessage(`${mapStateLabel(result.state)}：${fileName}`);
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

  private isInFiguresFolder(filePath: string): boolean {
    return filePath
      .split("/")
      .some((segment) => segment.trim().toLowerCase() === "figures");
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
