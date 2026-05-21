import { normalizePath, TFile, TFolder, Vault } from "obsidian";

interface ResolveOutputDirectoryInput {
  overrideDirectory: string;
  pdfPath: string;
  vaultName: string;
}

export function resolveOutputDirectory(input: ResolveOutputDirectoryInput): string {
  const override = trimSlashes(input.overrideDirectory.trim());
  if (override.length > 0) {
    return normalizePath(override);
  }

  const segments = input.pdfPath.split("/");
  if (segments.length <= 1) {
    return `${input.vaultName}_MD`;
  }

  const parentSegments = segments.slice(0, -1);
  const sourceFolderName = parentSegments[parentSegments.length - 1];
  const targetFolderName = `${sourceFolderName}_MD`;

  if (parentSegments.length === 1) {
    return targetFolderName;
  }

  return normalizePath(`${parentSegments.slice(0, -1).join("/")}/${targetFolderName}`);
}

export async function ensureFolderExists(vault: Vault, folderPath: string): Promise<void> {
  if (!folderPath) {
    return;
  }

  const parts = folderPath.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = vault.getAbstractFileByPath(current);
    if (!existing) {
      await vault.createFolder(current);
      continue;
    }

    if (!(existing instanceof TFolder)) {
      throw new Error(`输出目录路径被文件占用：${current}`);
    }
  }
}

export function getUniqueMarkdownPath(vault: Vault, outputDir: string, baseName: string): string {
  const directory = trimSlashes(outputDir);
  const safeBaseName = baseName.trim() || "converted";
  const makePath = (suffix: string): string =>
    normalizePath(directory ? `${directory}/${safeBaseName}${suffix}.md` : `${safeBaseName}${suffix}.md`);

  let candidate = makePath("");
  let index = 1;

  while (vault.getAbstractFileByPath(candidate)) {
    candidate = makePath(`-${index}`);
    index += 1;
  }

  return candidate;
}

export function buildMarkdownDocument(pdfFile: TFile, markdownBody: string): string {
  return buildMarkdownDocumentWithSource(pdfFile, markdownBody, "source_pdf");
}

export function buildMarkdownDocumentWithSource(
  sourceFile: TFile,
  markdownBody: string,
  sourceField: string
): string {
  const created = new Date().toISOString().slice(0, 10);
  const title = escapeYaml(sourceFile.basename);
  const sourceValue = escapeYaml(sourceFile.path);
  const body = markdownBody.trimEnd();

  return `---
title: "${title}"
${sourceField}: "${sourceValue}"
converter: "Obsidian Anything to MD Converter"
created: ${created}
---

${body}
`;
}

function trimSlashes(input: string): string {
  return input.replace(/^\/+|\/+$/g, "");
}

function escapeYaml(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
