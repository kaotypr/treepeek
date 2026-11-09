import {
  isKnownStart,
  type Relation,
  type Start,
  type TimelineEntry,
} from "../../shared/domain/scan";

/** What the timeline needs of a checkout. */
export interface TimelineInput {
  checkoutPath: string;
  commonDir: string;
  /** Path relative to the scan root; breaks ties. */
  relativePath: string;
  start: Start;
  head: string | null;
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant` in `commonDir`'s repository. */
export type AncestryCheck = (
  commonDir: string,
  ancestor: string,
  descendant: string,
) => Promise<boolean>;

/**
 * Orders every checkout of the scan (domain model, Timeline):
 *
 * 1. by `start.observedAt`, oldest first; unknown starts last; ties by relative path;
 * 2. numbered `1…n` across the whole scan;
 * 3. each checkout's predecessor is the previous checkout of the same repository;
 * 4. the relation is `first` without a predecessor, `after` when the predecessor's current
 *    HEAD is an ancestor of this checkout's start, and `parallel` otherwise (an unknown
 *    start, or a predecessor without commits, cannot be `after`).
 *
 * Returns the entries in timeline order.
 */
export async function buildTimeline(
  inputs: readonly TimelineInput[],
  isAncestor: AncestryCheck,
): Promise<TimelineEntry[]> {
  const ordered = [...inputs].sort(compareInputs);
  const previous = new Map<string, TimelineInput>();
  const pairs = ordered.map((input) => {
    const predecessor = previous.get(input.commonDir) ?? null;
    previous.set(input.commonDir, input);
    return { input, predecessor };
  });
  const relations = await Promise.all(
    pairs.map(({ input, predecessor }) => relationOf(input, predecessor, isAncestor)),
  );
  return pairs.map(({ input, predecessor }, index) => ({
    sequence: index + 1,
    checkoutPath: input.checkoutPath,
    commonDir: input.commonDir,
    predecessor: predecessor?.checkoutPath ?? null,
    relation: relations[index] ?? "parallel",
  }));
}

async function relationOf(
  input: TimelineInput,
  predecessor: TimelineInput | null,
  isAncestor: AncestryCheck,
): Promise<Relation> {
  if (!predecessor) return "first";
  if (!isKnownStart(input.start) || predecessor.head === null) return "parallel";
  return (await isAncestor(input.commonDir, predecessor.head, input.start.commit))
    ? "after"
    : "parallel";
}

function compareInputs(a: TimelineInput, b: TimelineInput): number {
  const aTime = isKnownStart(a.start) ? Date.parse(a.start.observedAt) : Number.POSITIVE_INFINITY;
  const bTime = isKnownStart(b.start) ? Date.parse(b.start.observedAt) : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
}
