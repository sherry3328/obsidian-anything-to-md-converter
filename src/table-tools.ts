export interface ParsedHtmlTable {
  html: string;
  start: number;
  end: number;
  rows: string[][];
}

export interface HtmlTableConversionResult {
  content: string;
  convertedCount: number;
  detectedCount: number;
}

export interface MarkdownTableHealthOptions {
  dropColumnNames?: string[];
}

export interface MarkdownTableHealthResult {
  content: string;
  touchedTableCount: number;
  removedRowCount: number;
  removedColumnCount: number;
}

export function hasHtmlTable(markdown: string): boolean {
  return /<table\b/i.test(markdown);
}

export function isLikelyMineruMarkdown(markdown: string): boolean {
  return (
    /(?:^|\n)converter:\s*["']?MinerU PDF Converter["']?/i.test(markdown) ||
    /(?:^|\n)source_pdf:\s*["']?[^"'\n]+\.pdf["']?/i.test(markdown)
  );
}

export function extractHtmlTables(markdown: string): ParsedHtmlTable[] {
  const results: ParsedHtmlTable[] = [];
  const tableRegex = /<table\b[\s\S]*?<\/table>/gi;
  tableRegex.lastIndex = 0;
  let match: RegExpExecArray | null = tableRegex.exec(markdown);

  while (match) {
    const html = match[0];
    const start = match.index;
    const end = start + html.length;
    const rows = parseHtmlTableRows(html);
    results.push({ html, start, end, rows });
    match = tableRegex.exec(markdown);
  }

  return results;
}

export function convertHtmlTablesToMarkdown(markdown: string): HtmlTableConversionResult {
  const tables = extractHtmlTables(markdown);
  if (tables.length === 0) {
    return {
      content: markdown,
      convertedCount: 0,
      detectedCount: 0
    };
  }

  let content = markdown;
  let convertedCount = 0;

  for (const table of [...tables].reverse()) {
    if (table.rows.length === 0) {
      continue;
    }
    const markdownTable = convertTableRowsToMarkdown(table.rows);
    if (!markdownTable) {
      continue;
    }
    content = `${content.slice(0, table.start)}\n${markdownTable}\n${content.slice(table.end)}`;
    convertedCount += 1;
  }

  return {
    content,
    convertedCount,
    detectedCount: tables.length
  };
}

export function applyMarkdownTableHealthChecks(
  markdown: string,
  options: MarkdownTableHealthOptions = {}
): MarkdownTableHealthResult {
  const normalizedMarkdown = markdown.replace(/\r\n?/g, "\n");
  const lines = normalizedMarkdown.split("\n");
  const keepTrailingNewline = normalizedMarkdown.endsWith("\n");
  const dropNames = new Set((options.dropColumnNames ?? []).map((name) => normalizeHeaderForMatch(name)));

  const outputLines: string[] = [];
  let touchedTableCount = 0;
  let removedRowCount = 0;
  let removedColumnCount = 0;
  let index = 0;

  while (index < lines.length) {
    if (!isMarkdownTableStart(lines, index)) {
      outputLines.push(lines[index]);
      index += 1;
      continue;
    }

    const blockStart = index;
    const tableLines: string[] = [];
    while (index < lines.length && isMarkdownTableRowLine(lines[index])) {
      tableLines.push(lines[index]);
      index += 1;
    }

    const cleaned = cleanMarkdownTableBlock(tableLines, dropNames);
    touchedTableCount += cleaned.touched ? 1 : 0;
    removedRowCount += cleaned.removedRowCount;
    removedColumnCount += cleaned.removedColumnCount;
    outputLines.push(...cleaned.lines);

    if (blockStart === index) {
      outputLines.push(lines[index]);
      index += 1;
    }
  }

  let content = outputLines.join("\n");
  if (keepTrailingNewline && !content.endsWith("\n")) {
    content += "\n";
  }

  return {
    content,
    touchedTableCount,
    removedRowCount,
    removedColumnCount
  };
}

export function convertTableRowsToMarkdown(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }

  const normalizedRows = normalizeRows(rows);
  const header = normalizedRows[0].map((cell) => escapeMarkdownCell(cell));
  const body = normalizedRows.slice(1);

  const lines: string[] = [];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);

  for (const row of body) {
    lines.push(`| ${row.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`);
  }

  return lines.join("\n");
}

