import Link from "next/link";
import { Activity, Bell, Film, Library, Settings } from "lucide-react";
import { SearchNavLink } from "./search-memory";
import { ActivityNavBadge } from "./activity-nav-badge";
import { NotificationsNavBadge } from "./notifications-nav-badge";

export function AppSidebar({
  active,
  searchQuery = "",
}: {
  active: "search" | "library" | "notifications" | "activity" | "settings" | "none";
  searchQuery?: string;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Film size={18} aria-hidden />
        </span>
        <span className="brand-copy">
          <strong>Media Track</strong>
          <span>115 library ops</span>
        </span>
      </div>

      <nav aria-label="主导航">
        <ul className="nav-list">
          <li>
            <SearchNavLink active={active === "search"} knownQuery={searchQuery} />
          </li>
          <li>
            <Link
              className={`nav-item ${active === "library" ? "is-active" : ""}`}
              href="/?tab=library"
            >
              <Library size={16} aria-hidden />
              媒体库
            </Link>
          </li>
          <li>
            <Link
              className={`nav-item ${active === "notifications" ? "is-active" : ""}`}
              href="/notifications"
            >
              <Bell size={16} aria-hidden />
              通知
              <NotificationsNavBadge />
            </Link>
          </li>
          {/* 活动 + 设置 are secondary: on desktop they live in the footer; on the
              mobile top bar (footer hidden) they surface as nav items here. */}
          <li className="nav-activity-item">
            <Link
              className={`nav-item ${active === "activity" ? "is-active" : ""}`}
              href="/activity"
            >
              <Activity size={16} aria-hidden />
              活动
              <ActivityNavBadge />
            </Link>
          </li>
          <li className="nav-settings-item">
            <Link
              className={`nav-item ${active === "settings" ? "is-active" : ""}`}
              href="/settings"
            >
              <Settings size={16} aria-hidden />
              设置
            </Link>
          </li>
        </ul>
      </nav>

      <div className="sidebar-footer">
        <Link
          className={`nav-item nav-secondary ${active === "activity" ? "is-active" : ""}`}
          href="/activity"
        >
          <Activity size={16} aria-hidden />
          活动
          <ActivityNavBadge />
        </Link>
        <Link className="health-card" href="/settings" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="health-icon">
            <Settings size={16} aria-hidden />
          </span>
          <span>
            <strong>设置</strong>
            <span>115 连接 · 推送 · 偏好</span>
          </span>
        </Link>
      </div>
    </aside>
  );
}
