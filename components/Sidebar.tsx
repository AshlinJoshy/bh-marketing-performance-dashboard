"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState } from "react";

type NavItem = { href: string; label: string; icon: string; soon?: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/company", label: "Company Performance", icon: "🏢" },
  { href: "/pr", label: "PR & Media", icon: "📰" },
  { href: "/people", label: "People Sentiment", icon: "💬" },
  { href: "/website", label: "Website", icon: "🌐" },
  { href: "/seo", label: "SEO", icon: "🔍" },
  { href: "/digital", label: "Digital Performance", icon: "📈" },
  { href: "/portals", label: "Portals", icon: "🏠" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  /**
   * Routes already warmed. State, not a ref: the prefetch prop is read during
   * render, and refs must not be.
   */
  const [warmed, setWarmed] = useState<ReadonlySet<string>>(() => new Set());

  /**
   * Warm a tab when the pointer reaches it, rather than warming all of them on
   * load. Every tab is force-dynamic, so a prefetch is a real server render —
   * six of those fired eagerly would mean six Metabase and Supermetrics reads
   * per visit for tabs nobody opened. On intent it's one, for a tab about to be
   * opened, and it makes the click feel instant.
   */
  const warm = useCallback(
    (href: string) => {
      if (href === pathname || warmed.has(href)) return;
      // Outside the updater on purpose: a state updater must be pure, and
      // StrictMode invokes it twice — which would fire two prefetches.
      router.prefetch(href);
      setWarmed((prev) => new Set(prev).add(href));
    },
    [router, pathname, warmed],
  );

  return (
    <div id="sidebar">
      <div className="sidebar-brand">
        <div className="brand-name">betterhomes</div>
        <div className="brand-sub">Marketing Hub</div>
      </div>
      <nav>
        {NAV.map((item) => {
          const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          if (item.soon) {
            return (
              <span key={item.href} className="nav-item soon" title="Coming soon">
                {item.icon} <span>{item.label}</span>
                <span className="soon-tag">soon</span>
              </span>
            );
          }
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${active ? " active" : ""}`}
              // false until intent, then null restores Next's default prefetch.
              prefetch={warmed.has(item.href) ? null : false}
              onMouseEnter={() => warm(item.href)}
              onFocus={() => warm(item.href)}
              onTouchStart={() => warm(item.href)}
            >
              {item.icon} <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <div className="pulse-dot" />
        <span>Live · betterhomes</span>
      </div>
    </div>
  );
}
