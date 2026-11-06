import { addEmailSuppressionRoute, confirmUnsubscribeRoute, createFollowUpRuleRoute, deleteFollowUpRuleRoute, listEmailSuppressionsRoute, listFollowUpRulesRoute, removeEmailSuppressionRoute, showUnsubscribeRoute, updateFollowUpRuleRoute } from '@openchat/api-contracts';
import { addEmailSuppression, confirmUnsubscribe, createFollowUpRule, deleteFollowUpRule, listEmailSuppressions, listFollowUpRules, removeEmailSuppression, unsubscribeLinkIsValid, updateFollowUpRule, workspaceContext } from '@openchat/core';
import type { Context } from 'hono';
import { authDeps, type App, type AppEnv } from '../context';

const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? 'unknown';

/** Fixed text only. Nothing here names the address, because anyone an email is forwarded to can open its link. */
function page(c: Context<AppEnv>, status: 200 | 404, body: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px}button{font:inherit;padding:.5rem 1rem}</style></head><body>${body}</body></html>`;
  return c.body(html, status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
}

const GONE = '<h1>This link does not work</h1><p>Check that you copied the whole link from the email.</p>';

export function registerEmailRoutes(app: App) {
  app.openapi(showUnsubscribeRoute, async (c) => {
    const { token } = c.req.valid('query');
    const valid = await unsubscribeLinkIsValid(await authDeps(c.env), { token, ip: clientIp(c) });
    if (!valid) return page(c, 404, GONE);
    return page(c, 200, `<h1>Stop these emails?</h1><p>You will no longer get follow-up emails from this website.</p><form method="post" action="?token=${encodeURIComponent(token!)}"><button>Unsubscribe</button></form>`);
  });

  app.openapi(confirmUnsubscribeRoute, async (c) => {
    const done = await confirmUnsubscribe(await authDeps(c.env), { token: c.req.valid('query').token, ip: clientIp(c) });
    return done ? page(c, 200, '<h1>You are unsubscribed</h1><p>You will no longer get follow-up emails from this website.</p>') : page(c, 404, GONE);
  });

  const scoped = async (c: Context<AppEnv>, workspaceId: string) => {
    const { db } = await authDeps(c.env);
    return { db, ctx: await workspaceContext(db, c.get('principal'), workspaceId) };
  };

  app.openapi(listEmailSuppressionsRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await listEmailSuppressions(db, ctx, c.req.valid('query')), 200);
  });

  app.openapi(addEmailSuppressionRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    await addEmailSuppression(db, ctx, c.req.valid('json').email);
    return c.body(null, 204);
  });

  app.openapi(removeEmailSuppressionRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    await removeEmailSuppression(db, ctx, c.req.valid('json').email);
    return c.body(null, 204);
  });

  app.openapi(listFollowUpRulesRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await listFollowUpRules(db, ctx), 200);
  });

  app.openapi(createFollowUpRuleRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await createFollowUpRule(db, ctx, c.req.valid('json')), 201);
  });

  app.openapi(updateFollowUpRuleRoute, async (c) => {
    const { workspaceId, ruleId } = c.req.valid('param');
    const { db, ctx } = await scoped(c, workspaceId);
    return c.json(await updateFollowUpRule(db, ctx, ruleId, c.req.valid('json')), 200);
  });

  app.openapi(deleteFollowUpRuleRoute, async (c) => {
    const { workspaceId, ruleId } = c.req.valid('param');
    const { db, ctx } = await scoped(c, workspaceId);
    await deleteFollowUpRule(db, ctx, ruleId);
    return c.body(null, 204);
  });
}
