import { AppSidebar } from "../../components/app-sidebar";
import { ActivityFeed } from "../../components/activity-feed";
import { resolveGlobalWorkspace } from "../../lib/workflow-runtime";

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  const { w } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);
  return (
    <div className="app-shell">
      <AppSidebar active="activity" basePath={workspace.basePath} activeStorageId={workspace.activeStorageId} />
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div>
            <h1>活动</h1>
            <p>点了获取之后，资源在这里逐个被处理 —— 看得见 agent 正在干什么</p>
          </div>
        </div>
        {/* ActivityFeed is a client component in the page's STATIC shell (not inside a
            Suspense'd async server component — those don't hydrate, which froze the
            live poll). It self-fetches /api/activity on mount and polls. */}
        <ActivityFeed storageId={workspace.activeStorageId} />
      </main>
    </div>
  );
}
