import type { NotificationPreferences } from '@openchat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../app-context';

const CHOICES = [
  { eventType: 'new_conversation', label: 'New conversations' },
  { eventType: 'conversation_unanswered', label: 'A visitor has been waiting about 15 minutes for a reply' },
] as const;

export function NotificationsPanel({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const key = ['notification-preferences', workspaceId];
  const preferences = useQuery({ queryKey: key, queryFn: () => api.getNotificationPreferences(workspaceId) });
  const save = useMutation({
    mutationFn: (next: NotificationPreferences) => api.setNotificationPreferences(workspaceId, next),
    onMutate: (next) => client.setQueryData(key, next),
    onError: () => client.invalidateQueries({ queryKey: key }),
  });
  const toggle = (eventType: (typeof CHOICES)[number]['eventType'], enabled: boolean) => {
    const others = (preferences.data?.preferences ?? []).filter((p) => !(p.channel === 'email' && p.eventType === eventType));
    save.mutate({ preferences: [...others, { eventType, channel: 'email', enabled }] });
  };
  return (
    <section className="card space-y-3" aria-label="Notifications">
      <h2 className="font-medium">Email me about</h2>
      {preferences.error ? <p className="error" role="alert">{errorMessage(preferences.error)}</p> : null}
      {save.error ? <p className="error" role="alert">{errorMessage(save.error)}</p> : null}
      {CHOICES.map(({ eventType, label }) => (
        <label key={eventType} className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            disabled={!preferences.data}
            checked={preferences.data?.preferences.find((p) => p.channel === 'email' && p.eventType === eventType)?.enabled ?? false}
            onChange={(event) => toggle(eventType, event.target.checked)}
          />
          {label}
        </label>
      ))}
      <p className="text-xs text-slate-600 dark:text-slate-400">These emails say only that something happened, and never include what anyone wrote. Each workspace has its own settings.</p>
    </section>
  );
}

const REASONS = { unsubscribe: 'Unsubscribed', bounce: 'Bounced', complaint: 'Marked as spam', manual: 'Added by hand' } as const;

/** For supervisors. Someone who asked not to be emailed stays on the list. */
export function SuppressionsPanel({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const key = ['email-suppressions', workspaceId];
  const [email, setEmail] = useState('');
  const list = useQuery({ queryKey: key, queryFn: () => api.listEmailSuppressions(workspaceId) });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const add = useMutation({ mutationFn: (address: string) => api.addEmailSuppression(workspaceId, address), onSuccess: () => { setEmail(''); void refresh(); } });
  const remove = useMutation({ mutationFn: (address: string) => api.removeEmailSuppression(workspaceId, address), onSuccess: refresh });
  const failure = list.error ?? add.error ?? remove.error;
  return (
    <section className="card space-y-3" aria-label="Addresses not to email">
      <h2 className="font-medium">Addresses not to email</h2>
      {failure ? <p className="error" role="alert">{errorMessage(failure)}</p> : null}
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); add.mutate(email.trim()); }}>
        <input className="field min-w-48 flex-1" type="email" required maxLength={254} aria-label="Email address" value={email} onChange={(event) => setEmail(event.target.value)} />
        <button className="button" disabled={add.isPending}>Add</button>
      </form>
      {list.data?.data.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">None yet.</p>}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {list.data?.data.map((row) => (
          <li key={row.email} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <span className="min-w-48 flex-1 break-all">{row.email}</span>
            <span className="text-xs text-slate-600 dark:text-slate-400">{REASONS[row.reason]}</span>
            {row.reason === 'manual' && <button className="button-quiet" disabled={remove.isPending} onClick={() => remove.mutate(row.email)}>Remove</button>}
          </li>
        ))}
      </ul>
      {list.data?.nextCursor ? <p className="text-xs text-slate-600 dark:text-slate-400">Showing the first 100.</p> : null}
    </section>
  );
}
