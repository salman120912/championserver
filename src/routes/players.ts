import Router from '@koa/router';
import { required } from '../modules/auth';
import models from '../models';
import { Op } from 'sequelize';
import sequelize from '../config/database';

const { User: UserModel, Match: MatchModel, MatchStatistics, League: LeagueModel, Vote } = models;

const router = new Router({ prefix: '/players' });

// Get all players the current user has played with or against
router.get('/played-with', required, async (ctx) => {
  try {
    if (!ctx.state.user) {
      ctx.throw(401, 'User not authenticated');
      return;
    }
    const userId = ctx.state.user.userId;

    // Find all match IDs the user has played in, based on stats
    const userMatchStats = await MatchStatistics.findAll({
      where: { user_id: userId },
      attributes: ['match_id']
    });

    const matchIds = userMatchStats.map(stat => stat.match_id);

    if (matchIds.length === 0) {
      ctx.body = { success: true, players: [] };
      return;
    }

    // Find all player IDs who participated in those matches
    const allPlayerStats = await MatchStatistics.findAll({
      where: {
        match_id: {
          [Op.in]: matchIds
        }
      },
      attributes: ['user_id']
    });

    const playerIds = new Set<string>(allPlayerStats.map(stat => stat.user_id));
    
    // Remove the current user from the set
    playerIds.delete(userId);

    // Fetch details for all unique players
    const players = await UserModel.findAll({
      where: {
        id: {
          [Op.in]: Array.from(playerIds)
        }
      },
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp']
    });

    ctx.body = {
      success: true,
      players: players.map(p => ({
        id: p.id,
        name: `${p.firstName} ${p.lastName}`,
        profilePicture: p.profilePicture,
        rating: p.xp || 0 // Assuming XP is the rating
      }))
    };

  } catch (error) {
    console.error('Error fetching played-with players:', error);
    ctx.throw(500, 'Failed to fetch players.');
  }
});

