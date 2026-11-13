import type { Website } from '@openchat/api-client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../app-context';
import { t, tn, tNode } from '../i18n';
import { LANGUAGES } from '../i18n/locales';

const parseOrigins = (text: string) => text.split(/[\s,]+/).filter(Boolean);

function Failure({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

/** The second key is what a member sees, in case this admin is also in the workspace. */
const refreshWebsites = (client: QueryClient, workspaceId: string) =>
  Promise.all([client.invalidateQueries({ queryKey: ['admin-websites', workspaceId] }), client.invalidateQueries({ queryKey: ['websites', workspaceId] })]);

export function CopyableSnippet({ website }: { website: Website }) {
  const snippet = `<script src="${window.location.origin}/widget/widget.js" data-website-key="${website.websiteKey}" async></script>`;
  // It scrolls sideways, so it takes focus: a keyboard user can then scroll it with the arrow keys.
  return (
    <pre className="overflow-x-auto rounded-md bg-slate-100 p-3 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 dark:bg-slate-800" tabIndex={0}>
      {snippet}
    </pre>
  );
}

/** The widget's languages are the dashboard's, each named in itself, as a visitor would look for it. */
const WIDGET_LANGUAGES = LANGUAGES;

/** What a colour input must show when nothing has been chosen. Saved only if someone chooses it. */
const DEFAULT_WIDGET_COLOR = '#0a57f5';

function WidgetSettingsForm({ website, workspaceId }: { website: Website; workspaceId: string }) {
  const client = useQueryClient();
  const initial = website.settings;
  const [welcomeMessage, setWelcome] = useState(initial.welcomeMessage ?? '');
  const [primaryColor, setColor] = useState(initial.primaryColor ?? DEFAULT_WIDGET_COLOR);
  const [collectEmail, setCollectEmail] = useState(initial.collectEmail ?? 'never');
  const [showAgentNames, setShowNames] = useState(initial.showAgentNames ?? false);
  const [requireTurnstile, setTurnstile] = useState(initial.requireTurnstile ?? false);
  const [language, setLanguage] = useState(initial.language ?? 'auto');
  const save = useMutation({
    mutationFn: () =>
      api.updateWebsite(workspaceId, website.id, {
        settings: { ...initial, ...(primaryColor === DEFAULT_WIDGET_COLOR && !initial.primaryColor ? {} : { primaryColor }), collectEmail, showAgentNames, requireTurnstile, language, ...(welcomeMessage.trim() ? { welcomeMessage: welcomeMessage.trim() } : { welcomeMessage: undefined }) },
      }),
    onSuccess: () => refreshWebsites(client, workspaceId),
  });
  return (
    <form
      className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h4 className="text-sm font-medium">{t('widget')}</h4>
      <label className="block text-sm font-medium">
        {t('welcomeMessage')}
        <textarea className="field mt-1 font-normal" rows={2} maxLength={500} value={welcomeMessage} onChange={(e) => setWelcome(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">
        {t('colour')}
        <input className="field mt-1 h-10 w-20 p-1" type="color" value={primaryColor} onChange={(e) => setColor(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">
        {t('askEmail')}
        <select className="field mt-1 w-auto font-normal" value={collectEmail} onChange={(e) => setCollectEmail(e.target.value as typeof collectEmail)}>
          <option value="never">{t('askNever')}</option>
          <option value="optional">{t('askOptional')}</option>
          <option value="required">{t('askRequired')}</option>
        </select>
      </label>
      <label className="block text-sm font-medium">
        {t('widgetLanguage')}
        <select className="field mt-1 w-auto font-normal" value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
          <option value="auto">{t('widgetLanguageAuto')}</option>
          {WIDGET_LANGUAGES.map(([code, name]) => <option key={code} value={code} lang={code}>{name}</option>)}
        </select>
      </label>
      <p className="text-xs text-slate-600 dark:text-slate-400">{tNode('widgetLanguageHint', { attribute: <code>data-locale</code> })}</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showAgentNames} onChange={(e) => setShowNames(e.target.checked)} />
        {t('showAgentNames')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={requireTurnstile} onChange={(e) => setTurnstile(e.target.checked)} />
        {t('turnstile')}
      </label>
      <Failure error={save.error} />
      {save.isSuccess && <p className="notice" role="status">{t('widgetSaved')}</p>}
      <button className="button-quiet" disabled={save.isPending}>{t('saveWidget')}</button>
    </form>
  );
}

function WebsiteCard({ website, workspaceId }: { website: Website; workspaceId: string }) {
  const client = useQueryClient();
  const [name, setName] = useState(website.name);
  const [origins, setOrigins] = useState(website.allowedOrigins.join('\n'));
  const save = useMutation({
    mutationFn: () => api.updateWebsite(workspaceId, website.id, { name, allowedOrigins: parseOrigins(origins) }),
    onSuccess: () => refreshWebsites(client, workspaceId),
  });
  return (
    <li className="card space-y-3">
      <h3 className="font-medium">{website.name}</h3>
      <CopyableSnippet website={website} />
      <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label className="block text-sm font-medium">
            {t('name')}
            <input className="field mt-1 font-normal" value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block text-sm font-medium">
            {t('allowedOrigins')}
            <textarea className="field mt-1 font-normal" rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} />
          </label>
          <Failure error={save.error} />
          {save.isSuccess && <p className="notice" role="status">{t('saved')}</p>}
          <button className="button-quiet" disabled={save.isPending}>{t('saveChanges')}</button>
      </form>
      <WidgetSettingsForm website={website} workspaceId={workspaceId} />
    </li>
  );
}

function AddWebsite({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const create = useMutation({
    mutationFn: () => api.createWebsite(workspaceId, { name, allowedOrigins: parseOrigins(origins) }),
    onSuccess: async () => {
      setName('');
      setOrigins('');
      await refreshWebsites(client, workspaceId);
    },
  });
  return (
    <form
      className="card space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <h3 className="font-medium">{t('addWebsiteTitle')}</h3>
      <label className="block text-sm font-medium">
        {t('name')}
        <input className="field mt-1 font-normal" value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">
        {t('allowedOrigins')}
        <textarea className="field mt-1 font-normal" rows={2} placeholder="https://www.example.com" value={origins} onChange={(e) => setOrigins(e.target.value)} />
      </label>
      <Failure error={create.error} />
      <button className="button" disabled={create.isPending}>{t('addWebsite')}</button>
    </form>
  );
}

function RenameWorkspace({ workspace }: { workspace: { id: string; name: string } }) {
  const client = useQueryClient();
  const [name, setName] = useState(workspace.name);
  const rename = useMutation({
    mutationFn: () => api.updateWorkspace(workspace.id, { name }),
    onSuccess: async () => {
      await Promise.all([client.invalidateQueries({ queryKey: ['admin-workspaces'] }), client.invalidateQueries({ queryKey: ['me'] })]);
    },
  });
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        rename.mutate();
      }}
    >
      <label className="min-w-48 flex-1 text-sm font-medium">
        {t('workspaceName')}
        <input className="field mt-1 font-normal" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button className="button-quiet" disabled={rename.isPending}>{t('rename')}</button>
      <Failure error={rename.error} />
    </form>
  );
}

function NewWorkspace({ onCreated }: { onCreated: (id: string) => void }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.createWorkspace(name),
    onSuccess: async (workspace) => {
      setName('');
      await client.invalidateQueries({ queryKey: ['admin-workspaces'] });
      onCreated(workspace.id);
    },
  });
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <input className="field w-48" aria-label={t('newWorkspaceName')} placeholder={t('newWorkspace')} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      <button className="button-quiet" disabled={create.isPending}>{t('createWorkspace')}</button>
      <Failure error={create.error} />
    </form>
  );
}

