import { App, Modal, Setting, TFile } from "obsidian";

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  files: TFile[];
  totalFiles: number;
}

interface MutableFolderNode {
  name: string;
  path: string;
  folders: Map<string, MutableFolderNode>;
  files: TFile[];
  totalFiles: number;
}

export class PdfQueueModal extends Modal {
  private readonly files: TFile[];
  private readonly filesByPath: Map<string, TFile>;
  private readonly onSubmit: (files: TFile[]) => void;
  private readonly selectedPaths = new Set<string>();
  private readonly collapsedFolders = new Set<string>();
  private readonly treeRoot: FolderNode;

  private searchQuery = "";
  private treeContainerEl!: HTMLElement;
  private queueTitleEl!: HTMLElement;
  private queueContainerEl!: HTMLElement;
  private startButtonEl!: HTMLButtonElement;

  constructor(app: App, files: TFile[], onSubmit: (files: TFile[]) => void) {
    super(app);
    this.files = [...files].sort((a, b) => a.path.localeCompare(b.path));
    this.filesByPath = new Map(this.files.map((file) => [file.path, file]));
    this.onSubmit = onSubmit;
    this.treeRoot = buildFolderTree(this.files);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mineru-queue-modal");
    this.modalEl.classList.add("mineru-queue-modal-shell");

    contentEl.createEl("h2", { text: "选择要转换的 PDF（队列模式）" });

    new Setting(contentEl)
      .setName("搜索 PDF")
      .setDesc("按文件名或路径筛选")
      .addSearch((search) =>
        search.setPlaceholder("输入关键词…").onChange((value) => {
          this.searchQuery = value.trim().toLowerCase();
          this.render();
        })
      );

    const layoutEl = contentEl.createDiv({ cls: "mineru-queue-layout" });
    this.treeContainerEl = layoutEl.createDiv({ cls: "mineru-queue-tree" });

    const queuePanelEl = layoutEl.createDiv({ cls: "mineru-queue-panel" });
    const queueHeaderEl = queuePanelEl.createDiv({ cls: "mineru-queue-panel-header" });
    const actionsEl = queueHeaderEl.createDiv({ cls: "mineru-queue-actions" });

    const clearButtonEl = actionsEl.createEl("button", { text: "清空选择" });
    clearButtonEl.addEventListener("click", () => {
      this.selectedPaths.clear();
      this.render();
    });

    const cancelButtonEl = actionsEl.createEl("button", { text: "取消" });
    cancelButtonEl.addEventListener("click", () => this.close());

    this.startButtonEl = actionsEl.createEl("button", { text: "开始队列转换" });
    this.startButtonEl.addClass("mod-cta");
    this.startButtonEl.disabled = true;
    this.startButtonEl.addEventListener("click", () => {
      const selectedFiles = this.getSelectedFiles();
      if (selectedFiles.length === 0) {
        return;
      }
      this.close();
      this.onSubmit(selectedFiles);
    });

    this.queueTitleEl = queueHeaderEl.createEl("h4", { text: "待转换队列（0）", cls: "mineru-queue-title" });
    this.queueContainerEl = queuePanelEl.createDiv({ cls: "mineru-queue-list" });

    this.render();
  }

  onClose(): void {
    this.modalEl.classList.remove("mineru-queue-modal-shell");
    this.contentEl.empty();
  }

  private render(): void {
    this.updateModalWidth();
    this.renderTree();
    this.renderQueue();
  }

  private renderTree(): void {
    this.treeContainerEl.empty();

    const hasVisible = this.renderFolderContent(this.treeRoot, this.treeContainerEl, 0);
    if (!hasVisible) {
      this.treeContainerEl.createDiv({
        cls: "mineru-empty",
        text: this.searchQuery ? "没有匹配的 PDF" : "当前没有可转换 PDF"
      });
    }
  }

