import type { EntryBlock } from "../../shared/api";

export function blockMarkdown(block: EntryBlock): string {
  const text = block.text?.trim() ?? "";
  if (!text) return "";

  if (block.type === "quote" && !text.startsWith(">")) {
    return text.split("\n").map((line) => `> ${line}`).join("\n");
  }
  if (block.type === "list" && !/^\s*(?:[-*+] |\d+\. )/m.test(text)) {
    return text.split("\n").map((line) => `- ${line}`).join("\n");
  }
  if (block.type === "heading" && !/^#{1,6}\s/.test(text)) {
    return `## ${text}`;
  }

  return text;
}
