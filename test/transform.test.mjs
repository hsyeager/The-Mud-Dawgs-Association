/**
 * Transform tests against synthetic Sleeper payloads.
 *
 * These fixtures mirror the exact shapes Sleeper returns -- flat `adds`/`drops`
 * maps, `draft_picks` carrying previous_owner_id/owner_id, per-season roster_ids
 * that change meaning between seasons -- so the regrouping logic is pinned down
 * without needing the live API.
 *
 * Run: node --test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFranchises,
  buildRosterIndex,
  buildTrades,
  buildStandings,
  buildPlacements,
  findChampion,
  buildLeagueModel,
  collectPlayerIds,
} from "../src/transform.js";

const ALICE = "user_alice";
const BOB = "user_bob";
const CARL = "user_carl";

const user = (id, name, teamName) => ({
  user_id: id,
  display_name: name,
  avatar: null,
  metadata: { team_name: teamName },
});

const roster = (rosterId, ownerId, settings = {}, players = []) => ({
  roster_id: rosterId,
  owner_id: ownerId,
  players,
  starters: [],
  reserve: [],
  taxi: [],
  settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0, ...settings },
});

/**
 * Two seasons where roster_ids deliberately point at DIFFERENT managers, which
 * is the trap the owner_id indirection exists to avoid.
 */
function history() {
  return {
    leagueId: "L2025",
    seasons: [
      {
        league: { league_id: "L2024", season: "2024", name: "Mud Dawgs", total_rosters: 3, status: "complete" },
        season: "2024",
        users: [user(ALICE, "alice", "Swamp Kings"), user(BOB, "bob", "Bayou Boys"), user(CARL, "carl", "Creek Crew")],
        rosters: [
          roster(1, ALICE, { wins: 10, losses: 4, fpts: 1500, fpts_decimal: 50 }, ["4034"]),
          roster(2, BOB, { wins: 8, losses: 6, fpts: 1400, fpts_decimal: 25 }, ["6794"]),
          roster(3, CARL, { wins: 3, losses: 11, fpts: 1200, fpts_decimal: 0 }, []),
        ],
        transactions: [
          {
            transaction_id: "t1",
            type: "trade",
            status: "complete",
            leg: 4,
            created: 1_700_000_000_000,
            roster_ids: [1, 2],
            // Alice (1) sends 4034, receives 6794 and a pick; Bob (2) the reverse.
            adds: { 6794: 1, 4034: 2 },
            drops: { 6794: 2, 4034: 1 },
            draft_picks: [
              { season: "2026", round: 1, roster_id: 3, previous_owner_id: 2, owner_id: 1 },
            ],
            waiver_budget: [{ sender: 1, receiver: 2, amount: 15 }],
          },
          // Noise that must be excluded from trade history.
          { transaction_id: "t2", type: "free_agent", status: "complete", leg: 5, created: 1, roster_ids: [1], adds: { 999: 1 }, drops: null },
          { transaction_id: "t3", type: "trade", status: "failed", leg: 6, created: 2, roster_ids: [1, 2], adds: { 111: 1 }, drops: { 111: 2 } },
        ],
        drafts: [
          {
            draft_id: "d2024",
            type: "linear",
            status: "complete",
            settings: { rounds: 1 },
            picks: [
              { round: 1, pick_no: 2, player_id: "6794", roster_id: 2, is_keeper: null },
              { round: 1, pick_no: 1, player_id: "4034", roster_id: 1, is_keeper: null },
            ],
          },
        ],
        tradedPicks: [],
        winnersBracket: [
          { r: 2, m: 3, t1: 1, t2: 2, w: 2, l: 1, p: 1 },
          { r: 2, m: 4, t1: 3, t2: null, w: 3, l: null, p: 3 },
        ],
        losersBracket: [],
      },
      {
        // Roster ids rotate: in 2025 roster 1 is BOB, not Alice.
        league: { league_id: "L2025", season: "2025", name: "Mud Dawgs", total_rosters: 3, status: "in_season", previous_league_id: "L2024" },
        season: "2025",
        users: [user(ALICE, "alice", "Swamp Kings"), user(BOB, "bob", "Bayou Bombers"), user(CARL, "carl", "Creek Crew")],
        rosters: [
          roster(1, BOB, { wins: 9, losses: 5, fpts: 1450, fpts_decimal: 75 }, ["4034"]),
          roster(2, ALICE, { wins: 7, losses: 7, fpts: 1390, fpts_decimal: 10 }, ["6794"]),
          roster(3, CARL, { wins: 5, losses: 9, fpts: 1300, fpts_decimal: 40 }, []),
        ],
        transactions: [],
        drafts: [],
        tradedPicks: [],
        winnersBracket: [],
        losersBracket: [],
      },
    ],
  };
}

