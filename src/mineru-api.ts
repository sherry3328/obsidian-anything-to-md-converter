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
  start_time?: string;
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

export interface MineruDownloadedAsset {
  relativePath: string;
  data: ArrayBuffer;
}

export interface MineruDownloadBundle {
  markdown: string;
  assets: MineruDownloadedAsset[];
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

  async downloadExtractionBundle(fullZipUrl: string): Promise<MineruDownloadBundle> {
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

    const markdown = await fullMdFile.async("text");
    const assets = await extractAssetsFromZip(zip, fullMdPath, markdown);

    return {
      markdown,
      assets
    };
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
  if (!nestedMatch) {
    return undefined;
  }

  return normalizeZipPath(nestedMatch.name);
}

async function extractAssetsFromZip(
  zip: JSZip,
  fullMdPath: string,
  markdown: string
): Promise<MineruDownloadedAsset[]> {
  const markdownDir = getDirectoryPath(fullMdPath);
  const refs = extractLocalAssetRefs(markdown);
  const assetMap = new Map<string, MineruDownloadedAsset>();

  for (const ref of refs) {
    for (const candidatePath of buildZipCandidates(ref, markdownDir)) {
      const file = zip.file(candidatePath);
      if (!file) {
        continue;
      }

      const relativePath = sanitizeRelativePath(ref);
      if (!relativePath) {
        continue;
      }

      if (!assetMap.has(relativePath)) {
        assetMap.set(relativePath, {
          relativePath,
          data: await file.async("arraybuffer")
        });
      }
      break;
    }
  }

  if (assetMap.size === 0) {
    const imagePrefix = markdownDir ? `${markdownDir}/images/` : "images/";
    for (const [zipPath, file] of Object.entries(zip.files)) {
      if (file.dir) {
        continue;
      }
      const normalizedZipPath = normalizeZipPath(zipPath);
      if (!normalizedZipPath.startsWith(imagePrefix)) {
        continue;
      }

      const relativePath = sanitizeRelativePath(normalizedZipPath.slice(markdownDir ? markdownDir.length + 1 : 0));
      if (!relativePath) {
        continue;
      }

      if (!assetMap.has(relativePath)) {
        assetMap.set(relativePath, {
          relativePath,
          data: await file.async("arraybuffer")
        });
      }
    }
  }

  return Array.from(assetMap.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function extractLocalAssetRefs(markdown: string): string[] {
  const refs = new Set<string>();
  const markdownImageRegex = /!\[[^\]]*]\(([^)]+)\)/g;
  const htmlImageRegex = /<img[^>]+src=["']([^"']+)["']/gi;

  collectRefs(markdown, markdownImageRegex, refs);
  collectRefs(markdown, htmlImageRegex, refs);

  return Array.from(refs);
}

function collectRefs(markdown: string, regex: RegExp, output: Set<string>): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(markdown);
  while (match) {
    const parsed = parseRefPath(match[1] ?? "");
    if (parsed) {
      output.add(parsed);
    }
    match = regex.exec(markdown);
  }
}

function parseRefPath(rawRef: string): string | undefined {
  if (!rawRef) {
    return undefined;
  }

  let ref = rawRef.trim();
  if (!ref) {
    return undefined;
  }

  if (ref.startsWith("<") && ref.endsWith(">")) {
    ref = ref.slice(1, -1).trim();
  }

  const firstSpace = ref.search(/\s/);
  if (firstSpace >= 0) {
    ref = ref.slice(0, firstSpace);
  }

  ref = ref.split("#")[0].split("?")[0];
  if (!ref) {
    return undefined;
  }

  ref = ref.replace(/^\.\/+/, "");
  if (!ref || ref.startsWith("/")) {
    return undefined;
  }

  if (/^(https?|data|file|obsidian|mailto):/i.test(ref)) {
    return undefined;
  }

  try {
    ref = decodeURI(ref);
  } catch {
    // Keep original value if decoding fails.
  }

  return sanitizeRelativePath(ref);
}

function buildZipCandidates(assetRef: string, markdownDir: string): string[] {
  const normalizedRef = normalizeZipPath(assetRef);
  const candidates = new Set<string>();
  candidates.add(normalizedRef);
  if (markdownDir) {
    candidates.add(normalizeZipPath(`${markdownDir}/${normalizedRef}`));
  }
  return Array.from(candidates);
}

function sanitizeRelativePath(input: string): string | undefined {
  const normalized = normalizeZipPath(input).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) {
    return undefined;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return undefined;
  }

  return segments.join("/");
}

function getDirectoryPath(filePath: string): string {
  const normalized = normalizeZipPath(filePath);
  const lastSlashIndex = normalized.lastIndexOf("/");
  if (lastSlashIndex < 0) {
    return "";
  }
  return normalized.slice(0, lastSlashIndex);
}

function normalizeZipPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function truncate(input: string, max = 280): string {
  const text = input.trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