  private renderFolderContent(node: FolderNode, containerEl: HTMLElement, depth: number): boolean {
    let hasVisibleContent = false;

    for (const folder of node.folders) {
      if (!this.hasVisibleContent(folder)) {
        continue;
      }

      hasVisibleContent = true;
      const rowEl = containerEl.createDiv({ cls: "mineru-folder-row" });
      rowEl.style.paddingLeft = `${depth * 14}px`;

      const isCollapsed = this.searchQuery ? false : this.collapsedFolders.has(folder.path);
      const folderFiles = this.getFilesInFolder(folder);
      const selectedCount = folderFiles.reduce(
        (count, file) => count + (this.selectedPaths.has(file.path) ? 1 : 0),
        0
      );

      const folderCheckboxEl = rowEl.createEl("input", { type: "checkbox", cls: "mineru-folder-checkbox" });
      folderCheckboxEl.checked = folderFiles.length > 0 && selectedCount === folderFiles.length;
      folderCheckboxEl.indeterminate = selectedCount > 0 && selectedCount < folderFiles.length;
      folderCheckboxEl.addEventListener("click", (event) => event.stopPropagation());
      folderCheckboxEl.addEventListener("change", (event) => {
        event.stopPropagation();
        if (folderCheckboxEl.checked) {
          for (const file of folderFiles) {
            this.selectedPaths.add(file.path);
          }
        } else {
          for (const file of folderFiles) {
            this.selectedPaths.delete(file.path);
          }
        }
        this.render();
      });

      rowEl.createSpan({ cls: "mineru-folder-caret", text: isCollapsed ? "▸" : "▾" });
      rowEl.createSpan({ cls: "mineru-folder-name", text: folder.name });
      rowEl.createSpan({ cls: "mineru-folder-count", text: String(this.countVisibleFiles(folder)) });

      rowEl.addEventListener("click", () => {
        if (this.searchQuery) {
          return;
        }
        if (this.collapsedFolders.has(folder.path)) {
          this.collapsedFolders.delete(folder.path);
        } else {
          this.collapsedFolders.add(folder.path);
        }
        this.render();
      });

      const childrenEl = containerEl.createDiv({ cls: "mineru-folder-children" });
      if (!isCollapsed) {
        this.renderFolderContent(folder, childrenEl, depth + 1);
      }
    }

    for (const file of node.files) {
      if (!this.matchesFileQuery(file)) {
        continue;
      }

      hasVisibleContent = true;
      const fileRowEl = containerEl.createDiv({ cls: "mineru-file-row" });
      fileRowEl.style.paddingLeft = `${depth * 14 + 12}px`;

      const checkboxEl = fileRowEl.createEl("input", { type: "checkbox" });
      checkboxEl.checked = this.selectedPaths.has(file.path);

      const labelEl = fileRowEl.createSpan({ cls: "mineru-file-label", text: file.basename });
      const pathEl = fileRowEl.createSpan({ cls: "mineru-file-path", text: file.path });

      const toggle = (): void => {
        if (checkboxEl.checked) {
          this.selectedPaths.add(file.path);
        } else {
          this.selectedPaths.delete(file.path);
        }
        this.render();
      };

      checkboxEl.addEventListener("click", (event) => event.stopPropagation());
      checkboxEl.addEventListener("change", toggle);
      labelEl.addEventListener("click", () => {
        checkboxEl.checked = !checkboxEl.checked;
        toggle();
      });
      pathEl.addEventListener("click", () => {
        checkboxEl.checked = !checkboxEl.checked;
        toggle();
      });
    }

    return hasVisibleContent;
  }

