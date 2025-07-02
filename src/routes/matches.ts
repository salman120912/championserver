import Router from '@koa/router';
import { required } from '../modules/auth';
import models from '../models';
import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import { calculateAndAwardXPAchievements } from '../utils/xpAchievementsEngine';
const { Match, Vote, User } = models;

const router = new Router({ prefix: '/matches' });

router.post('/:id/votes', required, async (ctx) => {
    if (!ctx.state.user?.userId) {
        ctx.throw(401, 'Unauthorized');
        return;
    }
    const matchId = ctx.params.id;
    const voterId = ctx.state.user.userId;
    const { votedForId } = ctx.request.body as { votedForId: string };

    if (voterId === votedForId) {
        ctx.throw(400, "You cannot vote for yourself.");
    }

    // Remove any previous vote by this user for this match
    await Vote.destroy({
        where: {
            matchId,
            voterId,
        },
    });

    // Create the new vote
    await Vote.create({
        matchId,
        voterId,
        votedForId,
    });

    ctx.status = 200;
    ctx.body = { success: true, message: "Vote cast successfully." };
});

router.post('/:matchId/availability', required, async (ctx) => {
    if (!ctx.state.user?.userId) {
        ctx.throw(401, 'Unauthorized');
        return;
    }
    const { action } = ctx.request.query;
    console.log('action',action);
    
    const match = await Match.findByPk(ctx.params.matchId, {
        include: [{ model: User, as: 'availableUsers' }]
    });
    if (!match) {
        ctx.throw(404, 'Match not found');
        return;
    }
    const user = await User.findByPk(ctx.state.user.userId);
    if (!user) {
        ctx.throw(404, 'User not found');
        return;
    }
    if (action === 'available') {
        const isAlreadyAvailable = match.availableUsers?.some(u => u.id === user.id);
        if (!isAlreadyAvailable) {
            await match.addAvailableUser(user);
        }
    } else if (action === 'unavailable') {
        await match.removeAvailableUser(user);
    }
    // Fetch the updated match with availableUsers
    const updatedMatch = await Match.findByPk(ctx.params.matchId, {
        include: [{ model: User, as: 'availableUsers' }]
    });
    ctx.status = 200;
    ctx.body = { success: true, match: updatedMatch };
});

// PATCH endpoint to update match goals
router.patch('/:matchId/goals', required, async (ctx) => {
    const { homeGoals, awayGoals } = ctx.request.body;
    const { matchId } = ctx.params;
    const match = await Match.findByPk(matchId);
    if (!match) {
        ctx.throw(404, 'Match not found');
        return;
    }
    match.homeTeamGoals = homeGoals;
    match.awayTeamGoals = awayGoals;
    await match.save();
    ctx.body = { success: true };
});

// PATCH endpoint to update match note
router.patch('/:matchId/note', required, async (ctx) => {
    const { note } = ctx.request.body;
    const { matchId } = ctx.params;
    const match = await Match.findByPk(matchId);
    if (!match) {
        ctx.throw(404, 'Match not found');
        return;
    }
    match.notes = note;
    await match.save();
    ctx.body = { success: true };
});

router.post('/:matchId/stats', required, async (ctx) => {
    if (!ctx.state.user?.userId) {
        ctx.throw(401, 'Unauthorized');
        return;
    }
    const { matchId } = ctx.params;
    const userId = ctx.state.user.userId;
    const { goals, assists, cleanSheets, penalties, freeKicks } = ctx.request.body as {
        goals: number;
        assists: number;
        cleanSheets: number;
        penalties: number;
        freeKicks: number;
    };

    const match = await Match.findByPk(matchId);
    if (!match) {
        ctx.throw(404, 'Match not found');
        return;
    }

    if (match.status !== 'completed') {
        ctx.throw(400, 'Statistics can only be added for completed matches.');
    }

    // Find existing stats or create a new record
    const [stats, created] = await models.MatchStatistics.findOrCreate({
        where: { user_id: userId, match_id: matchId },
        defaults: {
            user_id: userId,
            match_id: matchId,
            goals,
            assists,
            cleanSheets,
            penalties,
            freeKicks,
            yellowCards: 0,
            redCards: 0,
            minutesPlayed: 0,
            rating: 0,
        }
    });

    if (!created) {
        // If stats existed, update them
        stats.goals = goals;
        stats.assists = assists;
        stats.cleanSheets = cleanSheets;
        stats.penalties = penalties;
        stats.freeKicks = freeKicks;
        await stats.save();
    }

    ctx.status = 200;
    ctx.body = { success: true, message: 'Statistics saved successfully.' };
});

// GET route to fetch votes for each player in a match
router.get('/:id/votes', required, async (ctx) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }
  const matchId = ctx.params.id;
  const userId = ctx.state.user.userId;
  const votes = await Vote.findAll({
    where: { matchId },
    attributes: ['votedForId', 'voterId'],
  });
  const voteCounts: Record<string, number> = {};
  let userVote: string | null = null;
  votes.forEach(vote => {
    const id = String(vote.votedForId);
    voteCounts[id] = (voteCounts[id] || 0) + 1;
    if (String(vote.voterId) === String(userId)) {
      userVote = id;
    }
  });
  ctx.body = { success: true, votes: voteCounts, userVote };
});

// Add XP calculation when match is completed
router.patch('/:matchId/complete', required, async (ctx) => {
  const { matchId } = ctx.params;
  const match = await Match.findByPk(matchId, {
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' }
    ]
  });

  if (!match) {
    ctx.throw(404, 'Match not found');
    return;
  }

  // Mark match as completed
  await match.update({ status: 'completed' });

  // Calculate XP for all players in this match
  const allPlayers = [
    ...((match as any).homeTeamUsers || []),
    ...((match as any).awayTeamUsers || [])
  ];

  for (const player of allPlayers) {
    try {
      await calculateAndAwardXPAchievements(player.id, match.leagueId);
    } catch (error) {
      console.error(`Error calculating XP for player ${player.id}:`, error);
    }
  }

  ctx.status = 200;
  ctx.body = { success: true, message: 'Match completed and XP calculated' };
});

export default router;
