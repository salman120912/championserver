import Router from '@koa/router';
import models from '../models';
import { Op, fn, col, literal } from 'sequelize';

const router = new Router({ prefix: '/leaderboard' });

const METRIC_MAP: Record<string, string> = {
  goals: 'goals',
  assists: 'assists',
  defence: 'penalties', // Use penalties for defence
  motm: 'motm',         // Custom logic below
  impact: 'free_kicks',  // Use free_kicks for impact (snake_case)
  cleanSheet: 'clean_sheets' // Use clean_sheets (snake_case)
};

router.get('/', async (ctx) => {
  const metric = (ctx.query.metric as string) || 'goals';
  const leagueId = ctx.query.leagueId as string | undefined;
  let orderField = METRIC_MAP[metric] || 'goals';

  // MOTM: aggregate from Vote model, filter by league
  if (metric === 'motm' && leagueId) {
    // Join Vote -> Match (as 'votedMatch') -> filter by leagueId
    const votes = await models.Vote.findAll({
      attributes: [
        'votedForId',
        [fn('COUNT', col('Vote.id')), 'voteCount']
      ],
      include: [{
        model: models.Match,
        as: 'votedMatch',
        attributes: [],
        where: { leagueId },
        required: true
      }, {
        model: models.User,
        as: 'votedFor',
        attributes: ['id', 'firstName', 'lastName', 'position', 'profilePicture']
      }],
      group: ['votedForId', 'votedFor.id'],
      order: [[fn('COUNT', col('Vote.id')), 'DESC']],
      limit: 5
    });
    const players = votes.map((vote: any) => ({
      id: vote.votedFor.id,
      name: `${vote.votedFor.firstName} ${vote.votedFor.lastName}`,
      position: vote.votedFor.position,
      profilePicture: vote.votedFor.profilePicture,
      value: vote.get('voteCount')
    }));
    ctx.body = { players: players || [] };
    return;
  }

  // Other metrics: aggregate from MatchStatistics, filter by league
  const include: any[] = [
    {
      model: models.User,
      as: 'user',
      attributes: ['id', 'firstName', 'lastName', 'position', 'profilePicture']
    }
  ];
  if (leagueId) {
    include.push({
      model: models.Match,
      as: 'match',
      attributes: [],
      where: { leagueId },
      required: true
    });
  }

  const stats = await models.MatchStatistics.findAll({
    attributes: [
      'user_id',
      [fn('SUM', col(orderField)), 'value']
    ],
    group: ['user_id', 'user.id'],
    order: [[literal('value'), 'DESC']],
    limit: 5,
    include
  });

  const players = stats.map((stat: any) => ({
    id: stat.user.id,
    name: `${stat.user.firstName} ${stat.user.lastName}`,
    position: stat.user.position,
    profilePicture: stat.user.profilePicture,
    value: stat.get('value')
  }));

  ctx.body = { players };
});

export default router; 