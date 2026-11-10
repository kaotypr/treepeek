import { afterEach, describe, expect, it } from "vitest";
import { labelControls } from "../../../src/renderer/diff-view/pierre/a11y-labels";

describe("labelControls", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    document.body.replaceChildren();
  });

  function shadowWith(html: string): ShadowRoot {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = html;
    return root;
  }

  it("makes each code pane a named group the keyboard can reach", () => {
    const root = shadowWith(
      "<pre><code data-code data-deletions></code><code data-code data-additions></code></pre>",
    );
    stop = labelControls(root);
    const panes = [...root.querySelectorAll<HTMLElement>("[data-code]")];
    expect(panes.map((pane) => pane.getAttribute("aria-label"))).toEqual([
      "Old version",
      "New version",
    ]);
    for (const pane of panes) {
      expect(pane.getAttribute("role")).toBe("group");
      expect(pane.tabIndex).toBe(0);
    }
  });

  it("does the same for panes the library renders later", async () => {
    const root = shadowWith("<pre></pre>");
    stop = labelControls(root);
    root
      .querySelector("pre")
      ?.insertAdjacentHTML("beforeend", "<code data-code data-unified></code>");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pane = root.querySelector<HTMLElement>("[data-unified]");
    expect(pane?.getAttribute("aria-label")).toBe("Changes");
    expect(pane?.tabIndex).toBe(0);
  });

  it("names the show-hidden-lines controls", () => {
    const root = shadowWith('<div data-expand-button data-expand-up role="button"></div>');
    stop = labelControls(root);
    expect(root.querySelector("[data-expand-button]")?.getAttribute("aria-label")).toBe(
      "Show unchanged lines above",
    );
  });
});
