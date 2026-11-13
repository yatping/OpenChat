import type { AuditEntry } from '@openchat/api-client';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../app-context';
import { intlLocale, t, tn, tNode, type MessageKey } from '../i18n';

function Failure({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

/** A name where the log has one, otherwise the kind of thing and its ID. A contact never has a name here. */
function targetLabel(entry: AuditEntry): string {
  const target = entry.target;
  if (!target) return t('something');
  if (target.name) return target.name;
  const kind: Record<string, MessageKey> = { contact: 'kindContact', relay: 'kindRelay', failed_job: 'kindFailedJob', user: 'kindUser', member: 'kindMember', workspace: 'kindWorkspace', website: 'kindWebsite' };
  const known = kind[target.type];
  return `${known ? t(known) : target.type} ${target.id}`;
}

const period = (value: unknown) => {
  if (typeof value !== 'number') return t('foreverLower');
  if (value % 365 === 0) return tn('years', value / 365);
  return t('days', { count: value });
};

const roleName = (role: string) => (role === 'supervisor' ? t('roleSupervisor') : role === 'agent' ? t('roleAgent') : role).toLowerCase();

/** What happened, in words, as the key of its sentence and the words that go in it, apart from who did it. */
export function describeAudit(entry: AuditEntry): [MessageKey, Record<string, string>] {
  const target = targetLabel(entry);
  const m = entry.metadata;
  const job = typeof m.jobType === 'string' ? ` (${m.jobType})` : '';
  switch (entry.action) {
    case 'person.created':
      return ['auditPersonCreated', { target }];
    case 'person.admin_changed':
      return [m.isInstallationAdmin === 1 || m.isInstallationAdmin === true ? 'auditMadeAdmin' : 'auditRemovedAdmin', { target }];
    case 'person.deactivated':
      return ['auditDeactivated', { target }];
    case 'person.reactivated':
      return ['auditReactivated', { target }];
    case 'person.assigned':
      return typeof m.role === 'string' ? ['auditGaveRole', { target, role: roleName(m.role) }] : ['auditAssigned', { target }];
    case 'person.unassigned':
      return ['auditUnassigned', { target }];
    case 'workspace.created':
      return ['auditWorkspaceCreated', { target }];
    case 'workspace.updated':
      return ['auditWorkspaceUpdated', { target }];
    case 'workspace.retention_changed':
      return ['auditRetention', { target, from: period(m.from), to: period(m.to) }];
    case 'website.created':
      return ['auditWebsiteCreated', { target }];
    case 'website.updated':
      return ['auditWebsiteUpdated', { target }];
    case 'relay.disconnected':
      return ['auditRelayDisconnected', {}];
    case 'relay.reconnected':
      return ['auditRelayReconnected', {}];
    case 'failed_job.replayed':
      return ['auditJobReplayed', { job }];
    case 'failed_job.dismissed':
      return ['auditJobDismissed', { job }];
    case 'contact.erased':
      return ['auditContactErased', { target }];
    case 'conversations.expired':
      return ['auditConversationsExpired', { count: String(m.conversations ?? t('some')), period: period(m.retentionDays) }];
    case 'contacts.expired':
      return ['auditContactsExpired', { count: String(m.contacts ?? t('some')) }];
    default:
      return ['auditOther', { action: entry.action, target }];
  }
}

const actorName = (entry: AuditEntry) => (entry.actor.type === 'system' ? t('theSystem') : (entry.actor.name ?? t('deletedAccount')));

function AuditSentence({ entry }: { entry: AuditEntry }) {
  const [key, values] = describeAudit(entry);
  return <>{tNode(key, { ...values, actor: <span className="font-medium">{actorName(entry)}</span> })}</>;
}

/**
 * What admins, members, and the system changed. Entries hold IDs and names of what changed, never message content,
 * and a contact is never named. The API answers 404 to anyone but an installation admin.
 */
export function AuditLogPage() {
  const [workspaceId, setWorkspaceId] = useState('');
  const workspaces = useQuery({ queryKey: ['admin-workspaces'], queryFn: () => api.listAdminWorkspaces({ limit: 100 }) });
  const log = useInfiniteQuery({
    queryKey: ['audit-log', workspaceId],
    queryFn: ({ pageParam }) => api.listAuditLog({ cursor: pageParam, limit: 50, workspaceId: workspaceId || undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const entries = log.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <section className="space-y-4" aria-label={t('adminAudit')}>
      <label className="block text-sm font-medium">
        {t('show')}
        <select className="field mt-1 font-normal" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          <option value="">{t('everything')}</option>
          {workspaces.data?.data.map((w) => <option key={w.id} value={w.id}>{t('workspaceNamed', { name: w.name })}</option>)}
        </select>
      </label>
      <Failure error={log.error ?? workspaces.error} />
      {log.data && entries.length === 0 && <p className="card text-sm">{t('nothingRecorded')}</p>}
      <ol className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.id} className="card space-y-1">
            <p className="text-sm">
              <AuditSentence entry={entry} />
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString(intlLocale())}</time>
              {entry.workspace && <> · {t('workspaceNamed', { name: entry.workspace.name })}</>} · <code>{entry.action}</code>
            </p>
          </li>
        ))}
      </ol>
      {log.hasNextPage && (
        <button className="button-quiet" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          {t('showOlder')}
        </button>
      )}
    </section>
  );
}
