import type { SlotState } from "./state.ts";

export interface Candidate {
  readonly n: number;
  readonly state: SlotState;
}

/**
 * Cheapest rebuild first: the slot this worktree used last, then the warm slot whose last commit differs in
 * the fewest files (the longest unused on a tie, so an active agent keeps its slot), then slots never built.
 */
export function orderSlots(
  candidates: readonly Candidate[],
  worktree: string,
  filesBetween: (slotHead: string) => number | undefined,
): number[] {
  const rank = ({ state }: Candidate): [number, number] => {
    if (state.source === worktree) return [-1, 0];
    if (state.head === undefined) return [Number.MAX_SAFE_INTEGER, 0];
    return [filesBetween(state.head) ?? Number.MAX_SAFE_INTEGER - 1, state.usedAt ?? 0];
  };
  return candidates
    .map((candidate) => ({ n: candidate.n, rank: rank(candidate) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.n - b.n)
    .map(({ n }) => n);
}
