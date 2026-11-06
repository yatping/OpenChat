/** Rules for following up by email when a conversation goes quiet. See docs/architecture/background-jobs.md. */
import { followUpRuleRepository, type Database, type WorkspaceContext } from '@openchat/database';
import { AppError, notFound } from '@openchat/shared';
import { requireCapability } from './workspaces';

export async function listFollowUpRules(db: Database, ctx: WorkspaceContext) {
  requireCapability(ctx, 'automation.manage');
  return { data: await followUpRuleRepository(db, ctx).list() };
}

export async function createFollowUpRule(db: Database, ctx: WorkspaceContext, input: { name: string; enabled: boolean; inactiveMinutes: number }) {
  requireCapability(ctx, 'automation.manage');
  const rule = await followUpRuleRepository(db, ctx).create(input);
  if (!rule) throw new AppError(409, 'too_many_rules', 'This workspace has as many follow-up rules as it can have');
  return rule;
}

export async function updateFollowUpRule(db: Database, ctx: WorkspaceContext, ruleId: string, change: { name?: string | undefined; enabled?: boolean | undefined; inactiveMinutes?: number | undefined }) {
  requireCapability(ctx, 'automation.manage');
  const rule = await followUpRuleRepository(db, ctx).update(ruleId, change);
  if (!rule) throw notFound();
  return rule;
}

export async function deleteFollowUpRule(db: Database, ctx: WorkspaceContext, ruleId: string) {
  requireCapability(ctx, 'automation.manage');
  if (!(await followUpRuleRepository(db, ctx).remove(ruleId))) throw notFound();
}
