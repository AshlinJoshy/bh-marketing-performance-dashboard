#!/usr/bin/env node
/**
 * Hunt for a LinkedIn Apify actor that actually returns a company's posts.
 *
 * Standalone on purpose: no imports from the app, no npm install. It runs on a
 * bare GitHub Actions runner, which (unlike the sandbox this repo is developed
 * in) can reach api.apify.com. That means actor candidates can be tried for
 * real instead of guessed at from documentation.
 *
 *   APIFY_TOKEN=... node scripts/probe-linkedin.mjs "https://www.linkedin.com/company/better-homes-llc"
 *
 * A FAILED attempt is as informative as a passing one: Apify rejects bad input
 * with an error naming the fields it expected, so validation errors reveal the
 * schema. Every attempt is therefore printed, not just the winner.
 */

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) {
  console.error("APIFY_TOKEN is not set. Add it as a repository secret.");
  process.exit(1);
}

const RAW = process.argv[2] || "https://www.linkedin.com/company/better-homes-llc";
const MAX_POSTS = Number(process.env.MAX_POSTS || 5); // a schema hunt, not a data pull
const PER_ATTEMPT_MS = Number(process.env.PER_ATTEMPT_MS || 90_000);

/** Accept a URL or a bare slug; derive both forms since actors differ on which they take. */
function bothForms(handle) {
  const h = handle.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const m = h.match(/^https?:\/\/(?:[a-z]{2}\.|www\.)?linkedin\.com\/(?:company|school)\/(.+)$/i);
  const slug = m ? m[1] : h.replace(/^@/, "");
  return { url: `https://www.linkedin.com/company/${slug}`, slug };
}

const { url, slug } = bothForms(RAW);

// KNOWN GOOD, confirmed against a live run: harvestapi/linkedin-company-posts
// takes `targetUrls` and returned 5 real posts for better-homes-llc. It's first
// so a re-run confirms the wiring in one attempt.
//
// The rest stay as fallbacks for when an actor changes. Heed the warning below:
// this actor's schema declares NO required fields, so a wrong key is dropped and
// the run SUCCEEDS with 0 rows. An EMPTY line here therefore means "wrong key OR
// dead URL" — it is never proof the page is wrong. Apify bills for empty
// queries too (~$0.001 each), so don't loop on this blindly.
const CANDIDATES = [
  ["harvestapi/linkedin-company-posts", { targetUrls: [url], maxPosts: MAX_POSTS }],
  ["harvestapi/linkedin-company-posts", { targetUrls: [slug], maxPosts: MAX_POSTS }],
  ["harvestapi/linkedin-company-posts", { companies: [url], maxPosts: MAX_POSTS }],
  ["harvestapi/linkedin-company-posts", { companyUrls: [url], maxPosts: MAX_POSTS }],
  ["harvestapi/linkedin-company-posts", { startUrls: [{ url }], maxPosts: MAX_POSTS }],
  ["harvestapi/linkedin-post-search", { targetUrls: [url], maxPosts: MAX_POSTS }],
  ["harvestapi/linkedin-post-search", { authorsCompanies: [url], maxPosts: MAX_POSTS }],
  ["unseenuser/company-posts", { targetUrls: [url], maxPosts: MAX_POSTS }],
  ["unseenuser/company-posts", { startUrls: [{ url }], maxPosts: MAX_POSTS }],
  ["calm_builder/linkedin-company-scraper", { startUrls: [{ url }], maxPosts: MAX_POSTS }],
];

async function runActor(actor, input, timeoutMs) {
  const secs = Math.max(20, Math.round(timeoutMs / 1000));
  const endpoint =
    `https://api.apify.com/v2/acts/${actor.replace("/", "~")}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(TOKEN)}&timeout=${secs}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 500)}`);
    const items = JSON.parse(text);
    return Array.isArray(items) ? items : [];
  } finally {
    clearTimeout(t);
  }
}

/** A real post: some text plus at least one engagement number. */
function looksLikePost(o) {
  if (!o || typeof o !== "object") return false;
  const text = o.text ?? o.content ?? o.postContent ?? o.description ?? o.message ?? o.commentary;
  if (typeof text !== "string" || !text.trim()) return false;
  return [
    o.likes, o.reactions, o.numLikes, o.reactionsCount, o.likesCount,
    o.comments, o.numComments, o.commentsCount,
    o.engagement?.likes, o.engagement?.reactions, o.engagement?.comments,
  ].some((v) => typeof v === "number");
}

function findFollowers(rows) {
  const keys = ["followers", "followerCount", "followersCount", "companyFollowers", "numFollowers"];
  for (const r of rows) {
    for (const holder of [r, r?.company, r?.companyProfile, r?.author, r?.profile]) {
      if (!holder || typeof holder !== "object") continue;
      for (const k of keys) if (typeof holder[k] === "number" && holder[k] > 0) return holder[k];
    }
  }
  return null;
}

console.log(`Probing LinkedIn actors`);
console.log(`  url  : ${url}`);
console.log(`  slug : ${slug}`);
console.log(`  ${CANDIDATES.length} candidates, maxPosts=${MAX_POSTS}\n`);

let winner = null;

// Serial: Apify caps total memory across simultaneous runs and answers 402 past
// it, which would show up as failures that are really just contention.
for (const [actor, input] of CANDIDATES) {
  const label = `${actor} ${Object.keys(input).filter((k) => k !== "maxPosts").join("+")}`;
  const started = Date.now();
  try {
    const rows = await runActor(actor, input, PER_ATTEMPT_MS);
    const postish = rows.filter(looksLikePost).length;
    const followers = findFollowers(rows);
    const ms = Date.now() - started;
    console.log(`${postish > 0 ? "PASS" : "EMPTY"}  ${label}`);
    console.log(`        rows=${rows.length} postish=${postish} followers=${followers ?? "?"} ${ms}ms`);
    if (rows.length) console.log(`        keys: ${Object.keys(rows[0]).slice(0, 25).join(", ")}`);
    if (postish > 0) {
      console.log(`        sample: ${JSON.stringify(rows.find(looksLikePost)).slice(0, 500)}`);
      winner = { actor, input, rows: rows.length, postish, followers };
      break;
    }
  } catch (e) {
    console.log(`FAIL  ${label}`);
    console.log(`        ${(e?.message ?? String(e)).replace(/\n+/g, " ").slice(0, 500)}`);
  }
  console.log("");
}

console.log("\n────────────────────────────────────");
if (winner) {
  console.log(`WINNER: ${winner.actor}`);
  console.log(`INPUT : ${JSON.stringify(winner.input)}`);
  console.log(`rows=${winner.rows} postish=${winner.postish} followers=${winner.followers ?? "?"}`);
} else {
  console.log("No candidate returned post-shaped rows.");
  console.log("The FAIL lines above name what each actor expected — that is the fix.");
  process.exitCode = 1;
}