// GET player career stats
router.get('/:id/stats', required, async (ctx) => {
    try {
        const { id: playerId } = ctx.params;
        const { leagueId, year } = ctx.query as { leagueId?: string, year?: string };

        const player = await UserModel.findByPk(playerId, {
            attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'position']
        });

        if (!player) {
            ctx.throw(404, 'Player not found');
            return;
        }
        
        // Find all matches the user has played in by checking team associations
        const userWithMatches = await UserModel.findByPk(playerId, {
            include: [
                { model: LeagueModel, as: 'leagues', include: [{ model: MatchModel, as: 'matches', where: { status: 'completed' }, required: false, include: [{ model: UserModel, as: 'homeTeamUsers'}, { model: UserModel, as: 'awayTeamUsers' }] }] }
            ]
        });

        const allLeagues = (userWithMatches as any)?.leagues || [];
        if (allLeagues.length === 0) {
            // Return empty stats if player has no leagues
            const emptyStats = { Goals: 0, Assist: 0, 'Clean Sheet': 0, 'MOTM Votes': 0, 'Best Win': 0, 'Total Wins': 0, 'xWin %': 0 };
            ctx.body = {
                success: true,
                data: {
                    player: { name: `${player.firstName} ${player.lastName}`, position: player.position || 'N/A', rating: player.xp || 0, avatar: player.profilePicture },
                    leagues: [], years: [], currentStats: emptyStats, accumulativeStats: emptyStats, trophies: {},
                }
            };
            return;
        }

        const allMatches = allLeagues.flatMap((l: any) => l.matches);
        const allMatchIds = allMatches.map((m: any) => m.id);

        const getYearsFromMatches = (matches: any[]) => {
            return [...new Set(matches.map(m => new Date(m.date).getFullYear()))].sort((a, b) => b - a);
        };

        const buildStats = async (matchesToStat: any[]) => {
            const matchIds = matchesToStat.map(m => m.id);
            if (matchIds.length === 0) return { Goals: 0, Assist: 0, 'Clean Sheet': 0, 'MOTM Votes': 0, 'Best Win': 0, 'Total Wins': 0, 'xWin %': 0 };

            const statsResult = await MatchStatistics.findOne({
                where: { user_id: playerId, match_id: { [Op.in]: matchIds } },
                attributes: [
                    [sequelize.fn('SUM', sequelize.col('goals')), 'goals'],
                    [sequelize.fn('SUM', sequelize.col('assists')), 'assists'],
                    [sequelize.fn('SUM', sequelize.col('clean_sheets')), 'cleanSheets'],
                ]
            });

            const votes = await Vote.count({ where: { votedForId: playerId, matchId: { [Op.in]: matchIds } } });
            const goals = statsResult?.get('goals') || 0;
            const assists = statsResult?.get('assists') || 0;
            const cleanSheets = statsResult?.get('cleanSheets') || 0;

            let totalWins = 0;
            let bestWinMargin = 0;
            let totalMatchesPlayed = 0;

            for (const match of matchesToStat) {
                const isHomePlayer = match.homeTeamUsers?.some((p: any) => p.id === playerId);
                const isAwayPlayer = match.awayTeamUsers?.some((p: any) => p.id === playerId);
                
                if (isHomePlayer || isAwayPlayer) {
                    totalMatchesPlayed++;
                    const homeWon = match.homeTeamGoals > match.awayTeamGoals;
                    const awayWon = match.awayTeamGoals > match.homeTeamGoals;

                    if ((isHomePlayer && homeWon) || (isAwayPlayer && awayWon)) {
                        totalWins++;
                        const margin = Math.abs(match.homeTeamGoals - match.awayTeamGoals);
                        if (margin > bestWinMargin) {
                            bestWinMargin = margin;
                        }
                    }
                }
            }
            
            const xWinPercentage = totalMatchesPlayed > 0 ? Math.round((totalWins / totalMatchesPlayed) * 100) : 0;

            return {
                Goals: Number(goals), Assist: Number(assists), 'Clean Sheet': Number(cleanSheets),
                'MOTM Votes': votes, 'Best Win': bestWinMargin, 'Total Wins': totalWins, 'xWin %': xWinPercentage,
            };
        };

        // --- Calculate Accumulative Stats & Trophies ---
        const accumulativeStats = await buildStats(allMatches);
        
        // --- Calculate Accumulative Trophies ---
        let titles = 0, runnerUps = 0, ballonDors = 0, goats = 0, goldenBoots = 0, kingPlaymakers = 0, legendaryShields = 0, darkHorses = 0;

        for (const league of allLeagues) {
            // if ((league.matches || []).length < league.maxGames) continue; // Skip incomplete leagues

            const leaguePlayerIds = (league.members || []).map((m: any) => m.id);
            if(leaguePlayerIds.length === 0) continue;

            const playerStats: Record<string, { wins: number; losses: number; draws: number; played: number; goals: number; assists: number; motmVotes: number; teamGoalsConceded: number; }> = {};

            leaguePlayerIds.forEach((id: string) => {
                playerStats[id] = { wins: 0, losses: 0, draws: 0, played: 0, goals: 0, assists: 0, motmVotes: 0, teamGoalsConceded: 0 };
            });

            (league.matches || []).forEach((match: any) => {
                const homeWon = match.homeTeamGoals > match.awayTeamGoals;
                const awayWon = match.awayTeamGoals > match.homeTeamGoals;

                match.homeTeamUsers?.forEach((p: any) => {
                    if (!playerStats[p.id]) return;
                    playerStats[p.id].played++;
                    if (homeWon) playerStats[p.id].wins++; else if (awayWon) playerStats[p.id].losses++; else playerStats[p.id].draws++;
                    playerStats[p.id].teamGoalsConceded += match.awayTeamGoals || 0;
                });
                match.awayTeamUsers?.forEach((p: any) => {
                    if (!playerStats[p.id]) return;
                    playerStats[p.id].played++;
                    if (awayWon) playerStats[p.id].wins++; else if (homeWon) playerStats[p.id].losses++; else playerStats[p.id].draws++;
                    playerStats[p.id].teamGoalsConceded += match.homeTeamGoals || 0;
                });
            });

            const leagueMatchIds = (league.matches || []).map((m: any) => m.id);
            if (leagueMatchIds.length > 0) {
                const statsResults = await MatchStatistics.findAll({
                    where: { match_id: { [Op.in]: leagueMatchIds } },
                    attributes: ['user_id', [sequelize.fn('SUM', sequelize.col('goals')), 'total_goals'], [sequelize.fn('SUM', sequelize.col('assists')), 'total_assists']],
                    group: ['user_id']
                });
                statsResults.forEach((stat: any) => {
                    if (playerStats[stat.get('user_id')]) {
                        playerStats[stat.get('user_id')].goals = Number(stat.get('total_goals') || 0);
                        playerStats[stat.get('user_id')].assists = Number(stat.get('total_assists') || 0);
                    }
                });

                const voteResults = await Vote.findAll({
                    where: { matchId: { [Op.in]: leagueMatchIds } },
                    attributes: ['votedForId', [sequelize.fn('COUNT', sequelize.col('votedForId')), 'voteCount']],
                    group: ['votedForId']
                });
                voteResults.forEach((vote: any) => {
                    if (playerStats[vote.get('votedForId')]) {
                        playerStats[vote.get('votedForId')].motmVotes = Number(vote.get('voteCount') || 0);
                    }
                });
            }

            const sortedLeagueTable = [...leaguePlayerIds].sort((a, b) => (playerStats[b].wins * 3 + playerStats[b].draws) - (playerStats[a].wins * 3 + playerStats[a].draws));
            
            if (sortedLeagueTable[0] === playerId) titles++;
            if (sortedLeagueTable[1] === playerId) runnerUps++;
            if ([...leaguePlayerIds].sort((a, b) => playerStats[b].motmVotes - playerStats[a].motmVotes)[0] === playerId) ballonDors++;
            if ([...leaguePlayerIds].sort((a, b) => ((playerStats[b].wins / playerStats[b].played) || 0) - ((playerStats[a].wins / playerStats[a].played) || 0) || playerStats[b].motmVotes - playerStats[a].motmVotes)[0] === playerId) goats++;
            if ([...leaguePlayerIds].sort((a, b) => playerStats[b].goals - playerStats[a].goals)[0] === playerId) goldenBoots++;
            if ([...leaguePlayerIds].sort((a, b) => playerStats[b].assists - playerStats[a].assists)[0] === playerId) kingPlaymakers++;

            const defensivePlayerIds = (league.members || []).filter((p: any) => p.position === 'Defender' || p.position === 'Goalkeeper').map((p: any) => p.id);
            if (defensivePlayerIds.length > 0 && defensivePlayerIds.sort((a: string, b: string) => ((playerStats[a].teamGoalsConceded / playerStats[a].played) || Infinity) - ((playerStats[b].teamGoalsConceded / playerStats[b].played) || Infinity))[0] === playerId) {
                legendaryShields++;
            }

            if (sortedLeagueTable.length > 3 && sortedLeagueTable.slice(3).sort((a, b) => playerStats[b].motmVotes - playerStats[a].motmVotes)[0] === playerId) {
                darkHorses++;
            }
        }

        // --- Calculate Current (Filtered) Stats ---
        let filteredMatches = allMatches;
        if (leagueId && leagueId !== 'all') {
            filteredMatches = filteredMatches.filter((m: { leagueId: any }) => m.leagueId.toString() === leagueId);
        }
        if (year && year !== 'all') {
            filteredMatches = filteredMatches.filter((m: { date: string }) => new Date(m.date).getFullYear() === Number(year));
        }
        const currentStats = await buildStats(filteredMatches);
        
        ctx.body = {
            success: true,
            data: {
                player: { name: `${player.firstName} ${player.lastName}`, position: player.position || 'N/A', rating: player.xp || 0, avatar: player.profilePicture },
                leagues: allLeagues.map((l: any) => ({ id: l.id, name: l.name })),
                years: getYearsFromMatches(allMatches),
                currentStats,
                accumulativeStats,
                trophies: { 'Titles': titles, 'Runner Up': runnerUps, "Ballon d'Or": ballonDors, 'GOAT': goats, 'Golden Boot': goldenBoots, 'King Playmaker': kingPlaymakers, 'Legendary Shield': legendaryShields, 'The Dark Horse': darkHorses }
            }
        };
    } catch (error) {
        console.error('Error fetching player stats:', error);
        ctx.throw(500, 'Failed to fetch player stats.');
    }
});

export default router; 