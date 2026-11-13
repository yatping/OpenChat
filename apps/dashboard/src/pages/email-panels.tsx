/** Email settings for supervisors: follow-up rules, and addresses not to email. */
import type { FollowUpRule } from '@openchat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../app-context';
import { t, tn, type MessageKey } from '../i18n';

const REASONS: Record<'unsubscribe' | 'bounce' | 'complaint' | 'manual', MessageKey> = { unsubscribe: 'reasonUnsubscribe', bounce: 'reasonBounce', complaint: 'reasonComplaint', manual: 'reasonManual' };

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
    <section className="card space-y-3" aria-label={t('notToEmail')}>
      <h2 className="font-medium">{t('notToEmail')}</h2>
      {failure ? <p className="error" role="alert">{errorMessage(failure)}</p> : null}
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); add.mutate(email.trim()); }}>
        <input className="field min-w-48 flex-1" type="email" required maxLength={254} aria-label={t('emailAddress')} value={email} onChange={(event) => setEmail(event.target.value)} />
        <button className="button" disabled={add.isPending}>{t('add')}</button>
      </form>
      {list.data?.data.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">{t('noneYet')}</p>}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {list.data?.data.map((row) => (
          <li key={row.email} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <span className="min-w-48 flex-1 break-all">{row.email}</span>
            <span className="text-xs text-slate-600 dark:text-slate-400">{t(REASONS[row.reason])}</span>
            {row.reason === 'manual' && <button className="button-quiet" disabled={remove.isPending} onClick={() => remove.mutate(row.email)}>{t('remove')}</button>}
          </li>
        ))}
      </ul>
      {list.data?.nextCursor ? <p className="text-xs text-slate-600 dark:text-slate-400">{t('showingFirst100')}</p> : null}
    </section>
  );
}

const describeWait = (minutes: number) => (minutes % 60 === 0 ? tn('hours', minutes / 60) : t('minutes', { count: minutes }));

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
    <section className="card space-y-3" aria-label={t('followUps')}>
      <h2 className="font-medium">{t('followUps')}</h2>
      <p className="text-xs text-slate-600 dark:text-slate-400">{t('followUpHelp')}</p>
      {failure ? <p className="error" role="alert">{errorMessage(failure)}</p> : null}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {rules.data?.data.map((rule) => (
          <li key={rule.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <label className="flex min-w-48 flex-1 items-center gap-3">
              <input type="checkbox" checked={rule.enabled} disabled={toggle.isPending} onChange={() => toggle.mutate(rule)} />
              <span>{t('ruleAfter', { name: rule.name, wait: describeWait(rule.inactiveMinutes) })}</span>
            </label>
            <button className="button-quiet" disabled={remove.isPending} onClick={() => remove.mutate(rule)}>{t('delete')}</button>
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
        <label className="min-w-40 flex-1 text-sm">{t('ruleName')}
          <input className="field" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="w-32 text-sm">{t('afterMinutes')}
          <input className="field" type="number" required min={5} max={43200} value={minutes} onChange={(event) => setMinutes(event.target.value)} />
        </label>
        <button className="button" disabled={add.isPending}>{t('addRule')}</button>
      </form>
    </section>
  );
}
