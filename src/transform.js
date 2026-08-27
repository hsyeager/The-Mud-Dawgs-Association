/**
 * Turn raw Sleeper payloads into the model the site renders.
 *
 * The one idea worth understanding here: **roster_id is per-season, owner_id is
 * forever.** Sleeper's transactions, draft picks and matchups all reference
 * `roster_id`, which is only meaningful inside a single season's league object.
 * A dynasty league is a chain of those objects, so to say "this manager has made
 * 34 trades since 2019" we resolve every roster_id through that season's roster
 * list to an `owner_id` (a Sleeper user id), and key everything off that.
 *
 * Runs in Node and the browser; no dependencies, no side effects.
 */

/** A trade is only real once both sides have accepted. */
const COMPLETE = "complete";

// ---------------------------------------------------------------------------
// Franchises
// ---------------------------------------------------------------------------

/**
 * Build the league's franchise registry, keyed by Sleeper user id.
 *
 * Managers rename their teams constantly, so we keep the most recent name for
 * display and retain every name we have seen for the franchise's history.
 */
export function buildFranchises(seasons) {
  const franchises = new Map();

  for (const s of seasons) {
    const usersById = new Map((s.users ?? []).map((u) => [u.user_id, u]));

    for (const roster of s.rosters ?? []) {
      const ownerId = roster.owner_id;
      if (!ownerId) continue; // orphaned roster (manager removed, never replaced)

      const user = usersById.get(ownerId);
      const teamName = user?.metadata?.team_name?.trim() || user?.display_name || "Unknown";
      const displayName = user?.display_name || teamName;

      let f = franchises.get(ownerId);
      if (!f) {
        f = {
          ownerId,
          displayName,
          teamName,
          avatar: user?.metadata?.avatar || null,
          sleeperAvatar: user?.avatar || null,
          teamNames: [],
          seasons: [],
        };
        franchises.set(ownerId, f);
      }

      // Later seasons overwrite: the newest name wins for display.
      f.displayName = displayName;
      f.teamName = teamName;
      if (user?.avatar) f.sleeperAvatar = user.avatar;
      if (!f.teamNames.some((t) => t.name === teamName)) {
        f.teamNames.push({ name: teamName, season: s.season });
      }
      f.seasons.push({ season: s.season, rosterId: roster.roster_id });
    }
  }

  return franchises;
}

/**
 * Index (season, roster_id) -> owner_id so transactions can name a franchise.
 *
 * Returns a lookup function; unknown pairs resolve to null rather than throwing,
 * because leagues do contain rosters that were abandoned mid-season.
 */
