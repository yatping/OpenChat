import type { AuditEntry } from '@openchat/api-client';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../app-context';

function Failure({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

/** A name where the log has one, otherwise the kind of thing and its ID. A contact never has a name here. */
function targetLabel(entry: AuditEntry): string {
  const target = entry.target;
  if (!target) return 'something';
  if (target.name) return target.name;
  const kind: Record<string, string> = { contact: 'contact', relay: 'relay', failed_job: 'failed job', user: 'person', member: 'member', workspace: 'workspace', website: 'website' };
  return `${kind[target.type] ?? target.type} ${target.id}`;
}

const days = (value: unknown) => {
  if (typeof value !== 'number') return 'forever';
  if (value % 365 === 0) return value === 365 ? '1 year' : `${value / 365} years`;
  return `${value} days`;
};

/** What happened, in words. An action this page does not know yet shows its name. */
export function describeAudit(entry: AuditEntry): string {
  const target = targetLabel(entry);
  const m = entry.metadata;
  switch (entry.action) {
    case 'person.created':
      return `added ${target}`;
    case 'person.admin_changed':
      return m.isInstallationAdmin === 1 || m.isInstallationAdmin === true ? `made ${target} an installation admin` : `removed the admin role from ${target}`;
    case 'person.deactivated':
      return `deactivated ${target}`;
    case 'person.reactivated':
      return `reactivated ${target}`;
    case 'person.assigned':
      return typeof m.role === 'string' ? `gave ${target} the ${m.role} role` : `added ${target} to the workspace`;
    case 'person.unassigned':
      return `removed ${target} from the workspace`;
    case 'workspace.created':
      return `created workspace ${target}`;
    case 'workspace.updated':
      return `changed the settings of ${target}`;
    case 'workspace.retention_changed':
      return `changed how long ${target} keeps closed conversations, from ${days(m.from)} to ${days(m.to)}`;
    case 'website.created':
      return `registered website ${target}`;
    case 'website.updated':
      return `changed website ${target}`;
    case 'relay.disconnected':
      return 'disconnected push, and had the relay erase this installation';
    case 'relay.reconnected':
      return 'reconnected push';
    case 'failed_job.replayed':
      return `replayed a failed job${typeof m.jobType === 'string' ? ` (${m.jobType})` : ''}`;
    case 'failed_job.dismissed':
      return `dismissed a failed job${typeof m.jobType === 'string' ? ` (${m.jobType})` : ''}`;
    case 'contact.erased':
      return `erased ${target}`;
    case 'conversations.expired':
      return `deleted ${String(m.conversations ?? 'some')} closed conversations past the retention of ${days(m.retentionDays)}`;
    case 'contacts.expired':
      return `deleted ${String(m.contacts ?? 'some')} contacts with no conversations left`;
    default:
      return `${entry.action} on ${target}`;
  }
}

const actorName = (entry: AuditEntry) => (entry.actor.type === 'system' ? 'The system' : (entry.actor.name ?? 'A deleted account'));

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
    <section className="space-y-4" aria-label="Audit log">
      <label className="block text-sm font-medium">
        Show
        <select className="field mt-1 font-normal" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          <option value="">Everything</option>
          {workspaces.data?.data.map((w) => <option key={w.id} value={w.id}>Workspace {w.name}</option>)}
        </select>
      </label>
      <Failure error={log.error ?? workspaces.error} />
      {log.data && entries.length === 0 && <p className="card text-sm">Nothing recorded yet.</p>}
      <ol className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.id} className="card space-y-1">
            <p className="text-sm">
              <span className="font-medium">{actorName(entry)}</span> {describeAudit(entry)}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
              {entry.workspace && <> · Workspace {entry.workspace.name}</>} · <code>{entry.action}</code>
            </p>
          </li>
        ))}
      </ol>
      {log.hasNextPage && (
        <button className="button-quiet" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          Show older
        </button>
      )}
    </section>
  );
}
