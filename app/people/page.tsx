import type { Metadata } from "next";
import PeopleSentiment from "@/components/PeopleSentiment";
import {
  getSocialConfig,
  getSocialMentions,
  getSocialRuns,
  getPerfConfig,
  getPerfMetrics,
  getPerfPosts,
  getPerfRuns,
} from "@/lib/data";

export const metadata: Metadata = {
  title: "People & Social — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const [config, mentions, runs, perfConfig, perfMetrics, perfPosts, perfRuns] = await Promise.all([
    getSocialConfig(),
    getSocialMentions(),
    getSocialRuns(),
    getPerfConfig(),
    getPerfMetrics(),
    getPerfPosts(),
    getPerfRuns(),
  ]);
  return (
    <PeopleSentiment
      config={config}
      mentions={mentions}
      runs={runs}
      perfConfig={perfConfig}
      perfMetrics={perfMetrics}
      perfPosts={perfPosts}
      perfRuns={perfRuns}
    />
  );
}
