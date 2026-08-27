/**
 * Isomorphic Sleeper API client.
 *
 * Runs unchanged in Node 18+ and in the browser: both have global fetch, and this
 * module has zero dependencies. `scripts/bake.mjs` imports it to write the committed
 * snapshot; `assets/app.js` imports it for the in-page Refresh button.
 *
 * Sleeper's read API needs no key and sends `access-control-allow-origin: *`,
 * which is what makes the browser-side refresh possible at all.
 *
 * Endpoint reference: https://docs.sleeper.com/
 */

const BASE = "https://api.sleeper.app/v1";

/** Sleeper asks for <1000 calls/min. A pool of 8 keeps a full history pull well under that. */
const DEFAULT_CONCURRENCY = 8;

/**
 * GET a Sleeper endpoint and parse JSON.
 *
 * Sleeper returns `null` (200, body "null") rather than 404 for things that don't
 * exist -- an unplayed week's matchups, a league with no drafts. Callers treat
 * null as empty, so we pass it through untouched.
 */
export async function api(path, { retries = 3 } = {}) {
  const url = `${BASE}${path}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        // Rate limited: back off and retry rather than losing the whole pull.
        await sleep(1000 * (attempt + 1));
        continue;
      }
      // A 4xx means the request itself is wrong -- almost always a bad league id.
      // Retrying cannot fix that, so fail immediately instead of stalling the UI.
      if (res.status >= 400 && res.status < 500) {
        throw Object.assign(new Error(`Sleeper ${res.status} for ${path}`), { fatal: true });
      }
      if (!res.ok) throw new Error(`Sleeper ${res.status} for ${path}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err?.fatal || attempt === retries) break;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error(`Sleeper request failed: ${path}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with bounded concurrency, preserving input order in the results. */
export async function pool(items, worker, concurrency = DEFAULT_CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Single-resource endpoints
// ---------------------------------------------------------------------------

export const getState = () => api("/state/nfl");
export const getUser = (usernameOrId) => api(`/user/${usernameOrId}`);
export const getUserLeagues = (userId, season) => api(`/user/${userId}/leagues/nfl/${season}`);

export const getLeague = (leagueId) => api(`/league/${leagueId}`);
export const getRosters = (leagueId) => api(`/league/${leagueId}/rosters`);
export const getLeagueUsers = (leagueId) => api(`/league/${leagueId}/users`);
export const getTransactions = (leagueId, week) => api(`/league/${leagueId}/transactions/${week}`);
export const getMatchups = (leagueId, week) => api(`/league/${leagueId}/matchups/${week}`);
export const getWinnersBracket = (leagueId) => api(`/league/${leagueId}/winners_bracket`);
export const getLosersBracket = (leagueId) => api(`/league/${leagueId}/losers_bracket`);
export const getTradedPicks = (leagueId) => api(`/league/${leagueId}/traded_picks`);
export const getDrafts = (leagueId) => api(`/league/${leagueId}/drafts`);
export const getDraftPicks = (draftId) => api(`/draft/${draftId}/picks`);

/**
 * The full NFL player dictionary -- roughly 5 MB.
 *
 * Never call this on page load. The bake script downloads it once and writes a
 * trimmed map of only the players this league has actually touched; the browser
 * falls back to this endpoint only when a refresh surfaces an unknown player id,
 * and caches the result.
 */
export const getAllPlayers = () => api("/players/nfl");

export const avatarUrl = (avatarId, size = "thumbs") =>
  avatarId ? `https://sleepercdn.com/avatars/${size}/${avatarId}` : null;

// ---------------------------------------------------------------------------
// League history
// ---------------------------------------------------------------------------

/**
 * Walk `previous_league_id` back to the league's first season.
 *
 * A dynasty league is a chain of one league object per season, each pointing at
 * its predecessor. Returns oldest season first.
 */
export async function getLeagueChain(leagueId, { maxSeasons = 40 } = {}) {
  const chain = [];
  const seen = new Set();
  let id = leagueId;

  while (id && !seen.has(id) && chain.length < maxSeasons) {
    seen.add(id);
    const league = await getLeague(id);
    if (!league) break;
    chain.push(league);
    // "0" and "" both show up in the wild for "no predecessor".
    id = league.previous_league_id && league.previous_league_id !== "0"
      ? league.previous_league_id
      : null;
  }

  return chain.reverse();
}

/**
 * How many weeks of transactions to ask for in a season.
 *
 * Sleeper indexes transactions by week, offseason moves land in week 1, and
 * there is no "give me everything" endpoint -- so we sweep a fixed range.
 * 18 covers the regular season plus playoffs in every era of the league.
 */
const TRANSACTION_WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);

/**
 * Weeks to sweep for matchups. Same reasoning as transactions: there is no
 * bulk endpoint, so we ask week by week and keep whatever comes back.
 */
const MATCHUP_WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);

/**
 * Pull one season: league meta, rosters, managers, every transaction, drafts,
 * traded picks, and the playoff bracket.
 */
export async function fetchSeason(league, { onProgress } = {}) {
  const leagueId = league.league_id;
  const note = (msg) => onProgress?.(`${league.season}: ${msg}`);

  note("rosters and managers");
  const [rosters, users, tradedPicks, drafts] = await Promise.all([
    getRosters(leagueId),
    getLeagueUsers(leagueId),
    getTradedPicks(leagueId),
    getDrafts(leagueId),
  ]);

  note("transactions");
  const weeks = await pool(TRANSACTION_WEEKS, (week) => getTransactions(leagueId, week));
  const transactions = weeks.flat().filter(Boolean);

  note("drafts");
  const draftDetail = await pool(drafts ?? [], async (draft) => ({
    ...draft,
    picks: (await getDraftPicks(draft.draft_id)) ?? [],
  }));

  // Weekly matchups carry the per-week scores and the pairings. Sleeper returns
  // the schedule with points of 0 before games are played, so a future season's
  // slate is available for projections as soon as it is set.
  note("weekly matchups");
  const matchupWeeks = await pool(MATCHUP_WEEKS, async (week) => ({
    week,
    entries: (await getMatchups(leagueId, week)) ?? [],
  }));
  const matchups = matchupWeeks.filter((w) => w.entries.length > 0);

  // Brackets only exist once a season reaches the playoffs; in-progress and
  // brand-new seasons legitimately return null here.
  note("playoff bracket");
  const [winnersBracket, losersBracket] = await Promise.all([
    getWinnersBracket(leagueId).catch(() => null),
    getLosersBracket(leagueId).catch(() => null),
  ]);

  return {
    league,
    season: league.season,
    rosters: rosters ?? [],
    users: users ?? [],
    transactions,
    drafts: draftDetail,
    tradedPicks: tradedPicks ?? [],
    matchups,
    winnersBracket: winnersBracket ?? [],
    losersBracket: losersBracket ?? [],
  };
}

/**
 * Pull every season of a dynasty league, oldest first.
 *
 * `leagueId` may be any season's id -- the chain walk finds the rest.
 */
export async function fetchLeagueHistory(leagueId, { onProgress } = {}) {
  onProgress?.("finding league history");
  const chain = await getLeagueChain(leagueId);
  if (!chain.length) throw new Error(`No league found for id ${leagueId}`);

  const seasons = [];
  // Sequential by season so progress reads in order and we stay polite to the API.
  for (const league of chain) {
    seasons.push(await fetchSeason(league, { onProgress }));
  }

  return {
    leagueId,
    fetchedAt: new Date().toISOString(),
    seasons,
  };
}
