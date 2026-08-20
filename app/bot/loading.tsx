import PageSkeleton from "@/components/PageSkeleton";

// Without this, the route has no loading boundary — so Next cannot prefetch a
// shell and the content area stays blank until the server responds.
export default function Loading() {
  return <PageSkeleton />;
}
