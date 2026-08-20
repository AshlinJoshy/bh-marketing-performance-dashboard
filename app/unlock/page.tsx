import type { Metadata } from "next";
import { Suspense } from "react";
import PinGate from "@/components/PinGate";

export const metadata: Metadata = { title: "Enter PIN — betterhomes Marketing Hub" };

export default function UnlockPage() {
  // PinGate reads useSearchParams (the ?next= redirect target), which bails out
  // of prerendering unless it sits behind a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <PinGate />
    </Suspense>
  );
}
