import { readFile } from "node:fs/promises";

import { z } from "zod";

export const JiraAdfDocumentSchema = z.object({
  type: z.literal("doc"),
  version: z.number().int().positive(),
  content: z.array(z.unknown()).min(1),
}).loose();

export type JiraAdfDocument = z.infer<typeof JiraAdfDocumentSchema>;
export type JiraAdfInputKind = "plain-text" | "adf";

export interface JiraAdfBodySourceFlags {
  readonly adfFile?: string;
  readonly text?: string;
  readonly textFile?: string;
}

export type JiraAdfBodySource =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "text-file"; readonly value: string }
  | { readonly kind: "adf-file"; readonly value: string };

export interface JiraAdfBodyInput {
  readonly document: JiraAdfDocument;
  readonly inputKind: JiraAdfInputKind;
}

export function textToAdfDocument(text: string): JiraAdfDocument {
  const normalized = text.replaceAll(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    throw new Error("ADF text input must not be empty.");
  }

  return {
    type: "doc",
    version: 1,
    content: normalized.split(/\n[ \t]*\n+/u).map(paragraphToAdfNode),
  };
}

export function parseJiraAdfDocument(value: unknown, label: string): JiraAdfDocument {
  const parsed = JiraAdfDocumentSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(`${label} must contain a valid ADF document with type "doc", version, and non-empty content array.`);
}

export function selectJiraAdfBodySource(flags: JiraAdfBodySourceFlags): JiraAdfBodySource {
  const sources = [
    ...(flags.text === undefined ? [] : [{ kind: "text" as const, value: flags.text }]),
    ...(flags.textFile === undefined ? [] : [{ kind: "text-file" as const, value: flags.textFile }]),
    ...(flags.adfFile === undefined ? [] : [{ kind: "adf-file" as const, value: flags.adfFile }]),
  ];
  if (sources.length !== 1) {
    throw new Error("Exactly one body source is required: --text, --text-file, or --adf-file.");
  }
  const source = sources[0];
  if (source === undefined) {
    throw new Error("Exactly one body source is required: --text, --text-file, or --adf-file.");
  }
  return source;
}

export async function readJiraAdfBodyInput(flags: JiraAdfBodySourceFlags): Promise<JiraAdfBodyInput> {
  const source = selectJiraAdfBodySource(flags);
  if (source.kind === "text") {
    return { inputKind: "plain-text", document: textToAdfDocument(source.value) };
  }
  if (source.kind === "text-file") {
    return { inputKind: "plain-text", document: textToAdfDocument(await readTextFileSource(source.value, "--text-file")) };
  }

  return {
    inputKind: "adf",
    document: parseJiraAdfDocument(
      parseJson(await readTextFileSource(source.value, "--adf-file"), "--adf-file"),
      "--adf-file",
    ),
  };
}

function paragraphToAdfNode(paragraph: string): Record<string, unknown> {
  return {
    type: "paragraph",
    content: paragraph.split("\n").flatMap(lineToAdfInlineNodes),
  };
}

function lineToAdfInlineNodes(line: string, index: number): readonly Record<string, unknown>[] {
  const textNode = line.length === 0 ? [] : [{ type: "text", text: line }];
  return index === 0 ? textNode : [{ type: "hardBreak" }, ...textNode];
}

async function readTextFileSource(path: string, label: string): Promise<string> {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must include a non-empty file path.`);
  }
  return await readFile(trimmed, "utf8");
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}