  private renderQueue(): void {
    this.queueContainerEl.empty();
    const selectedFiles = this.getSelectedFiles();

    this.queueTitleEl.setText(`待转换队列（${selectedFiles.length}）`);
    this.startButtonEl.disabled = selectedFiles.length === 0;
    this.startButtonEl.setText(
      selectedFiles.length === 0 ? "开始队列转换" : `开始队列转换（${selectedFiles.length}）`
    );

    if (selectedFiles.length === 0) {
      this.queueContainerEl.createDiv({ cls: "mineru-empty", text: "还没有选择文件" });
      return;
    }

    for (const file of selectedFiles) {
      const itemEl = this.queueContainerEl.createDiv({ cls: "mineru-queue-item" });
      itemEl.createSpan({ cls: "mineru-queue-item-path", text: file.path });
      const removeEl = itemEl.createEl("button", { text: "移除" });
      removeEl.addEventListener("click", () => {
        this.selectedPaths.delete(file.path);
        this.render();
      });
    }
  }

  private getSelectedFiles(): TFile[] {
    return Array.from(this.selectedPaths)
      .map((path) => this.filesByPath.get(path))
      .filter((file): file is TFile => Boolean(file))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private getFilesInFolder(node: FolderNode): TFile[] {
    const files = [...node.files];
    for (const folder of node.folders) {
      files.push(...this.getFilesInFolder(folder));
    }
    return files;
  }

  private updateModalWidth(): void {
    const visibleFiles = this.files.filter((file) => this.matchesFileQuery(file));
    const longestNameLength = visibleFiles.reduce(
      (max, file) => Math.max(max, file.basename.length),
      0
    );
    const longestPathLength = visibleFiles.reduce(
      (max, file) => Math.max(max, file.path.length),
      0
    );

    const estimatedTreeWidth = clampNumber(
      420,
      220 + longestNameLength * 8 + Math.min(longestPathLength, 110) * 4,
      980
    );
    const targetWidth = clampNumber(820, estimatedTreeWidth + 360, 1500);

    this.modalEl.style.width = `${targetWidth}px`;
    this.modalEl.style.maxWidth = "95vw";
    this.modalEl.style.minWidth = "min(820px, 95vw)";
  }

  private matchesFileQuery(file: TFile): boolean {
    if (!this.searchQuery) {
      return true;
    }
    const keyword = this.searchQuery;
    return file.basename.toLowerCase().includes(keyword) || file.path.toLowerCase().includes(keyword);
  }

  private hasVisibleContent(node: FolderNode): boolean {
    if (!this.searchQuery) {
      return node.totalFiles > 0;
    }
    if (node.path.toLowerCase().includes(this.searchQuery)) {
      return true;
    }
    if (node.files.some((file) => this.matchesFileQuery(file))) {
      return true;
    }
    return node.folders.some((folder) => this.hasVisibleContent(folder));
  }

  private countVisibleFiles(node: FolderNode): number {
    if (!this.searchQuery) {
      return node.totalFiles;
    }

    let count = node.files.filter((file) => this.matchesFileQuery(file)).length;
    for (const folder of node.folders) {
      count += this.countVisibleFiles(folder);
    }
    return count;
  }
}

function buildFolderTree(files: TFile[]): FolderNode {
  const root: MutableFolderNode = createMutableNode("", "");

  for (const file of files) {
    const segments = file.path.split("/");
    const folderSegments = segments.slice(0, -1);
    let current = root;
    current.totalFiles += 1;

    let currentPath = "";
    for (const segment of folderSegments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let child = current.folders.get(segment);
      if (!child) {
        child = createMutableNode(segment, currentPath);
        current.folders.set(segment, child);
      }
      child.totalFiles += 1;
      current = child;
    }

    current.files.push(file);
  }

  return finalizeNode(root);
}

function createMutableNode(name: string, path: string): MutableFolderNode {
  return {
    name,
    path,
    folders: new Map(),
    files: [],
    totalFiles: 0
  };
}

function finalizeNode(node: MutableFolderNode): FolderNode {
  const folders = Array.from(node.folders.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => finalizeNode(child));

  const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));

  return {
    name: node.name,
    path: node.path,
    folders,
    files,
    totalFiles: node.totalFiles
  };
}

function clampNumber(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
