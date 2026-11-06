import type { FollowUpRule, NotificationPreferences } from '@openchat/api-client';
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
    onError: () => client.invalidateQueries({ queryKey: key }),
  });
  const toggle = (eventType: (typeof CHOICES)[number]['eventType'], enabled: boolean) => {
    const others = (preferences.data?.preferences ?? []).filter((p) => !(p.channel === 'email' && p.eventType === eventType));
    const next: NotificationPreferences = { preferences: [...others, { eventType, channel: 'email', enabled }] };
    client.setQueryData(key, next);
    save.mutate(next);
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

const describeWait = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`);

/** For supervisors. */
export function FollowUpRulesPanel({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const key = ['follow-up-rules', workspaceId];
  const [name, setName] = useState('');
  const [minutes, setMinutes] = useState('60');
  const rules = useQuery({ queryKey: key, queryFn: () => api.listFollowUpRules(workspaceId) });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const add = useMutation({ mutationFn: () => api.createFollowUpRule(workspaceId, { name: name.trim(), inactiveMinutes: Number(minutes) }), onSuccess: () => { setName(''); void refresh(); } });
  const toggle = useMutation({ mutationFn: (rule: FollowUpRule) => api.updateFollowUpRule(workspaceId, rule.id, { enabled: !rule.enabled }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (rule: FollowUpRule) => api.deleteFollowUpRule(workspaceId, rule.id), onSuccess: refresh });
  const failure = rules.error ?? add.error ?? toggle.error ?? remove.error;
  return (
    <section className="card space-y-3" aria-label="Follow-up emails">
      <h2 className="font-medium">Follow-up emails</h2>
      <p className="text-xs text-slate-600 dark:text-slate-400">Sent once when an open conversation has had no messages for this long, only to visitors who gave an email address and ticked the box to allow it. Closing a browser does not count. A new or changed rule applies from the next message in a conversation.</p>
      {failure ? <p className="error" role="alert">{errorMessage(failure)}</p> : null}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {rules.data?.data.map((rule) => (
          <li key={rule.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <label className="flex min-w-48 flex-1 items-center gap-3">
              <input type="checkbox" checked={rule.enabled} disabled={toggle.isPending} onChange={() => toggle.mutate(rule)} />
              <span>{rule.name}, after {describeWait(rule.inactiveMinutes)}</span>
            </label>
            <button className="button-quiet" disabled={remove.isPending} onClick={() => remove.mutate(rule)}>Delete</button>
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
        <label className="min-w-40 flex-1 text-sm">Rule name
          <input className="field" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="w-32 text-sm">After minutes
          <input className="field" type="number" required min={5} max={43200} value={minutes} onChange={(event) => setMinutes(event.target.value)} />
        </label>
        <button className="button" disabled={add.isPending}>Add rule</button>
      </form>
    </section>
  );
}
