// Verifies a PIN and issues the matching gate cookie. Both PINs are compared
// here, on the server, so neither reaches the browser bundle.
import { NextResponse } from "next/server";
import { COOKIES, PINS, expectedToken, isScope, safeEqual } from "@/lib/gate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let pin = "";
  let scope: "app" | "settings" = "app";
  try {
    const body = (await req.json()) as { pin?: unknown; scope?: unknown };
    pin = String(body?.pin ?? "");
    if (isScope(body?.scope)) scope = body.scope;
  } catch {
    /* empty body → treated as a wrong PIN */
  }

  // A deliberate delay on every attempt. A four digit PIN is only 10,000
  // combinations, so without this a script could exhaust the space in seconds.
  // It does not make the PIN strong; it makes brute forcing it slow.
  await new Promise((r) => setTimeout(r, 400));

  if (!safeEqual(pin.trim(), PINS[scope])) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, scope });
  res.cookies.set({
    name: COOKIES[scope],
    value: await expectedToken(scope),
    httpOnly: true, // unreadable from JavaScript
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Settings expires sooner: it is an occasional administrative act, and a
    // long lived cookie on a shared machine is the likelier way it leaks.
    maxAge: scope === "settings" ? 60 * 60 : 60 * 60 * 12,
  });
  return res;
}
