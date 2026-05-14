import { App, FuzzySuggestModal, TFile } from "obsidian";

export class PdfSelectModal extends FuzzySuggestModal<TFile> {
  private readonly files: TFile[];
  private readonly onSelectFile: (file: TFile) => void;

  constructor(app: App, files: TFile[], onSelectFile: (file: TFile) => void) {
    super(app);
    this.files = [...files].sort((a, b) => a.path.localeCompare(b.path));
    this.onSelectFile = onSelectFile;
    this.setPlaceholder("选择一个 PDF 文件");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.onSelectFile(item);
  }
}
