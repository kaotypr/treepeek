/**
 * The window's undo stack for "Mark all as reviewed" and "Unmark all" (review-marks design,
 * rule 6): each entry is what one of them replaced, so ⌘Z can put it back. In memory and
 * per window; nothing else is undoable.
 */

import { createStore, useStore } from "zustand";
import type { PreviousMark } from "../../shared/domain/review";

export interface UndoEntry {
  checkoutPath: string;
  /** "Mark all as reviewed" or "Unmark all", for the notice after undoing it. */
  action: "markAll" | "unmarkAll";
  /** Each path the action changed, with its mark before (`null`: none). */
  previous: PreviousMark[];
}

/** Undo steps kept; older ones are dropped. */
export const UNDO_LIMIT = 20;

export interface UndoState {
  entries: UndoEntry[];
  push(entry: UndoEntry): void;
  /** The newest entry, removed from the stack. */
  pop(): UndoEntry | undefined;
  clear(): void;
}

export function createUndoStore() {
  return createStore<UndoState>()((set, get) => ({
    entries: [],
    push: (entry) => set((state) => ({ entries: [...state.entries, entry].slice(-UNDO_LIMIT) })),
    pop: () => {
      const entries = get().entries;
      const last = entries[entries.length - 1];
      if (last) set({ entries: entries.slice(0, -1) });
      return last;
    },
    clear: () => set({ entries: [] }),
  }));
}

/** This window's stack. */
export const undoStore = createUndoStore();

export function useUndo<T>(selector: (state: UndoState) => T): T {
  return useStore(undoStore, selector);
}
