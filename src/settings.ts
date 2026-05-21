import { App, PluginSettingTab, Setting } from "obsidian";

import type MineruPdfConverterPlugin from "./main";

export type MineruModelVersion = "pipeline" | "vlm";

export interface MineruPluginSettings {
  apiToken: string;
  mathpixAppId: string;
  mathpixAppKey: string;
  pandocPath: string;
  outputDirectoryOverride: string;
  manualIgnoreEntries: string;
  enableMarkdownTableHealthCheck: boolean;
  folderColumnDropRules: string;
  enableFormula: boolean;
  enableTable: boolean;
  autoConvertHtmlTablesToMarkdown: boolean;
  modelVersion: MineruModelVersion;
}

export const DEFAULT_SETTINGS: MineruPluginSettings = {
  apiToken: "",
  mathpixAppId: "",
  mathpixAppKey: "",
  pandocPath: "",
  outputDirectoryOverride: "",
  manualIgnoreEntries: "",
  enableMarkdownTableHealthCheck: true,
  folderColumnDropRules: "",
  enableFormula: true,
  enableTable: true,
  autoConvertHtmlTablesToMarkdown: true,
  modelVersion: "pipeline"
};

export class MineruSettingTab extends PluginSettingTab {
  plugin: MineruPdfConverterPlugin;

  constructor(app: App, plugin: MineruPdfConverterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "共用设置" });

    new Setting(containerEl)
      .setName("输出目录（可选覆盖）")
      .setDesc("留空时，默认输出到 PDF 所在文件夹同级的“原文件夹名_MD”；若不存在会自动创建")
      .addText((text) =>
        text
          .setPlaceholder("例如：Clippings 或 raw/notes")
          .setValue(this.plugin.settings.outputDirectoryOverride)
          .onChange(async (value) => {
            this.plugin.settings.outputDirectoryOverride = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("手动忽略文件/文件夹")
      .setDesc(
        "每行一条规则。支持：相对路径（如 A/B/C）、文件名（如 demo.pdf）或目录名（如 examples）。命中的 PDF 会从可转换列表中排除。"
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("例如：\nexamples\nlatex-output\nA/B/notes.pdf")
          .setValue(this.plugin.settings.manualIgnoreEntries)
          .onChange(async (value) => {
            this.plugin.settings.manualIgnoreEntries = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("表格健康检查")
      .setDesc("开启后会自动清理 Markdown 表格中的全空行/全空列，并应用下方“按文件夹移除列规则”。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableMarkdownTableHealthCheck).onChange(async (value) => {
          this.plugin.settings.enableMarkdownTableHealthCheck = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("按文件夹移除列规则")
      .setDesc(
        "每行一条：文件夹路径 => 列名1,列名2。匹配到的 PDF 会在表格健康检查时移除对应列（列名匹配不区分大小写）。"
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("例如：\nMath/Past Paper/OCR A Additional Pure Core/MS => AO, Guidance\nMS_MD => Notes")
          .setValue(this.plugin.settings.folderColumnDropRules)
          .onChange(async (value) => {
            this.plugin.settings.folderColumnDropRules = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "MinerU 设置" });

    new Setting(containerEl)
      .setName("API Token")
      .setDesc("在 mineru.net API 管理中生成的 Bearer Token（无需手动加 Bearer 前缀）")
      .addText((text) =>
        text
          .setPlaceholder("粘贴 API Token")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("解析公式")
      .setDesc("将识别到的数学内容输出为 LaTeX。插件会额外把 \\(...\\)/\\[...\\] 归一为 $...$/$$...$$，便于 Obsidian 渲染。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableFormula).onChange(async (value) => {
          this.plugin.settings.enableFormula = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("解析表格")
      .setDesc("请求 MinerU 识别并输出表格结构；关闭时表格可能退化为普通段落。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableTable).onChange(async (value) => {
          this.plugin.settings.enableTable = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("HTML 表格自动转 Markdown")
      .setDesc("开启后，新转换出的 Markdown 会自动把 <table>...</table> 转为 Markdown 表格，便于后续编辑。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoConvertHtmlTablesToMarkdown).onChange(async (value) => {
          this.plugin.settings.autoConvertHtmlTablesToMarkdown = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("模型版本")
      .setDesc("pipeline 更快，vlm 公式识别更准但更慢")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("pipeline", "pipeline（快速）")
          .addOption("vlm", "vlm（高精度）")
          .setValue(this.plugin.settings.modelVersion)
          .onChange(async (value) => {
            this.plugin.settings.modelVersion = value as MineruModelVersion;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Mathpix 设置" });

    new Setting(containerEl)
      .setName("MATHPIX_APP_ID")
      .setDesc("Mathpix API 的 app_id。")
      .addText((text) =>
        text
          .setPlaceholder("粘贴 MATHPIX_APP_ID")
          .setValue(this.plugin.settings.mathpixAppId)
          .onChange(async (value) => {
            this.plugin.settings.mathpixAppId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("MATHPIX_APP_KEY")
      .setDesc("Mathpix API 的 app_key。")
      .addText((text) =>
        text
          .setPlaceholder("粘贴 MATHPIX_APP_KEY")
          .setValue(this.plugin.settings.mathpixAppKey)
          .onChange(async (value) => {
            this.plugin.settings.mathpixAppKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Pandoc 设置" });

    new Setting(containerEl)
      .setName("Pandoc 路径（可选）")
      .setDesc("留空则使用系统 PATH 中的 pandoc，可填写完整路径。")
      .addText((text) =>
        text
          .setPlaceholder("例如：/usr/local/bin/pandoc")
          .setValue(this.plugin.settings.pandocPath)
          .onChange(async (value) => {
            this.plugin.settings.pandocPath = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
