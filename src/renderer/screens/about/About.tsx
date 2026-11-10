import { useQuery } from "@tanstack/react-query";
import { main, unwrap } from "../../data/client";

/**
 * The About window: version, license, copyright, and the acknowledgements, which are the
 * `NOTICE` and third-party notices the build carries.
 */
export function About() {
  const info = useQuery({
    queryKey: ["about"],
    queryFn: async () => unwrap(await main().about.info()),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const about = info.data;
  return (
    <div className="flex h-full flex-col bg-background text-foreground" data-testid="about">
      <header className="app-drag h-10 shrink-0" />
      <main className="flex min-h-0 flex-1 flex-col gap-4 px-8 pb-6">
        <section className="text-center" aria-labelledby="about-title">
          <h1 id="about-title" className="font-semibold text-2xl tracking-tight">
            {about?.name ?? "Treepeek"}
          </h1>
          <p className="mt-1 text-sm" data-testid="about-version">
            {about ? `Version ${about.version}` : " "}
          </p>
          <p className="mt-3 text-sm" data-testid="about-copyright">
            {about?.copyright}
          </p>
          <p className="text-muted-foreground text-sm" data-testid="about-license">
            {about?.license}
          </p>
          {about && (
            <p className="mt-1 text-muted-foreground text-xs">
              Electron {about.versions.electron} · Chromium {about.versions.chrome} · Node{" "}
              {about.versions.node}
            </p>
          )}
        </section>
        <section
          aria-labelledby="acknowledgements-title"
          className="flex min-h-0 flex-1 flex-col"
          data-testid="acknowledgements"
        >
          <h2 id="acknowledgements-title" className="mb-2 font-medium text-sm">
            Acknowledgements
          </h2>
          {about && (about.notice || about.thirdPartyNotices) ? (
            <pre
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
              tabIndex={0}
              className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-3 font-mono text-card-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {[about.notice, about.thirdPartyNotices].filter(Boolean).join("\n\n")}
            </pre>
          ) : (
            <p className="text-muted-foreground text-sm" data-testid="acknowledgements-missing">
              {about
                ? "This build does not include the third-party notices. Release builds list every bundled open-source component and its license here."
                : " "}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
