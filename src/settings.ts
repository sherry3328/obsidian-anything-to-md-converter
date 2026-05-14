import { App, PluginSettingTab, Setting } from "obsidian";

import type AnythingToMdPlugin from "./main";

export type MineruModelVersion = "pipeline" | "vlm";

export interface AnythingToMdSettings {
  apiToken: string;
  outputDirectoryOverride: string;
  enableFormula: boolean;
  enableTable: boolean;
  modelVersion: MineruModelVersion;
}

export const DEFAULT_SETTINGS: AnythingToMdSettings = {
  apiToken: "",
  outputDirectoryOverride: "",
  enableFormula: true,
  enableTable: true,
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
  }
}
