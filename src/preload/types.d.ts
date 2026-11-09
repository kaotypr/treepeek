import type { TreepeekApi } from "../shared/ipc/api";

declare global {
  interface Window {
    readonly treepeek: TreepeekApi;
  }
}