const RETENTION_CHOICES = [30, 90, 180, 365, 730];

/** How long the workspace keeps closed conversations. See docs/architecture/data-model.md#retention. */
function RetentionPanel({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const current = useQuery({ queryKey: ['retention', workspaceId], queryFn: () => api.getRetention(workspaceId) });
  const [choice, setChoice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (days: number | null) => api.setRetention(workspaceId, days),
    onSuccess: (data) => {
      client.setQueryData(['retention', workspaceId], data);
      setChoice(null);
    },
  });
  if (!current.data) return <Failure error={current.error} />;
  const saved = current.data.retentionDays;
  const value = choice ?? String(saved ?? '');
  const days = value === '' ? null : Number(value);
  const choices = saved === null || RETENTION_CHOICES.includes(saved) ? RETENTION_CHOICES : [...RETENTION_CHOICES, saved].sort((a, b) => a - b);
  const shorter = days !== null && (saved === null || days < saved);
  const submit = () => {
    if (shorter && !window.confirm(t('retentionConfirm', { days }))) return;
    save.mutate(days);
  };
  return (
    <section className="card space-y-2" aria-label={t('retention')}>
      <label className="block text-sm font-medium">
        {t('keepClosed')}
        <select className="field mt-1 font-normal" value={value} onChange={(e) => setChoice(e.target.value)}>
          <option value="">{t('forever')}</option>
          {choices.map((d) => <option key={d} value={String(d)}>{t('afterLastMessage', { period: d % 365 === 0 ? tn('years', d / 365) : t('days', { count: d }) })}</option>)}
        </select>
      </label>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        {t('retentionHelp')}
      </p>
      <button className="button-quiet" disabled={days === saved || save.isPending} onClick={submit}>
        {t('saveRetention')}
      </button>
      <Failure error={save.error} />
    </section>
  );
}

