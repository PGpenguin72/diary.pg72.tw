import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { TimelineEntry } from "../../shared/api";
import { EntryCard } from "./EntryCard";

const masonryRowHeight = 4;
const masonryGap = 16;

function measureMasonrySpan(item: HTMLDivElement): number {
  const height = item.getBoundingClientRect().height;
  return Math.max(1, Math.ceil((height + masonryGap) / masonryRowHeight));
}

interface TimelineMasonryItemProps {
  entry: TimelineEntry;
  index: number;
  rowStart1: number;
  rowStart2: number;
  rowStart3: number;
  onOpen: (entryId: string) => void;
  onSpanChange: (entryId: string, span: number) => void;
}

export function TimelineMasonryItem({
  entry,
  index,
  rowStart1,
  rowStart2,
  rowStart3,
  onOpen,
  onSpanChange,
}: TimelineMasonryItemProps) {
  const itemRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef(60);
  const [span, setSpan] = useState(60);

  useLayoutEffect(() => {
    const item = itemRef.current;
    if (!item) return;
    const element: HTMLDivElement = item;

    function updateSpan() {
      const nextSpan = measureMasonrySpan(element);
      if (nextSpan === spanRef.current) return;
      spanRef.current = nextSpan;
      setSpan(nextSpan);
      onSpanChange(entry.id, nextSpan);
    }

    const observer = new ResizeObserver(updateSpan);
    observer.observe(element);
    updateSpan();
    return () => observer.disconnect();
  }, [entry.id, onSpanChange]);

  return (
    <div
      ref={itemRef}
      className="timeline-masonry-item"
      style={{
        "--timeline-column-3": index % 3 + 1,
        "--timeline-column-2": index % 2 + 1,
        "--timeline-row-span": span,
        "--timeline-row-start-1": rowStart1,
        "--timeline-row-start-2": rowStart2,
        "--timeline-row-start-3": rowStart3,
      } as CSSProperties}
    >
      <EntryCard entry={entry} onOpen={onOpen} />
    </div>
  );
}
