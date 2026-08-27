/**
 * Analytics tests.
 *
 * The highest-risk behaviours here are (a) not mistaking Sleeper's published
 * future schedule for real 0-0 results, and (b) keeping the projection
 * reproducible so the scheduled refresh does not commit simulation noise.
 *
 * Run: node --test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWeeklyScores,
  buildAllPlay,
  buildHeadToHead,
  buildRecordsBook,
  buildPowerRatings,
  projectSeason,
} from "../src/analytics.js";

const A = "own_a";
const B = "own_b";
const C = "own_c";
const D = "own_d";

const OWNER_BY_ROSTER = { 1: A, 2: B, 3: C, 4: D };
const resolveOwner = (_season, rosterId) => OWNER_BY_ROSTER[rosterId] ?? null;

const entry = (rosterId, matchupId, points) => ({ roster_id: rosterId, matchup_id: matchupId, points });

/** Two played weeks, one scheduled-but-unplayed week, and one playoff week. */
function season() {
  return {
    season: "2026",
    league: { league_id: "L", season: "2026", settings: { playoff_week_start: 4, playoff_teams: 2 } },
    matchups: [
      {
        week: 1,
        entries: [entry(1, 1, 120), entry(2, 1, 100), entry(3, 2, 90), entry(4, 2, 95)],
      },
      {
        week: 2,
        entries: [entry(1, 1, 80), entry(3, 1, 110), entry(2, 2, 130), entry(4, 2, 70)],
      },
      {
        // Scheduled, not played: Sleeper publishes pairings with points 0.
        week: 3,
        entries: [entry(1, 1, 0), entry(4, 1, 0), entry(2, 2, 0), entry(3, 2, 0)],
      },
      {
        // Playoff week: must be excluded from regular-season analytics entirely.
        week: 4,
        entries: [entry(1, null, 150), entry(2, null, 140)],
      },
    ],
  };
}

test("weekly scores exclude playoff weeks and flag unplayed games", () => {
  const rows = buildWeeklyScores(season(), resolveOwner);

  // 3 regular-season weeks x 4 teams = 12 rows; week 4 is playoffs, so excluded.
  assert.equal(rows.length, 12);
  assert.equal(rows.some((r) => r.week === 4), false);

  const week3 = rows.filter((r) => r.week === 3);
  assert.equal(week3.length, 4);
  assert.equal(week3.every((r) => r.played === false), true);

  const week1 = rows.filter((r) => r.week === 1);
  assert.equal(week1.every((r) => r.played === true), true);

  // Each row carries its opponent, from both directions.
  const a1 = rows.find((r) => r.week === 1 && r.ownerId === A);
  assert.equal(a1.points, 120);
  assert.equal(a1.opponentOwnerId, B);
  assert.equal(a1.opponentPoints, 100);
});

test("all-play separates real record from schedule luck", () => {
  const rows = buildWeeklyScores(season(), resolveOwner);
  const allPlay = buildAllPlay(rows);

  const b = allPlay.find((r) => r.ownerId === B);
  // B lost week 1 (100 v 120) and won week 2 (130 v 70).
  assert.equal(b.actualWins, 1);
  assert.equal(b.actualLosses, 1);
  // All-play: week 1 B(100) beats 90 and 95 -> 2 of 3. Week 2 B(130) beats all -> 3 of 3.
  assert.equal(b.allPlayWins, 5);
  assert.equal(b.allPlayGames, 6);
  // Scored better than its record: unlucky, so luck is negative.
  assert.ok(b.luck < 0, `expected negative luck, got ${b.luck}`);

  // Unplayed week 3 contributes nothing.
  assert.equal(allPlay.every((r) => r.actualWins + r.actualLosses === 2), true);
});

test("head-to-head and records ignore unplayed games", () => {
  const rows = buildWeeklyScores(season(), resolveOwner);

  const h2h = buildHeadToHead(rows);
  const aVsB = h2h.find((r) => r.ownerId === A && r.opponentOwnerId === B);
  assert.equal(aVsB.wins, 1);
  assert.equal(aVsB.losses, 0);
  // A never played D (week 3 was scheduled but not played).
  assert.equal(h2h.some((r) => r.ownerId === A && r.opponentOwnerId === D), false);

  const book = buildRecordsBook(rows);
  assert.equal(book.highestScore.points, 130);
  assert.equal(book.highestScore.ownerId, B);
  // The floor is 70, not the 0s from the unplayed week.
  assert.equal(book.lowestScore.points, 70);
});

test("power ratings weight recent seasons more heavily", () => {
  const rows = [
    { season: "2025", week: 1, played: true, ownerId: A, points: 100, opponentPoints: 0 },
    { season: "2026", week: 1, played: true, ownerId: A, points: 200, opponentPoints: 0 },
  ];
  const ratings = buildPowerRatings(rows, ["2025", "2026"]);
  // Weights 1 and 2 -> (100 + 400) / 3 = 166.67, not the unweighted 150.
  assert.ok(Math.abs(ratings.get(A).mean - 166.67) < 0.1, ratings.get(A).mean);
});

test("projection is deterministic and respects games already won", () => {
  const s = season();
  const rows = buildWeeklyScores(s, resolveOwner);
  const ratings = buildPowerRatings(rows, ["2026"]);

  const first = projectSeason(s, rows, ratings, { sims: 400 });
  const second = projectSeason(s, rows, ratings, { sims: 400 });

  // Same seed, same inputs -> byte-identical output. This is what keeps the
  // scheduled bake from committing simulation noise every week.
  assert.deepEqual(first, second);

  assert.equal(first.gamesRemaining, 2); // week 3, deduplicated to 2 pairings
  assert.equal(first.gamesPlayed, 4); // weeks 1 and 2, two games each
  assert.equal(first.playoffTeams, 2);

  for (const r of first.results) {
    assert.ok(r.playoffOdds >= 0 && r.playoffOdds <= 1);
    // Everyone has 2 games played and 1 remaining, so wins land in [current, current+1].
    assert.ok(r.projectedWins >= r.currentWins);
    assert.ok(r.projectedWins <= r.currentWins + 1);
  }

  // Odds across the league sum to the number of playoff spots.
  const total = first.results.reduce((sum, r) => sum + r.playoffOdds, 0);
  assert.ok(Math.abs(total - first.playoffTeams) < 1e-9, `odds summed to ${total}`);
});

test("a season with no matchups projects to null rather than throwing", () => {
  const empty = { season: "2027", league: { settings: {} }, matchups: [] };
  assert.equal(projectSeason(empty, [], new Map()), null);
});