function ManagedWorkspace({ workspace }: { workspace: { id: string; name: string } }) {
  const websites = useQuery({ queryKey: ['admin-websites', workspace.id], queryFn: () => api.listAdminWebsites(workspace.id) });
  return (
    <div className="space-y-4">
      <RenameWorkspace workspace={workspace} />
      <RetentionPanel workspaceId={workspace.id} />
      <Failure error={websites.error} />
      {websites.data?.data.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">{t('noWebsites')}</p>}
      <ul className="space-y-4">
        {websites.data?.data.map((website) => <WebsiteCard key={website.id} website={website} workspaceId={workspace.id} />)}
      </ul>
      <p className="text-xs text-slate-600 dark:text-slate-400">{t('snippetHelp')}</p>
      <AddWebsite workspaceId={workspace.id} />
    </div>
  );
}

/**
 * Push for the whole installation. Disconnecting has the relay erase what it holds about this installation, which is
 * how its operator meets a request to erase. See docs/notification-relay/protocol.md#erasure.
 */
function RelayPanel() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ['relay-status'], queryFn: () => api.getRelayStatus() });
  const onSuccess = (data: Awaited<ReturnType<typeof api.getRelayStatus>>) => client.setQueryData(['relay-status'], data);
  // A failed disconnect still turned push off here, so the status is read again either way.
  const disconnect = useMutation({ mutationFn: () => api.disconnectRelay(), onSuccess, onSettled: () => client.invalidateQueries({ queryKey: ['relay-status'] }) });
  const reconnect = useMutation({ mutationFn: () => api.reconnectRelay(), onSuccess });
  const relay = status.data;
  if (!relay) return <Failure error={status.error} />;
  return (
    <section className="card space-y-2" aria-label={t('push')}>
      <h2 className="font-medium">{t('push')}</h2>
      {relay.state === 'not_configured' && <p className="text-sm text-slate-600 dark:text-slate-400">{t('pushNone')}</p>}
      {relay.state === 'connected' && (
        <>
          <p className="text-sm">
            {t('pushThrough', { url: relay.relay?.url ?? '' })} {relay.registered ? tn('phones', relay.subscriptions) : t('noPhones')}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {t('relayHolds')}
          </p>
          <button
            className="button-quiet"
            disabled={disconnect.isPending}
            onClick={() => window.confirm(t('disconnectConfirm')) && disconnect.mutate()}
          >
            {t('disconnectErase')}
          </button>
        </>
      )}
      {relay.state === 'disconnected' && (
        <>
          <p className="text-sm">{t('pushOff', { url: relay.relay?.url ?? '' })}</p>
          <button className="button-quiet" disabled={reconnect.isPending} onClick={() => reconnect.mutate()}>
            {t('reconnect')}
          </button>
          {disconnect.isError && <p className="text-xs text-slate-600 dark:text-slate-400">{t('erasureUnconfirmed')}</p>}
          {disconnect.isError && (
            <button className="button-quiet" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              {t('retryErasure')}
            </button>
          )}
        </>
      )}
      <Failure error={disconnect.error ?? reconnect.error} />
    </section>
  );
}

/** For installation admins, who need no membership for any of this. Conversations do need one. See ADR-0016. */
export function WorkspacesAdminPage() {
  const workspaces = useQuery({ queryKey: ['admin-workspaces'], queryFn: () => api.listAdminWorkspaces({ limit: 100 }) });
  const [chosen, setChosen] = useState('');
  const list = workspaces.data?.data ?? [];
  const workspace = list.find((w) => w.id === chosen) ?? list[0];
  return (
    <section className="space-y-4" aria-label={t('manageWorkspaces')}>
      <RelayPanel />
      <Failure error={workspaces.error} />
      <NewWorkspace onCreated={setChosen} />
      {workspaces.data?.nextCursor && <p className="notice">{t('firstHundred')}</p>}
      {list.length === 0 && workspaces.data && <p className="text-sm text-slate-600 dark:text-slate-400">{t('noWorkspaces')}</p>}
      {workspace && (
        <>
          <label className="block text-sm font-medium">
            {t('workspaceToManage')}
            <select className="field mt-1 font-normal" value={workspace.id} onChange={(e) => setChosen(e.target.value)}>
              {list.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <p className="text-xs text-slate-600 dark:text-slate-400">{t('manageHint')}</p>
          {/* The key gives each workspace fresh form state, so nothing typed in one is saved to another. */}
          <ManagedWorkspace key={workspace.id} workspace={workspace} />
        </>
      )}
    </section>
  );
}
