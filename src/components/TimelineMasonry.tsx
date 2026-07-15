import { useCallback, useState } from "react";
import type { TimelineEntry } from "../../shared/api";
import { TimelineMasonryItem } from "./TimelineMasonryItem";

interface TimelineMasonryProps {
  entries: TimelineEntry[];
  onOpenEntry: (entryId: string) => void;
}

export function TimelineMasonry({ entries, onOpenEntry }: TimelineMasonryProps) {
  const [spans, setSpans] = useState<Record<string, number>>({});

  const onSpanChange = useCallback((entryId: string, span: number) => {
    setSpans((current) => current[entryId] === span ? current : { ...current, [entryId]: span });
  }, []);

  function rowStart(index: number, columnCount: number): number {
    const column = index % columnCount;
    let start = 1;
    for (let previousIndex = column; previousIndex < index; previousIndex += columnCount) {
      start += spans[entries[previousIndex]?.id ?? ""] ?? 60;
    }
    return start;
  }

  return (
    <div className="entry-grid entry-grid--timeline">
      {entries.map((entry, index) => (
        <TimelineMasonryItem
          entry={entry}
          index={index}
          key={entry.id}
          rowStart1={rowStart(index, 1)}
          rowStart2={rowStart(index, 2)}
          rowStart3={rowStart(index, 3)}
          onOpen={onOpenEntry}
          onSpanChange={onSpanChange}
        />
      ))}
    </div>
  );
}
