import JSZip from "jszip";
import { requestUrl } from "obsidian";

import type { MineruModelVersion } from "./settings";

const MINERU_API_BASE = "https://mineru.net/api/v4";

type MineruTaskState = "waiting-file" | "pending" | "running" | "converting" | "done" | "failed";

interface MineruApiEnvelope<T> {
  code: number;
  msg: string;
  trace_id?: string;
  data: T;
}

interface BatchUploadData {
  batch_id: string;
  file_urls: string[];
}

interface BatchExtractProgress {
  extracted_pages: number;
  total_pages: number;
}

interface BatchExtractResultRaw {
  file_name: string;
  state: MineruTaskState;
  full_zip_url?: string;
  err_msg?: string;
  extract_progress?: BatchExtractProgress;
}

interface BatchExtractData {
  batch_id: string;
  extract_result?: BatchExtractResultRaw[];
}

export interface MineruApiClientOptions {
  apiToken: string;
  modelVersion: MineruModelVersion;
  enableFormula: boolean;
  enableTable: boolean;
}

export interface MineruExtractProgress {
  extractedPages: number;
  totalPages: number;
}

export interface MineruExtractResult {
  fileName: string;
  state: MineruTaskState;
  fullZipUrl?: string;
  errMsg?: string;
  progress?: MineruExtractProgress;
}

export class MineruApiClient {
  private readonly options: MineruApiClientOptions;

  constructor(options: MineruApiClientOptions) {
    this.options = options;
  }

  async requestBatchUploadUrl(fileName: string): Promise<{ batchId: string; uploadUrl: string }> {
    const response = await requestUrl({
      url: `${MINERU_API_BASE}/file-urls/batch`,
      method: "POST",
      headers: this.buildJsonHeaders(),
      body: JSON.stringify({
        files: [{ name: fileName, data_id: buildDataId(fileName) }],
        model_version: this.options.modelVersion,
        enable_formula: this.options.enableFormula,
        enable_table: this.options.enableTable
      }),
      throw: false
    });

    const payload = await this.parseEnvelope<BatchUploadData>(response, "申请上传链接");
    const uploadUrl = payload.data.file_urls?.[0];
    if (!payload.data.batch_id || !uploadUrl) {
      throw new Error("申请上传链接成功，但响应中缺少 batch_id 或 file_url");
    }

    return {
      batchId: payload.data.batch_id,
      uploadUrl
    };
  }

  async uploadFile(uploadUrl: string, fileData: ArrayBuffer): Promise<void> {
    const response = await requestUrl({
      url: uploadUrl,
      method: "PUT",
      body: fileData,
      throw: false
    });

    if (!isSuccessStatus(response.status)) {
      throw new Error(`上传文件失败（HTTP ${response.status}）：${truncate(response.text ?? "")}`);
    }
  }

  async getBatchResult(batchId: string, fileName?: string): Promise<MineruExtractResult | undefined> {
    const response = await requestUrl({
      url: `${MINERU_API_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`,
      method: "GET",
      headers: this.buildAuthHeaders(),
      throw: false
    });
    const payload = await this.parseEnvelope<BatchExtractData>(response, "查询解析进度");
    const results = payload.data.extract_result ?? [];
    if (results.length === 0) {
      return undefined;
    }

    const target = fileName
      ? results.find((result) => result.file_name === fileName) ?? results[0]
      : results[0];

    return {
      fileName: target.file_name,
      state: target.state,
      fullZipUrl: target.full_zip_url,
      errMsg: target.err_msg,
      progress: target.extract_progress
        ? {
            extractedPages: target.extract_progress.extracted_pages,
            totalPages: target.extract_progress.total_pages
          }
        : undefined
    };
  }

  async downloadMarkdownFromZip(fullZipUrl: string): Promise<string> {
    const response = await requestUrl({
      url: fullZipUrl,
      method: "GET",
      throw: false
    });
    if (!isSuccessStatus(response.status)) {
      throw new Error(`下载解析结果失败（HTTP ${response.status}）：${truncate(response.text ?? "")}`);
    }

    const zip = await JSZip.loadAsync(response.arrayBuffer);
    const fullMdPath = findFullMarkdownPath(zip);
    if (!fullMdPath) {
      throw new Error("解析结果压缩包中未找到 full.md");
    }

    const fullMdFile = zip.file(fullMdPath);
    if (!fullMdFile) {
      throw new Error("解析结果压缩包中未找到 full.md");
    }

    return fullMdFile.async("text");
  }

  private async parseEnvelope<T>(
    response: { status: number; text: string; json: unknown },
    action: string
  ): Promise<MineruApiEnvelope<T>> {
    if (!isSuccessStatus(response.status)) {
      throw new Error(`${action}失败（HTTP ${response.status}）：${truncate(response.text ?? "")}`);
    }

    const payload = response.json as MineruApiEnvelope<T>;
    if (!payload || typeof payload !== "object") {
      throw new Error(`${action}失败：响应不是有效 JSON`);
    }
    if (payload.code !== 0) {
      throw new Error(`${action}失败：${payload.msg}（code ${payload.code}）`);
    }

    return payload;
  }

  private buildAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiToken}`,
      Accept: "*/*"
    };
  }

  private buildJsonHeaders(): Record<string, string> {
    return {
      ...this.buildAuthHeaders(),
      "Content-Type": "application/json"
    };
  }
}

function buildDataId(fileName: string): string {
  const normalized = fileName.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/-+/g, "-");
  const base = normalized.length > 80 ? normalized.slice(0, 80) : normalized;
  return `${base}-${Date.now()}`;
}

function findFullMarkdownPath(zip: JSZip): string | undefined {
  const rootMatch = zip.file("full.md");
  if (rootMatch) {
    return "full.md";
  }

  const nestedMatch = zip.filter((relativePath, file) => !file.dir && relativePath.endsWith("/full.md"))[0];
  return nestedMatch?.name;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function truncate(input: string, max = 280): string {
  const text = input.trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
