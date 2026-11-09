import type { CoreCalls, CoreEvents, MainCalls, MainEvents } from "./contract";
import type { EventPayload, NestedApi } from "./define";

export type TreepeekEvents = MainEvents & CoreEvents;
export type TreepeekEventName = keyof TreepeekEvents & string;
export type TreepeekListener<K extends TreepeekEventName> = (
  payload: EventPayload<TreepeekEvents[K]>,
) => void;

/**
 * `window.treepeek`: the only API the renderer has, generated from the contract and frozen.
 *
 * - `main.*` calls go to the main process (native actions, settings).
 * - `core.*` calls go straight to the core service over the window's MessagePort.
 * - `on` subscribes to an event and returns the unsubscribe function. State-like events
 *   (`theme.changed`, `core.state`) replay their latest value to a new subscriber.
 */
export interface TreepeekApi {
  readonly main: NestedApi<MainCalls>;
  readonly core: NestedApi<CoreCalls>;
  on<K extends TreepeekEventName>(event: K, listener: TreepeekListener<K>): () => void;
  off<K extends TreepeekEventName>(event: K, listener: TreepeekListener<K>): void;
}