test("franchises follow the manager, not the roster slot", () => {
  const h = history();
  const franchises = buildFranchises(h.seasons);

  assert.equal(franchises.size, 3);
  const bob = franchises.get(BOB);
  // Newest team name wins for display, but history is retained.
  assert.equal(bob.teamName, "Bayou Bombers");
  assert.deepEqual(
    bob.teamNames.map((t) => t.name),
    ["Bayou Boys", "Bayou Bombers"]
  );
  assert.deepEqual(bob.seasons, [
    { season: "2024", rosterId: 2 },
    { season: "2025", rosterId: 1 },
  ]);
});

test("roster index disambiguates the same roster_id across seasons", () => {
  const resolve = buildRosterIndex(history().seasons);
  assert.equal(resolve("2024", 1), ALICE);
  assert.equal(resolve("2025", 1), BOB);
  assert.equal(resolve("2024", 99), null);
});

test("trades regroup flat adds/drops into per-side packages", () => {
  const h = history();
  const trades = buildTrades(h.seasons, buildRosterIndex(h.seasons));

  // Only the one completed trade: the free agent move and the failed trade drop out.
  assert.equal(trades.length, 1);
  const trade = trades[0];
  assert.equal(trade.season, "2024");
  assert.equal(trade.week, 4);

  const alice = trade.sides.find((s) => s.ownerId === ALICE);
  const bob = trade.sides.find((s) => s.ownerId === BOB);

  assert.deepEqual(alice.playersIn, ["6794"]);
  assert.deepEqual(alice.playersOut, ["4034"]);
  assert.deepEqual(bob.playersIn, ["4034"]);
  assert.deepEqual(bob.playersOut, ["6794"]);

  // The pick moves Bob -> Alice and originally belonged to Carl.
  assert.equal(alice.picksIn.length, 1);
  assert.equal(alice.picksIn[0].season, "2026");
  assert.equal(alice.picksIn[0].round, 1);
  assert.equal(alice.picksIn[0].originalOwnerId, CARL);
  assert.deepEqual(bob.picksIn, []);
  assert.equal(bob.picksOut.length, 1);

  // FAAB flows Alice -> Bob.
  assert.equal(alice.faabOut, 15);
  assert.equal(bob.faabIn, 15);
  assert.equal(alice.faabIn, 0);
});

test("standings sort by wins then points, and rejoin split decimals", () => {
  const rows = buildStandings(history().seasons[0]);
  assert.deepEqual(rows.map((r) => r.teamName), ["Swamp Kings", "Bayou Boys", "Creek Crew"]);
  assert.equal(rows[0].pointsFor, 1500.5);
  assert.equal(rows[1].pointsFor, 1400.25);
});

test("bracket yields champion and placements", () => {
  const s = history().seasons[0];
  assert.equal(findChampion(s), 2); // roster 2 in 2024 == Bob
  assert.deepEqual(buildPlacements(s), [
    { place: 1, rosterId: 2 },
    { place: 2, rosterId: 1 },
    { place: 3, rosterId: 3 },
  ]);
  // A season with no bracket yet is simply empty, not an error.
  assert.equal(findChampion(history().seasons[1]), null);
});

test("model rolls careers across seasons and counts titles per manager", () => {
  const model = buildLeagueModel(history());

  assert.equal(model.firstSeason, "2024");
  assert.equal(model.latestSeason, "2025");
  assert.equal(model.seasons[0].championOwnerId, BOB);
  assert.equal(model.seasons[0].tradeCount, 1);
  assert.equal(model.seasons[1].tradeCount, 0);

  const bob = model.franchises.find((f) => f.ownerId === BOB);
  assert.equal(bob.career.wins, 17); // 8 + 9
  assert.equal(bob.career.titles, 1);
  assert.equal(bob.career.trades, 1);
  assert.equal(bob.career.seasons, 2);

  const carl = model.franchises.find((f) => f.ownerId === CARL);
  assert.equal(carl.career.titles, 0);
  assert.equal(carl.career.trades, 0);

  // Sorted by career wins: Bob 17, Alice 17 -> tie broken by points, Carl 8.
  assert.equal(model.franchises.at(-1).ownerId, CARL);
});

test("player id collection spans trades, drafts and rosters", () => {
  const h = history();
  const model = buildLeagueModel(h);
  const ids = collectPlayerIds(model, h);

  assert.ok(ids.has("4034"));
  assert.ok(ids.has("6794"));
  // The free-agent add is not a trade, so it only appears if rostered.
  assert.equal(ids.has("999"), false);
});
