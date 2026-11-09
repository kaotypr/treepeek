import { useEffect, useState } from "react";
import type { TreepeekEventName, TreepeekListener } from "../../shared/ipc/api";

type Payload<K extends TreepeekEventName> = Parameters<TreepeekListener<K>>[0];

/** The latest payload of an event (sticky events replay their current value at once). */
export function useLatestEvent<K extends TreepeekEventName>(name: K): Payload<K> | null {
  const [payload, setPayload] = useState<Payload<K> | null>(null);
  useEffect(() => window.treepeek.on(name, (next) => setPayload(() => next)), [name]);
  return payload;
}