export function buildHtmlTableFromRows(rows: string[][]): string {
  const normalizedRows = normalizeRows(rows);
  const htmlRows = normalizedRows.map((row) => {
    const cells = row.map((cell) => `<td>${toHtmlCellContent(cell)}</td>`).join("");
    return `<tr>${cells}</tr>`;
  });
  return `<table>${htmlRows.join("")}</table>`;
}

function parseHtmlTableRows(html: string): string[][] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) {
    return [];
  }

  const rows: string[][] = [];
  for (const rowEl of Array.from(table.querySelectorAll("tr"))) {
    const row = Array.from(rowEl.querySelectorAll("th, td")).map((cellEl) =>
      normalizeCellText(cellEl.textContent ?? "")
    );
    if (row.length > 0) {
      rows.push(row);
    }
  }

  return rows;
}

function cleanMarkdownTableBlock(
  tableLines: string[],
  dropNames: Set<string>
): { lines: string[]; touched: boolean; removedRowCount: number; removedColumnCount: number } {
  if (tableLines.length < 2) {
    return { lines: tableLines, touched: false, removedRowCount: 0, removedColumnCount: 0 };
  }

  const headerRow = parsePipeRow(tableLines[0]);
  const dataRows = tableLines.slice(2).map((line) => parsePipeRow(line));
  const allRows = normalizeRows([headerRow, ...dataRows]);
  if (allRows.length === 0 || allRows[0].length === 0) {
    return { lines: tableLines, touched: false, removedRowCount: 0, removedColumnCount: 0 };
  }

  const removedDataRowCount = allRows.slice(1).filter((row) => row.every((cell) => isCellEmpty(cell))).length;
  const compactDataRows = allRows.slice(1).filter((row) => !row.every((cell) => isCellEmpty(cell)));
  const compactRows = [allRows[0], ...compactDataRows];
  const colCount = compactRows[0]?.length ?? 0;
  const keepIndices: number[] = [];

  for (let col = 0; col < colCount; col += 1) {
    const headerName = normalizeHeaderForMatch(compactRows[0][col] ?? "");
    if (headerName && dropNames.has(headerName)) {
      continue;
    }

    const isEmptyColumn = compactRows.every((row) => isCellEmpty(row[col] ?? ""));
    if (isEmptyColumn) {
      continue;
    }

    keepIndices.push(col);
  }

  if (keepIndices.length === 0) {
    return {
      lines: tableLines,
      touched: removedDataRowCount > 0,
      removedRowCount: removedDataRowCount,
      removedColumnCount: 0
    };
  }

  const filteredRows = compactRows.map((row) => keepIndices.map((col) => row[col] ?? ""));
  const removedCols = colCount - keepIndices.length;
  const lines = convertTableRowsToMarkdown(filteredRows).split("\n");

  return {
    lines,
    touched: removedDataRowCount > 0 || removedCols > 0,
    removedRowCount: removedDataRowCount,
    removedColumnCount: removedCols
  };
}

function normalizeRows(rows: string[][]): string[][] {
  const colCount = Math.max(1, ...rows.map((row) => row.length));
  return rows.map((row) => {
    const normalized = [...row];
    while (normalized.length < colCount) {
      normalized.push("");
    }
    return normalized.slice(0, colCount);
  });
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) {
    return false;
  }
  return isMarkdownTableRowLine(lines[index]) && isMarkdownTableSeparatorLine(lines[index + 1]);
}

function isMarkdownTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  return /^\|.*\|$/.test(trimmed);
}

function isMarkdownTableSeparatorLine(line: string): boolean {
  const cells = parsePipeRow(line);
  if (cells.length === 0) {
    return false;
  }
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parsePipeRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return [];
  }

  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function normalizeCellText(input: string): string {
  const lines = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1));
  return lines.join("<br>").trim();
}

function escapeMarkdownCell(input: string): string {
  const normalized = input.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).join("<br>");
  const escaped = normalized.replace(/\|/g, "\\|");
  return escaped || " ";
}

function normalizeHeaderForMatch(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isCellEmpty(input: string): boolean {
  return input.replace(/\s|<br>/gi, "").trim().length === 0;
}

function toHtmlCellContent(input: string): string {
  const lines = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  const escapedLines = lines.map((line) => escapeHtml(line));
  return escapedLines.join("<br>");
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
