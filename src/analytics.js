/**
 * League analytics: weekly scoring, luck, head-to-head, records, projections.
 *
 * Everything here is derived from the weekly matchup feed rather than the
 * season-end roster totals, because the interesting questions ("was that team
 * good or lucky?") need per-week scores, not aggregates.
 *
 * Runs in Node and the browser. No dependencies.
 */

/** Regular-season weeks are everything before the playoff bracket starts. */
const playoffWeekStart = (season) => season.league?.settings?.playoff_week_start ?? 15;
const playoffTeamCount = (season) => season.league?.settings?.playoff_teams ?? 6;

/**
 * Deterministic PRNG (mulberry32).
 *
 * The simulation must be reproducible: an unseeded Math.random would give every
 * bake slightly different projections, so the scheduled refresh would commit
 * meaningless churn every single week. Same inputs -> same numbers.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller: one standard normal sample from a uniform generator. */
function gauss(random) {
  let u = 0;
  while (u === 0) u = random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Weekly scores
// ---------------------------------------------------------------------------

/**
 * Flatten the matchup feed into one row per team per regular-season week.
 *
 * `played` distinguishes real results from a schedule that exists but has not
 * happened yet -- Sleeper publishes future pairings with points of 0, and those
 * must never be mistaken for a 0-point performance.
 */
export function buildWeeklyScores(season, resolveOwner) {
  const cutoff = playoffWeekStart(season);
  const rows = [];

  for (const { week, entries } of season.matchups ?? []) {
    if (week >= cutoff) continue;

    const byMatchup = new Map();
    for (const e of entries) {
      if (e.matchup_id == null) continue;
      if (!byMatchup.has(e.matchup_id)) byMatchup.set(e.matchup_id, []);
      byMatchup.get(e.matchup_id).push(e);
    }

    for (const pair of byMatchup.values()) {
      if (pair.length !== 2) continue; // bye or malformed week
      const [a, b] = pair;
      const played = (a.points ?? 0) > 0 || (b.points ?? 0) > 0;
      for (const [self, opp] of [
        [a, b],
        [b, a],
      ]) {
        rows.push({
          season: season.season,
          week,
          played,
          rosterId: self.roster_id,
          ownerId: resolveOwner(season.season, self.roster_id),
          points: self.points ?? 0,
          opponentRosterId: opp.roster_id,
          opponentOwnerId: resolveOwner(season.season, opp.roster_id),
          opponentPoints: opp.points ?? 0,
        });
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Luck: actual record vs all-play record
// ---------------------------------------------------------------------------

/**
 * All-play record: how each team would have done against the whole league every
 * week, instead of against the one opponent the schedule happened to give them.
 *
 * The gap between all-play win% and actual win% is the cleanest measure of
 * schedule luck a fantasy league has.
 */
export function buildAllPlay(weeklyRows) {
  const byOwner = new Map();
  const touch = (ownerId) => {
    if (!byOwner.has(ownerId)) {
      byOwner.set(ownerId, { ownerId, actualWins: 0, actualLosses: 0, allPlayWins: 0, allPlayGames: 0 });
    }
    return byOwner.get(ownerId);
  };

  // Group by season+week so an "all-play" week compares only concurrent games.
  const weeks = new Map();
  for (const r of weeklyRows) {
    if (!r.played || !r.ownerId) continue;
    const key = `${r.season}:${r.week}`;
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(r);
  }

  for (const rows of weeks.values()) {
    for (const r of rows) {
      const rec = touch(r.ownerId);
      if (r.points > r.opponentPoints) rec.actualWins += 1;
      else if (r.points < r.opponentPoints) rec.actualLosses += 1;

      for (const other of rows) {
        if (other.rosterId === r.rosterId) continue;
        rec.allPlayGames += 1;
        if (r.points > other.points) rec.allPlayWins += 1;
      }
    }
  }

  return [...byOwner.values()].map((r) => {
    const actualGames = r.actualWins + r.actualLosses;
    const actualPct = actualGames ? r.actualWins / actualGames : 0;
    const allPlayPct = r.allPlayGames ? r.allPlayWins / r.allPlayGames : 0;
    return {
      ...r,
      actualPct,
      allPlayPct,
      // Positive means the schedule was kind: more wins than the scores deserved.
      luck: actualPct - allPlayPct,
      luckWins: (actualPct - allPlayPct) * actualGames,
    };
  });
}

// ---------------------------------------------------------------------------
// Head to head
// ---------------------------------------------------------------------------

/** All-time head-to-head records, keyed `ownerA|ownerB`. */
export function buildHeadToHead(weeklyRows) {
  const h2h = new Map();
  for (const r of weeklyRows) {
    if (!r.played || !r.ownerId || !r.opponentOwnerId) continue;
    const key = `${r.ownerId}|${r.opponentOwnerId}`;
    if (!h2h.has(key)) h2h.set(key, { ownerId: r.ownerId, opponentOwnerId: r.opponentOwnerId, wins: 0, losses: 0, ties: 0, pointsFor: 0 });
    const rec = h2h.get(key);
    rec.pointsFor += r.points;
    if (r.points > r.opponentPoints) rec.wins += 1;
    else if (r.points < r.opponentPoints) rec.losses += 1;
    else rec.ties += 1;
  }
  return [...h2h.values()];
}

// ---------------------------------------------------------------------------
// Records book
// ---------------------------------------------------------------------------

/** Notable single-game extremes across league history. */
export function buildRecordsBook(weeklyRows) {
  const played = weeklyRows.filter((r) => r.played && r.ownerId);
  if (!played.length) return null;

  const best = (arr, score) => arr.reduce((a, b) => (score(b) > score(a) ? b : a));

  const margin = (r) => r.points - r.opponentPoints;
  const wins = played.filter((r) => r.points > r.opponentPoints);
  const losses = played.filter((r) => r.points < r.opponentPoints);

  return {
    highestScore: best(played, (r) => r.points),
    lowestScore: best(played, (r) => -r.points),
    biggestBlowout: wins.length ? best(wins, margin) : null,
    // Closest finish: smallest positive margin.
    narrowestWin: wins.length ? best(wins, (r) => -margin(r)) : null,
    highestScoringLoss: losses.length ? best(losses, (r) => r.points) : null,
    lowestScoringWin: wins.length ? best(wins, (r) => -r.points) : null,
  };
}

// ---------------------------------------------------------------------------
// Power ratings and projections
// ---------------------------------------------------------------------------

/**
 * Scoring profile per franchise, weighted toward recent seasons.
 *
 * A dynasty roster three years ago tells you much less about today than last
 * season does, so each season's samples carry weight 2^age-from-oldest.
 */
export function buildPowerRatings(weeklyRows, seasonsOrder) {
  const weightFor = new Map(seasonsOrder.map((s, i) => [s, Math.pow(2, i)]));
  const byOwner = new Map();

  for (const r of weeklyRows) {
    if (!r.played || !r.ownerId) continue;
    const w = weightFor.get(r.season) ?? 1;
    if (!byOwner.has(r.ownerId)) byOwner.set(r.ownerId, { ownerId: r.ownerId, sumW: 0, sum: 0, sumSq: 0, n: 0 });
    const acc = byOwner.get(r.ownerId);
    acc.sumW += w;
    acc.sum += w * r.points;
    acc.sumSq += w * r.points * r.points;
    acc.n += 1;
  }

  const ratings = new Map();
  for (const acc of byOwner.values()) {
    const mean = acc.sum / acc.sumW;
    const variance = Math.max(acc.sumSq / acc.sumW - mean * mean, 1);
    ratings.set(acc.ownerId, { ownerId: acc.ownerId, mean, stdev: Math.sqrt(variance), samples: acc.n });
  }
  return ratings;
}

/**
 * Monte Carlo the rest of a season's regular schedule.
 *
 * Games already played are taken as fact; unplayed pairings are simulated by
 * drawing each team's score from its own normal(mean, stdev) profile. Seeding
 * follows Sleeper's default: wins first, then total points.
 *
 * Returns null when there is no schedule to project.
 */
export function projectSeason(season, weeklyRows, ratings, { sims = 10000, seed = 20260827 } = {}) {
  const rows = weeklyRows.filter((r) => r.season === season.season);
  if (!rows.length) return null;

  const owners = [...new Set(rows.map((r) => r.ownerId).filter(Boolean))];
  if (owners.length < 2) return null;

  // Actual results so far.
  const base = new Map(owners.map((o) => [o, { wins: 0, points: 0 }]));
  for (const r of rows) {
    if (!r.played || !r.ownerId) continue;
    const b = base.get(r.ownerId);
    b.points += r.points;
    if (r.points > r.opponentPoints) b.wins += 1;
  }

  // Remaining games, deduplicated to one entry per pairing.
  const remaining = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.played || !r.ownerId || !r.opponentOwnerId) continue;
    const key = [r.season, r.week, ...[r.rosterId, r.opponentRosterId].sort((a, b) => a - b)].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    remaining.push([r.ownerId, r.opponentOwnerId]);
  }

  const playoffTeams = playoffTeamCount(season);
  const random = mulberry32(seed);
  const tally = new Map(owners.map((o) => [o, { wins: 0, playoffs: 0, seedSum: 0, top: 0 }]));

  // A franchise with no scoring history yet (an expansion team) falls back to
  // the league's average profile so it is not simulated as a zero.
  const meanOfMeans = owners.reduce((s, o) => s + (ratings.get(o)?.mean ?? 0), 0) / owners.length || 100;
  const profile = (o) => ratings.get(o) ?? { mean: meanOfMeans, stdev: 20 };

  for (let i = 0; i < sims; i++) {
    const sim = new Map(owners.map((o) => [o, { wins: base.get(o).wins, points: base.get(o).points }]));

    for (const [a, b] of remaining) {
      const pa = profile(a);
      const pb = profile(b);
      const sa = pa.mean + gauss(random) * pa.stdev;
      const sb = pb.mean + gauss(random) * pb.stdev;
      sim.get(a).points += sa;
      sim.get(b).points += sb;
      if (sa >= sb) sim.get(a).wins += 1;
      else sim.get(b).wins += 1;
    }

    const order = owners
      .slice()
      .sort((x, y) => sim.get(y).wins - sim.get(x).wins || sim.get(y).points - sim.get(x).points);

    order.forEach((o, idx) => {
      const t = tally.get(o);
      t.wins += sim.get(o).wins;
      t.seedSum += idx + 1;
      if (idx < playoffTeams) t.playoffs += 1;
      if (idx === 0) t.top += 1;
    });
  }

  const results = owners.map((o) => ({
    ownerId: o,
    currentWins: base.get(o).wins,
    projectedWins: tally.get(o).wins / sims,
    playoffOdds: tally.get(o).playoffs / sims,
    firstSeedOdds: tally.get(o).top / sims,
    averageSeed: tally.get(o).seedSum / sims,
    mean: profile(o).mean,
    stdev: profile(o).stdev,
  }));

  results.sort((a, b) => b.playoffOdds - a.playoffOdds || b.projectedWins - a.projectedWins);

  return {
    season: season.season,
    sims,
    playoffTeams,
    gamesRemaining: remaining.length,
    gamesPlayed: rows.filter((r) => r.played).length / 2,
    results,
  };
}

/**
 * Everything the Overview tab needs, computed once at bake time.
 */
export function buildAnalytics(history, resolveOwner) {
  const seasons = history.seasons ?? [];
  const weekly = seasons.flatMap((s) => buildWeeklyScores(s, resolveOwner));
  const seasonsOrder = seasons.map((s) => s.season);

  const ratings = buildPowerRatings(weekly, seasonsOrder);
  const current = seasons[seasons.length - 1];

  return {
    allPlay: buildAllPlay(weekly),
    headToHead: buildHeadToHead(weekly),
    records: buildRecordsBook(weekly),
    powerRatings: [...ratings.values()].sort((a, b) => b.mean - a.mean),
    projection: current ? projectSeason(current, weekly, ratings) : null,
    weeklyBySeason: seasonsOrder.map((season) => ({
      season,
      scores: weekly
        .filter((r) => r.season === season && r.played)
        .map((r) => ({ week: r.week, ownerId: r.ownerId, points: r.points })),
    })),
  };
}
