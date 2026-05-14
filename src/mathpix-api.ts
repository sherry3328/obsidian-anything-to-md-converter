import { requestUrl } from "obsidian";

const MATHPIX_API_URL = "https://api.mathpix.com/v3/pdf";

export interface MathpixApiClientOptions {
  appId: string;
  appKey: string;
}

export class MathpixApiClient {
  private readonly options: MathpixApiClientOptions;

  constructor(options: MathpixApiClientOptions) {
    this.options = options;
  }

  async convertPdfToMarkdown(
    fileName: string,
    fileData: ArrayBuffer,
    pollIntervalMs = 5000,
    maxPolls = 90
  ): Promise<string> {
    const pdfId = await this.uploadPdf(fileName, fileData);

    for (let index = 0; index < maxPolls; index += 1) {
      await sleep(pollIntervalMs);
      const statusData = await this.getStatus(pdfId);
      const status = typeof statusData.status === "string" ? statusData.status.toLowerCase() : "";

      if (status === "completed") {
        return this.downloadMarkdown(pdfId);
      }

      if (status === "error") {
        const detail = typeof statusData.error === "string" ? statusData.error : "unknown";
        throw new Error(`Mathpix 转换失败：${detail}`);
      }
    }

    throw new Error(`Mathpix 轮询超时（${Math.floor((pollIntervalMs * maxPolls) / 1000)}s）`);
  }

  private async uploadPdf(fileName: string, fileData: ArrayBuffer): Promise<string> {
    const boundary = `----mineru-pdf-converter-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const optionsJson = JSON.stringify({
      conversion_formats: { md: true },
      math_inline_delimiters: ["$", "$"],
      math_display_delimiters: ["$$", "$$"],
      rm_spaces: true
    });
    const body = buildMultipartBody(boundary, fileName, fileData, optionsJson);

    const response = await requestUrl({
      url: MATHPIX_API_URL,
      method: "POST",
      headers: {
        ...buildMathpixHeaders(this.options.appId, this.options.appKey),
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body,
      throw: false
    });

    if (response.status !== 200) {
      throw new Error(`Mathpix 上传失败（HTTP ${response.status}）：${truncate(response.text ?? "")}`);
    }

    const json = response.json as Record<string, unknown>;
    const pdfId = json?.pdf_id;
    if (typeof pdfId !== "string" || !pdfId) {
      throw new Error("Mathpix 上传成功但响应缺少 pdf_id");
    }

    return pdfId;
  }

  private async getStatus(pdfId: string): Promise<Record<string, unknown>> {
    const response = await requestUrl({
      url: `${MATHPIX_API_URL}/${encodeURIComponent(pdfId)}`,
      method: "GET",
      headers: buildMathpixHeaders(this.options.appId, this.options.appKey),
      throw: false
    });

    if (response.status !== 200) {
      throw new Error(`Mathpix 状态查询失败（HTTP ${response.status}）：${truncate(response.text ?? "")}`);
    }

    return (response.json as Record<string, unknown>) ?? {};
  }

  private async downloadMarkdown(pdfId: string): Promise<string> {
    const response = await requestUrl({
      url: `${MATHPIX_API_URL}/${encodeURIComponent(pdfId)}.md`,
      method: "GET",
      headers: buildMathpixHeaders(this.options.appId, this.options.appKey),
      throw: false
    });

    if (response.status !== 200) {
      throw new Error(`Mathpix Markdown 下载失败（HTTP ${response.status}）：${truncate(response.text ?? "")}`);
    }

    return response.text ?? "";
  }
}

function buildMathpixHeaders(rawAppId: string, rawAppKey: string): Record<string, string> {
  const appId = rawAppId.trim();
  const appKey = rawAppKey.trim();
  return {
    app_id: appId,
    app_key: appKey,
    Accept: "application/json"
  };
}

function buildMultipartBody(boundary: string, fileName: string, fileData: ArrayBuffer, optionsJson: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const safeFileName = fileName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
      "Content-Type: application/pdf\r\n\r\n"
  );
  const fileChunk = new Uint8Array(fileData);
  const tail = encoder.encode(
    `\r\n--${boundary}\r\n` +
      'Content-Disposition: form-data; name="options_json"\r\n\r\n' +
      `${optionsJson}\r\n` +
      `--${boundary}--\r\n`
  );

  const merged = new Uint8Array(head.length + fileChunk.length + tail.length);
  merged.set(head, 0);
  merged.set(fileChunk, head.length);
  merged.set(tail, head.length + fileChunk.length);
  return merged.buffer;
}

function truncate(input: string, max = 280): string {
  const text = input.trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
