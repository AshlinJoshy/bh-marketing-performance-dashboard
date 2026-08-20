// PIN gate. Runs BEFORE any route renders, which is the whole point: every tab
// is a force-dynamic server component that fetches its data during render, so a
// client-side gate would still spend Supermetrics rows and Metabase time before
// the prompt appeared. Blocking here means an unauthenticated visitor costs
// nothing.
//
// Next 16 renamed the `middleware` file convention to `proxy`. A middleware.ts
// in this project would simply never run.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { GATE_COOKIE, expectedToken, safeEqual } from "@/lib/gate";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The unlock screen and its endpoint must stay reachable, or the gate locks
  // out the only way through it.
  if (pathname === "/unlock" || pathname === "/api/unlock") return NextResponse.next();

  // The news cron carries its own CRON_SECRET check. Gating it would silently
  // break the daily job, since Vercel's scheduler has no cookie jar.
  if (pathname === "/api/ingest") return NextResponse.next();

  const token = request.cookies.get(GATE_COOKIE)?.value;
  if (token && safeEqual(token, await expectedToken())) return NextResponse.next();

  // API calls get a 401 rather than a redirect: a fetch following a 302 to an
  // HTML page would fail confusingly in the client.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "locked" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/unlock";
  // Remember where they were headed so unlocking lands them there.
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own assets and the favicon. Without a matcher this
  // would also gate CSS and JS, which would leave the unlock page unstyled.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
