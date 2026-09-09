/**
 * KeepTradeCut dynasty values.
 *
 * KTC has no public API. Their rankings page embeds the full dataset in a
 * `<script id="ktc-players" type="application/json">` tag, which is what this
 * reads — parsing the JSON payload rather than scraping rendered HTML or
 * regexing JavaScript, so it is about as stable as an unofficial source gets.
 * It is still unofficial: if KTC changes that tag, this returns nothing and the
 * bake carries on without values rather than failing.
 *
 * **Node only.** keeptradecut.com sends no `access-control-allow-origin`, so a
 * browser cannot fetch it. That is why values are baked into data/ktc.json and
 * the in-page Refresh button reuses the last baked set instead of re-fetching.
 */

const RANKINGS_URL = "https://keeptradecut.com/dynasty-rankings";

/** A browser-ish UA; the plain curl/node default gets less predictable results. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/**
 * Normalise a player name for matching across sources.
 *
 * Sleeper and KTC disagree on punctuation, accents and suffixes: "Ja'Marr
 * Chase" vs "JaMarr Chase", "Marvin Harrison Jr." vs "Marvin Harrison". Reduce
 * both to letters only, with generational suffixes dropped.
 */
export function normaliseName(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z]/g, "");
}

/**
 * Fetch and parse KTC's player list.
 *
 * Returns [] on any failure — a missing values column is a degraded page, not a
 * reason to fail the whole bake (and the scheduled refresh must not go red
 * because a third-party site changed its markup).
 */
export async function fetchKtcPlayers({ onProgress } = {}) {
  try {
    onProgress?.("fetching KeepTradeCut values");
    const res = await fetch(RANKINGS_URL, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`KTC responded ${res.status}`);

    const html = await res.text();
    const match = html.match(
      /<script[^>]*id=["']ktc-players["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (!match) throw new Error("KTC payload tag not found (their page changed)");

    const players = JSON.parse(match[1]);
    if (!Array.isArray(players) || !players.length) throw new Error("KTC payload was empty");
    return players;
  } catch (err) {
    onProgress?.(`KTC unavailable: ${err.message}`);
    return [];
  }
}

/**
 * Does this league start more than one quarterback?
 *
 * Superflex leagues value quarterbacks far more highly, and KTC publishes a
 * separate column for them. Picking the wrong one is not a rounding error —
 * it misprices every QB on every roster.
 */
export function isSuperflex(rosterPositions = []) {
  return rosterPositions.some((slot) => slot === "SUPER_FLEX" || slot === "QB_FLEX");
}

/**
 * Index KTC players for lookup, by name+position and by name alone.
 *
 * The name-only index is the fallback for players the two sources classify
 * differently — Travis Hunter is a DB to Sleeper and a WR to KTC.
 */
function indexKtc(players, format) {
  const byNameAndPos = new Map();
  const byName = new Map();

  for (const p of players) {
    const values = format === "superflex" ? p.superflexValues : p.oneQBValues;
    if (!values) continue;

    const entry = {
      name: p.playerName,
      position: p.position,
      team: p.team ?? null,
      age: p.age ?? null,
      value: values.value ?? null,
      rank: values.rank ?? null,
      positionalRank: values.positionalRank ?? null,
      // Seven-day movement, so the UI can show which way a player is heading.
      trend: values.overall7DayTrend ?? 0,
    };

    const key = normaliseName(p.playerName);
    byNameAndPos.set(`${key}|${p.position}`, entry);
    if (!byName.has(key)) byName.set(key, entry);
  }

  return { byNameAndPos, byName };
}

/**
 * Match this league's players to KTC values.
 *
 * `sleeperPlayers` is the trimmed dictionary: { id: { n, p, t } }. Only ids in
 * `wanted` are looked up. Returns the map plus counts, so the bake can report
 * how much of the league it actually priced.
 */
export function matchKtcValues(ktcPlayers, sleeperPlayers, wanted, { superflex = true } = {}) {
  const format = superflex ? "superflex" : "1qb";
  const { byNameAndPos, byName } = indexKtc(ktcPlayers, format);

  const values = {};
  const unmatched = [];

  for (const id of wanted) {
    const p = sleeperPlayers[id];
    if (!p) continue;

    const key = normaliseName(p.n);
    const entry = byNameAndPos.get(`${key}|${p.p}`) ?? byName.get(key);

    if (!entry) {
      unmatched.push(`${p.n} (${p.p ?? "?"})`);
      continue;
    }

    values[id] = {
      v: entry.value,
      r: entry.rank,
      pr: entry.positionalRank,
      t: entry.trend,
    };
  }

  return { format, values, matched: Object.keys(values).length, unmatched };
}
