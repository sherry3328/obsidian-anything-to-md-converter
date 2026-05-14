import { App, PluginSettingTab, Setting } from "obsidian";

import type AnythingToMdPlugin from "./main";

export type MineruModelVersion = "pipeline" | "vlm";

export interface AnythingToMdSettings {
  apiToken: string;
  mathpixAppId: string;
  mathpixAppKey: string;
  outputDirectoryOverride: string;
  manualIgnoreEntries: string;
  enableFormula: boolean;
  enableTable: boolean;
  autoConvertHtmlTablesToMarkdown: boolean;
  modelVersion: MineruModelVersion;
}

export const DEFAULT_SETTINGS: AnythingToMdSettings = {
  apiToken: "",
  mathpixAppId: "",
  mathpixAppKey: "",
  outputDirectoryOverride: "",
  manualIgnoreEntries: "",
  enableFormula: true,
  enableTable: true,
  autoConvertHtmlTablesToMarkdown: true,
  modelVersion: "pipeline"
};

export class AnythingToMdSettingTab extends PluginSettingTab {
  plugin: AnythingToMdPlugin;

  constructor(app: App, plugin: AnythingToMdPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "共用设置" });

    new Setting(containerEl)
      .setName("输出目录（可选覆盖）")
      .setDesc("留空时输出到 PDF 所在目录同级的“原文件夹名_MD”")
      .addText((text) =>
        text
          .setPlaceholder("例如：Notes_MD")
          .setValue(this.plugin.settings.outputDirectoryOverride)
          .onChange(async (value) => {
            this.plugin.settings.outputDirectoryOverride = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("手动忽略文件/文件夹")
      .setDesc("每行一条规则，支持相对路径、文件名（如 demo.pdf）或目录名。")
      .addTextArea((text) =>
        text
          .setPlaceholder("例如：\nexamples\nlatex-output\nA/B/notes.pdf")
          .setValue(this.plugin.settings.manualIgnoreEntries)
          .onChange(async (value) => {
            this.plugin.settings.manualIgnoreEntries = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "MinerU 设置" });

    new Setting(containerEl)
      .setName("API Token")
      .setDesc("在 MinerU 平台生成的 API Token（无需手动添加 Bearer 前缀）")
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
      .setDesc("控制 MinerU 是否识别数学公式")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableFormula).onChange(async (value) => {
          this.plugin.settings.enableFormula = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("解析表格")
      .setDesc("控制 MinerU 是否识别表格结构")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableTable).onChange(async (value) => {
          this.plugin.settings.enableTable = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("HTML 表格自动转 Markdown")
      .setDesc("开启后，新转换的 Markdown 会自动把 <table>...</table> 转为 Markdown 表格。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoConvertHtmlTablesToMarkdown).onChange(async (value) => {
          this.plugin.settings.autoConvertHtmlTablesToMarkdown = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("模型版本")
      .setDesc("pipeline 更快，vlm 更偏向高精度")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("pipeline", "pipeline")
          .addOption("vlm", "vlm")
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
  }
}
