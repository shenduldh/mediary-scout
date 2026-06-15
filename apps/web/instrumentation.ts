/**
 * Next.js instrumentation: runs once when the server process starts. We use it
 * to start the in-process queue worker so that a browser "获取" click actually
 * runs the workflow end-to-end (claim → run → persist → UI updates) without any
 * external poke. Node runtime only — the Edge runtime can't run the workflow.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  console.log("[instrumentation] register() — starting in-process queue worker");
  const { startBackgroundWorker } = await import("./lib/background-worker");
  startBackgroundWorker();
}
