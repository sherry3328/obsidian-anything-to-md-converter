import { App, Modal, Notice, TFile } from "obsidian";

import {
  buildHtmlTableFromRows,
  convertHtmlTablesToMarkdown,
  convertTableRowsToMarkdown,
  extractHtmlTables
} from "./table-tools";

export class HtmlTableEditorModal extends Modal {
  private readonly file: TFile;
  private readonly initialContent: string;
  private readonly onSave: (nextContent: string) => Promise<void>;

  private workingContent: string;
  private selectedIndex = 0;
  private editableRows: string[][] = [];

  private summaryEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private saveButtonEl!: HTMLButtonElement;
  private prevButtonEl!: HTMLButtonElement;
  private nextButtonEl!: HTMLButtonElement;
  private applyButtonEl!: HTMLButtonElement;
  private convertCurrentButtonEl!: HTMLButtonElement;
  private convertAllButtonEl!: HTMLButtonElement;

  constructor(app: App, file: TFile, content: string, onSave: (nextContent: string) => Promise<void>) {
    super(app);
    this.file = file;
    this.initialContent = content;
    this.workingContent = content;
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mineru-table-editor-modal");
    this.modalEl.classList.add("mineru-table-editor-modal-shell");

    contentEl.createEl("h2", { text: `表格编辑器：${this.file.basename}` });

    const toolbarEl = contentEl.createDiv({ cls: "mineru-table-editor-toolbar" });

    this.prevButtonEl = toolbarEl.createEl("button", { text: "上一张表" });
    this.prevButtonEl.addEventListener("click", () => {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.render();
    });

    this.nextButtonEl = toolbarEl.createEl("button", { text: "下一张表" });
    this.nextButtonEl.addEventListener("click", () => {
      this.selectedIndex += 1;
      this.render();
    });

    this.applyButtonEl = toolbarEl.createEl("button", { text: "应用单元格修改" });
    this.applyButtonEl.addEventListener("click", () => {
      this.applyCellEdits();
    });

    this.convertCurrentButtonEl = toolbarEl.createEl("button", { text: "当前表转 Markdown" });
    this.convertCurrentButtonEl.addEventListener("click", () => {
      this.convertCurrentTableToMarkdown();
    });

    this.convertAllButtonEl = toolbarEl.createEl("button", { text: "全部 HTML 表格转 Markdown" });
    this.convertAllButtonEl.addEventListener("click", () => {
      this.convertAllTablesToMarkdown();
    });

    this.saveButtonEl = toolbarEl.createEl("button", { text: "保存到文件" });
    this.saveButtonEl.addClass("mod-cta");
    this.saveButtonEl.addEventListener("click", () => {
      void this.saveChanges();
    });

    const cancelButtonEl = toolbarEl.createEl("button", { text: "取消" });
    cancelButtonEl.addEventListener("click", () => this.close());

    this.summaryEl = contentEl.createDiv({ cls: "mineru-table-editor-summary" });
    this.gridEl = contentEl.createDiv({ cls: "mineru-table-editor-grid" });

    this.render();
  }

  onClose(): void {
    this.modalEl.classList.remove("mineru-table-editor-modal-shell");
    this.contentEl.empty();
  }

  private render(): void {
    const tables = extractHtmlTables(this.workingContent);
    if (tables.length === 0) {
      this.selectedIndex = 0;
      this.editableRows = [];
      this.summaryEl.setText("当前笔记没有可编辑的 HTML 表格。");
      this.gridEl.empty();
      this.gridEl.createDiv({ cls: "mineru-empty", text: "没有找到 <table>...</table> 结构" });
      this.updateActionState(false, false);
      return;
    }

    this.selectedIndex = clamp(this.selectedIndex, 0, tables.length - 1);
    const current = tables[this.selectedIndex];
    this.editableRows = current.rows.map((row) => [...row]);

    this.summaryEl.setText(
      `表格 ${this.selectedIndex + 1} / ${tables.length}（${current.rows.length} 行） - 直接改单元格后点击“应用单元格修改”`
    );
    this.renderGrid();
    this.updateActionState(true, tables.length > 1);
  }

  private renderGrid(): void {
    this.gridEl.empty();

    if (this.editableRows.length === 0) {
      this.gridEl.createDiv({ cls: "mineru-empty", text: "当前表格解析为空" });
      return;
    }

    for (let rowIndex = 0; rowIndex < this.editableRows.length; rowIndex += 1) {
      const row = this.editableRows[rowIndex];
      const rowEl = this.gridEl.createDiv({ cls: "mineru-table-editor-row" });
      rowEl.style.gridTemplateColumns = `repeat(${Math.max(1, row.length)}, minmax(220px, 1fr))`;

      for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
        const cellValue = row[colIndex] ?? "";
        const textareaEl = rowEl.createEl("textarea", { cls: "mineru-table-editor-cell" });
        textareaEl.value = cellValue;
        textareaEl.addEventListener("input", () => {
          this.editableRows[rowIndex][colIndex] = textareaEl.value;
        });
      }
    }
  }

  private updateActionState(hasTable: boolean, hasMultipleTables: boolean): void {
    this.prevButtonEl.disabled = !hasMultipleTables;
    this.nextButtonEl.disabled = !hasMultipleTables;
    this.applyButtonEl.disabled = !hasTable;
    this.convertCurrentButtonEl.disabled = !hasTable;
    this.convertAllButtonEl.disabled = !hasTable;
    this.saveButtonEl.disabled = this.workingContent === this.initialContent;
  }

  private applyCellEdits(): void {
    const tables = extractHtmlTables(this.workingContent);
    if (tables.length === 0) {
      return;
    }

    const current = tables[this.selectedIndex];
    const updatedHtml = buildHtmlTableFromRows(this.editableRows);
    this.workingContent = replaceRange(this.workingContent, current.start, current.end, updatedHtml);
    new Notice("已应用当前表格单元格修改");
    this.render();
  }

  private convertCurrentTableToMarkdown(): void {
    const tables = extractHtmlTables(this.workingContent);
    if (tables.length === 0) {
      return;
    }

    const current = tables[this.selectedIndex];
    const markdownTable = convertTableRowsToMarkdown(this.editableRows);
    if (!markdownTable) {
      new Notice("当前表格无法转换为 Markdown");
      return;
    }

    this.workingContent = replaceRange(this.workingContent, current.start, current.end, `\n${markdownTable}\n`);
    new Notice("已将当前 HTML 表格转换为 Markdown 表格");
    this.render();
  }

  private convertAllTablesToMarkdown(): void {
    const result = convertHtmlTablesToMarkdown(this.workingContent);
    if (result.convertedCount === 0) {
      new Notice("没有可转换的 HTML 表格");
      return;
    }

    this.workingContent = result.content;
    this.selectedIndex = 0;
    new Notice(`已转换 ${result.convertedCount} 个 HTML 表格`);
    this.render();
  }

  private async saveChanges(): Promise<void> {
    if (this.workingContent === this.initialContent) {
      this.close();
      return;
    }

    await this.onSave(this.workingContent);
    new Notice(`已保存：${this.file.path}`);
    this.close();
  }
}

function replaceRange(content: string, start: number, end: number, replacement: string): string {
  return `${content.slice(0, start)}${replacement}${content.slice(end)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
