import { describe, expect, it } from "vitest";
import { calculateStreaks } from "../worker/lib/streaks";

describe("calculateStreaks", () => {
  it("counts a run ending today", () => {
    expect(
      calculateStreaks(
        ["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15"],
        "2026-07-15",
      ),
    ).toEqual({ current: 4, longest: 4 });
  });

  it("keeps yesterday's run current before today's entry exists", () => {
    expect(
      calculateStreaks(
        ["2026-07-09", "2026-07-12", "2026-07-13", "2026-07-14"],
        "2026-07-15",
      ),
    ).toEqual({ current: 3, longest: 3 });
  });

  it("deduplicates local dates and reports zero for no entries", () => {
    expect(calculateStreaks([], "2026-07-15")).toEqual({ current: 0, longest: 0 });
    expect(
      calculateStreaks(["2026-07-14", "2026-07-14", "2026-07-15"], "2026-07-15"),
    ).toEqual({ current: 2, longest: 2 });
  });
});
