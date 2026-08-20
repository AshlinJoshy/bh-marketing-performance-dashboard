// Verifies the PIN and issues the gate cookie. The PIN is compared here, on the
// server, so it never reaches the browser bundle.
import { NextResponse } from "next/server";
import { GATE_COOKIE, PIN, expectedToken, safeEqual } from "@/lib/gate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let pin = "";
  try {
    pin = String(((await req.json()) as { pin?: unknown })?.pin ?? "");
  } catch {
    /* empty body → treated as a wrong PIN */
  }

  // A deliberate delay on every attempt. A four digit PIN is only 10,000
  // combinations, so without this a script could exhaust the space in seconds.
  // It does not make the PIN strong; it makes brute forcing it slow.
  await new Promise((r) => setTimeout(r, 400));

  if (!safeEqual(pin.trim(), PIN)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: GATE_COOKIE,
    value: await expectedToken(),
    httpOnly: true, // unreadable from JavaScript
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12, // a working day, then re-enter it
  });
  return res;
}
