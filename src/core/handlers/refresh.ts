import { coreCalls, err, ok } from "../../shared/ipc";
import type { Session, SessionServices } from "../sessions/session";

/** Test-only channels answer only when the app runs with `NODE_ENV=test`. */
function testHooksEnabled(): boolean {
  return process.env.NODE_ENV === "test";
}

/**
 * Live refresh's calls: `refresh.resume` (the Refresh button after an event storm or a
 * watcher failure; the window rescans after it), `refresh.foreground` (a host showing or
 * hiding the session's views) and the test-only `test.liveRefresh`.
 */
export function registerRefreshHandlers(session: Session, services: SessionServices): void {
  session.rpc.onCall(coreCalls["refresh.resume"], async () => {
    await services.live?.resume(session);
    return ok({});
  });

  session.rpc.onCall(coreCalls["refresh.foreground"], (_ctx, request) => {
    services.live?.setForeground(session, request.foreground);
    return ok({});
  });

  session.rpc.onCall(coreCalls["test.liveRefresh"], (_ctx, request) => {
    if (!testHooksEnabled()) {
      return err("invalidRequest", "test.liveRefresh is only available in end-to-end test runs.");
    }
    const live = services.live;
    if (!live) return err("internal", "Live refresh is not running.");
    if (request.suspend !== undefined) {
      live.watch.suspend(request.suspend);
      session.log.info("test: live refresh events", { suspended: request.suspend });
    }
    return ok({
      ...live.info(),
      rssBytes: process.memoryUsage().rss,
      calls: session.rpc.callCounts(),
    });
  });
}
