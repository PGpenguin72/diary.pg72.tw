/**
 * Canonical entry-content derivations. Native creation, editing, and Apple
 * Journal import must all count words and build excerpts with this single
 * implementation so stored aggregates stay rebuildable and consistent.
 */

export function countWords(text: string): number {
  const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "word" });
  let count = 0;

  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) {
      count += 1;
    }
  }

  return count;
}

export function buildExcerpt(body: string): string {
  return body.replace(/\s+/g, " ").slice(0, 180);
}
