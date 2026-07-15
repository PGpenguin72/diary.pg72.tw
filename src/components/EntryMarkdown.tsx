import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EntryBlock } from "../../shared/api";

const markdownComponents: Components = {
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

function blockMarkdown(block: EntryBlock): string {
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

export function EntryMarkdown({ blocks }: { blocks: EntryBlock[] }) {
  return (
    <div className="entry-prose">
      {blocks.map((block) => {
        const markdown = blockMarkdown(block);
        if (!markdown) return null;
        return (
          <Markdown key={block.id} remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {markdown}
          </Markdown>
        );
      })}
    </div>
  );
}