export function buildRosterIndex(seasons) {
  const index = new Map();
  for (const s of seasons) {
    for (const roster of s.rosters ?? []) {
      index.set(`${s.season}:${roster.roster_id}`, roster.owner_id ?? null);
    }
  }
  return (season, rosterId) => index.get(`${season}:${rosterId}`) ?? null;
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/**
 * Flatten every completed trade in league history into a renderable shape.
 *
 * Sleeper describes a trade as flat maps rather than per-side packages:
 *   adds:  { player_id: roster_id_that_received }
 *   drops: { player_id: roster_id_that_gave_up }
 *   draft_picks: [{ season, round, roster_id, previous_owner_id, owner_id }]
 *   waiver_budget: [{ sender, receiver, amount }]
 * We regroup all of that by side, so each trade becomes "what each team got".
 *
 * Newest first.
 */
export function buildTrades(seasons, resolveOwner) {
  const trades = [];

  for (const s of seasons) {
    for (const tx of s.transactions ?? []) {
      if (tx.type !== "trade" || tx.status !== COMPLETE) continue;

      const sides = new Map();

      // A side can appear in adds/drops without being listed in roster_ids on
      // some older trades, so create sides lazily as we encounter them.
      const sideFor = (rid) => {
        if (!sides.has(rid)) {
          sides.set(rid, {
            rosterId: rid,
            ownerId: resolveOwner(s.season, rid),
            playersIn: [],
            playersOut: [],
            picksIn: [],
            picksOut: [],
            faabIn: 0,
            faabOut: 0,
          });
        }
        return sides.get(rid);
      };

      for (const rid of tx.roster_ids ?? []) sideFor(rid);

      for (const [playerId, rid] of Object.entries(tx.adds ?? {})) {
        sideFor(rid).playersIn.push(playerId);
      }
      for (const [playerId, rid] of Object.entries(tx.drops ?? {})) {
        sideFor(rid).playersOut.push(playerId);
      }

      for (const pick of tx.draft_picks ?? []) {
        const label = {
          season: pick.season,
          round: pick.round,
          // The pick's *original* team, which is what makes "2027 1st (via Ross)" readable.
          originalOwnerId: resolveOwner(s.season, pick.roster_id),
          originalRosterId: pick.roster_id,
        };
        if (pick.owner_id != null) sideFor(pick.owner_id).picksIn.push(label);
        if (pick.previous_owner_id != null) sideFor(pick.previous_owner_id).picksOut.push(label);
      }

      for (const faab of tx.waiver_budget ?? []) {
        sideFor(faab.receiver).faabIn += faab.amount;
        sideFor(faab.sender).faabOut += faab.amount;
      }

      trades.push({
        id: tx.transaction_id,
        season: s.season,
        week: tx.leg ?? null,
        created: tx.created ?? null,
        sides: [...sides.values()],
      });
    }
  }

  trades.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return trades;
}

// ---------------------------------------------------------------------------
// Standings, champions, drafts
// ---------------------------------------------------------------------------

/** Sleeper splits points into integer and decimal fields; rejoin them. */
const points = (whole, decimal) => Number(whole ?? 0) + Number(decimal ?? 0) / 100;

/** Regular-season standings for one season, best record first. */
export function buildStandings(season) {
  const usersById = new Map((season.users ?? []).map((u) => [u.user_id, u]));

  const rows = (season.rosters ?? []).map((roster) => {
    const st = roster.settings ?? {};
    const user = usersById.get(roster.owner_id);
    return {
      rosterId: roster.roster_id,
      ownerId: roster.owner_id ?? null,
      teamName: user?.metadata?.team_name?.trim() || user?.display_name || "Unknown",
      wins: st.wins ?? 0,
      losses: st.losses ?? 0,
      ties: st.ties ?? 0,
      pointsFor: points(st.fpts, st.fpts_decimal),
      pointsAgainst: points(st.fpts_against, st.fpts_against_decimal),
      moves: st.total_moves ?? 0,
      waiverBudgetUsed: st.waiver_budget_used ?? 0,
    };
  });

  rows.sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
  return rows;
}

/**
 * Read final placements out of a season's playoff bracket.
 *
 * Sleeper marks placement games with `p`: p=1 is the championship, p=3 the
 * third-place game, and so on. `w` and `l` hold the winning and losing roster
 * ids. A bracket is absent or unresolved for a season still in progress.
 */
export function buildPlacements(season) {
  const placements = [];
  for (const match of season.winnersBracket ?? []) {
    if (!match.p || match.w == null) continue;
    placements.push({ place: match.p, rosterId: match.w });
    if (match.l != null) placements.push({ place: match.p + 1, rosterId: match.l });
  }
  placements.sort((a, b) => a.place - b.place);
  return placements;
}

/** The champion's roster id for a season, or null if the season has not finished. */
export function findChampion(season) {
  const final = (season.winnersBracket ?? []).find((m) => m.p === 1 && m.w != null);
  return final?.w ?? null;
}

/** Draft history, newest season first, picks in board order. */
export function buildDrafts(seasons, resolveOwner) {
  const out = [];
  for (const s of seasons) {
    for (const draft of s.drafts ?? []) {
      const picks = [...(draft.picks ?? [])].sort(
        (a, b) => a.round - b.round || a.pick_no - b.pick_no
      );
      out.push({
        draftId: draft.draft_id,
        season: s.season,
        type: draft.type,
        status: draft.status,
        rounds: draft.settings?.rounds ?? null,
        picks: picks.map((p) => ({
          round: p.round,
          pickNo: p.pick_no,
          playerId: p.player_id,
          rosterId: p.roster_id,
          ownerId: resolveOwner(s.season, p.roster_id),
          isKeeper: Boolean(p.is_keeper),
        })),
      });
    }
  }
  out.sort((a, b) => Number(b.season) - Number(a.season));
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Compose the full model the site consumes.
 *
 * Also rolls up per-franchise career totals (record, points, titles, trade
 * count) so the browser renders straight from data instead of recomputing.
 */
export function buildLeagueModel(history) {
  const seasons = history.seasons ?? [];
  const resolveOwner = buildRosterIndex(seasons);
  const franchises = buildFranchises(seasons);
  const trades = buildTrades(seasons, resolveOwner);
  const drafts = buildDrafts(seasons, resolveOwner);

  const seasonSummaries = seasons.map((s) => {
    const championRosterId = findChampion(s);
    return {
      season: s.season,
      leagueId: s.league.league_id,
      name: s.league.name,
      status: s.league.status,
      totalRosters: s.league.total_rosters,
      rosterPositions: s.league.roster_positions ?? [],
      standings: buildStandings(s),
      placements: buildPlacements(s),
      championOwnerId: championRosterId != null ? resolveOwner(s.season, championRosterId) : null,
      tradeCount: trades.filter((t) => t.season === s.season).length,
    };
  });

  // Career rollups per franchise.
  const careers = new Map(
    [...franchises.keys()].map((id) => [
      id,
      {
        wins: 0,
        losses: 0,
        ties: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        titles: 0,
        trades: 0,
        seasons: 0,
      },
    ])
  );

  for (const s of seasonSummaries) {
    for (const row of s.standings) {
      const c = careers.get(row.ownerId);
      if (!c) continue;
      c.wins += row.wins;
      c.losses += row.losses;
      c.ties += row.ties;
      c.pointsFor += row.pointsFor;
      c.pointsAgainst += row.pointsAgainst;
      c.seasons += 1;
    }
    if (s.championOwnerId && careers.has(s.championOwnerId)) {
      careers.get(s.championOwnerId).titles += 1;
    }
  }

  for (const trade of trades) {
    for (const side of trade.sides) {
      if (side.ownerId && careers.has(side.ownerId)) careers.get(side.ownerId).trades += 1;
    }
  }

  const franchiseList = [...franchises.values()].map((f) => ({
    ...f,
    career: careers.get(f.ownerId),
  }));
  franchiseList.sort(
    (a, b) => b.career.wins - a.career.wins || b.career.pointsFor - a.career.pointsFor
  );

  const current = seasonSummaries[seasonSummaries.length - 1];

  return {
    generatedAt: new Date().toISOString(),
    leagueName: current?.name ?? "League",
    currentLeagueId: current?.leagueId ?? history.leagueId,
    firstSeason: seasonSummaries[0]?.season ?? null,
    latestSeason: current?.season ?? null,
    seasons: seasonSummaries,
    franchises: franchiseList,
    trades,
    drafts,
  };
}

/**
 * Every player id the league has ever touched.
 *
 * The bake script uses this to trim Sleeper's ~5 MB player dictionary down to
 * only the players that appear somewhere in this league's history.
 */
export function collectPlayerIds(model, history) {
  const ids = new Set();
  for (const trade of model.trades) {
    for (const side of trade.sides) {
      side.playersIn.forEach((p) => ids.add(p));
      side.playersOut.forEach((p) => ids.add(p));
    }
  }
  for (const draft of model.drafts) {
    for (const pick of draft.picks) if (pick.playerId) ids.add(pick.playerId);
  }
  for (const s of history.seasons ?? []) {
    for (const roster of s.rosters ?? []) {
      (roster.players ?? []).forEach((p) => ids.add(p));
      (roster.taxi ?? []).forEach((p) => ids.add(p));
      (roster.reserve ?? []).forEach((p) => ids.add(p));
    }
  }
  ids.delete(null);
  ids.delete(undefined);
  return ids;
}
