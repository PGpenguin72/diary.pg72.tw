import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EntryBlock } from "../../shared/api";
import { blockMarkdown } from "../lib/entry-markdown";

const markdownComponents: Components = {
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

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
