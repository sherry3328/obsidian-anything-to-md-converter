import { requestUrl } from "obsidian";

interface MathpixPdfSubmitResponse {
  pdf_id?: string;
  error?: string;
}

interface MathpixPdfStatusResponse {
  status?: string;
  error?: string;
}

export interface MathpixApiClientOptions {
  apiKey: string;
}

export class MathpixApiClient {
  private readonly options: MathpixApiClientOptions;

  constructor(options: MathpixApiClientOptions) {
    this.options = options;
  }

  async convertPdfToMarkdown(fileName: string, fileData: ArrayBuffer): Promise<string> {
    const upload = await this.uploadPdf(fileName, fileData);
    const pdfId = upload.pdf_id;
    if (!pdfId) {
      throw new Error(upload.error || "Mathpix 上传失败：缺少 pdf_id");
    }

    await this.pollUntilDone(pdfId);
    return this.downloadMarkdown(pdfId);
  }

  private async uploadPdf(fileName: string, fileData: ArrayBuffer): Promise<MathpixPdfSubmitResponse> {
    const boundary = `----AnythingToMd${Date.now().toString(16)}`;
    const payload = buildMultipartBody(boundary, fileName, fileData, {
      conversion_formats: { md: true }
    });

    const response = await requestUrl({
      url: "https://api.mathpix.com/v3/pdf",
      method: "POST",
      headers: {
        app_key: this.options.apiKey,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body: payload,
      throw: false
    });

    if (!isSuccessStatus(response.status)) {
      throw new Error(`Mathpix 上传失败（HTTP ${response.status}）：${truncate(response.text ?? "")}`);
    }

    return response.json as MathpixPdfSubmitResponse;
  }

  private async pollUntilDone(pdfId: string): Promise<void> {
    const timeoutMs = 30 * 60 * 1000;
    const intervalMs = 3000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const response = await requestUrl({
        url: `https://api.mathpix.com/v3/pdf/${encodeURIComponent(pdfId)}`,
        method: "GET",
        headers: { app_key: this.options.apiKey },
        throw: false
      });
      if (!isSuccessStatus(response.status)) {
        throw new Error(`Mathpix 轮询失败（HTTP ${response.status}）：${truncate(response.text ?? "")}`);
      }

      const statusPayload = response.json as MathpixPdfStatusResponse;
      const status = (statusPayload.status ?? "").toLowerCase();
      if (status === "completed") {
        return;
      }
      if (status === "error" || status === "failed") {
        throw new Error(statusPayload.error || "Mathpix 返回失败状态");
      }

      await sleep(intervalMs);
    }

    throw new Error("Mathpix 轮询超时，请稍后重试");
  }

  private async downloadMarkdown(pdfId: string): Promise<string> {
    const response = await requestUrl({
      url: `https://api.mathpix.com/v3/pdf/${encodeURIComponent(pdfId)}.md`,
      method: "GET",
      headers: { app_key: this.options.apiKey },
      throw: false
    });
    if (!isSuccessStatus(response.status)) {
      throw new Error(`Mathpix 下载 Markdown 失败（HTTP ${response.status}）：${truncate(response.text ?? "")}`);
    }
    return response.text ?? "";
  }
}

function buildMultipartBody(
  boundary: string,
  fileName: string,
  fileData: ArrayBuffer,
  options: Record<string, unknown>
): ArrayBuffer {
  const encoder = new TextEncoder();
  const preamble = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${escapeQuotes(fileName)}"\r\n`,
    "Content-Type: application/pdf\r\n\r\n"
  ].join("");
  const middle = [
    "\r\n",
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="options_json"\r\n\r\n',
    JSON.stringify(options),
    "\r\n"
  ].join("");
  const ending = `--${boundary}--\r\n`;

  const preambleBytes = encoder.encode(preamble);
  const middleBytes = encoder.encode(middle);
  const endingBytes = encoder.encode(ending);
  const fileBytes = new Uint8Array(fileData);

  const merged = new Uint8Array(
    preambleBytes.length + fileBytes.length + middleBytes.length + endingBytes.length
  );
  merged.set(preambleBytes, 0);
  merged.set(fileBytes, preambleBytes.length);
  merged.set(middleBytes, preambleBytes.length + fileBytes.length);
  merged.set(endingBytes, preambleBytes.length + fileBytes.length + middleBytes.length);
  return merged.buffer;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function truncate(input: string, max = 280): string {
  const text = input.trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function escapeQuotes(input: string): string {
  return input.replace(/"/g, '\\"');
}
