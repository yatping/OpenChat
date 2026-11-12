import type { Website } from '@openchat/api-client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../app-context';

const parseOrigins = (text: string) => text.split(/[\s,]+/).filter(Boolean);

function Failure({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

/** The second key is what a member sees, in case this admin is also in the workspace. */
const refreshWebsites = (client: QueryClient, workspaceId: string) =>
  Promise.all([client.invalidateQueries({ queryKey: ['admin-websites', workspaceId] }), client.invalidateQueries({ queryKey: ['websites', workspaceId] })]);

export function CopyableSnippet({ website }: { website: Website }) {
  const snippet = `<script src="${window.location.origin}/widget/widget.js" data-website-key="${website.websiteKey}" async></script>`;
  return <pre className="overflow-x-auto rounded-md bg-slate-100 p-3 text-xs dark:bg-slate-800">{snippet}</pre>;
}

/** What a colour input must show when nothing has been chosen. Saved only if someone chooses it. */
const DEFAULT_WIDGET_COLOR = '#2563eb';

function WidgetSettingsForm({ website, workspaceId }: { website: Website; workspaceId: string }) {
  const client = useQueryClient();
  const initial = website.settings;
  const [welcomeMessage, setWelcome] = useState(initial.welcomeMessage ?? '');
  const [primaryColor, setColor] = useState(initial.primaryColor ?? DEFAULT_WIDGET_COLOR);
  const [collectEmail, setCollectEmail] = useState(initial.collectEmail ?? 'never');
  const [showAgentNames, setShowNames] = useState(initial.showAgentNames ?? false);
  const [requireTurnstile, setTurnstile] = useState(initial.requireTurnstile ?? false);
  const save = useMutation({
    mutationFn: () =>
      api.updateWebsite(workspaceId, website.id, {
        settings: { ...initial, ...(primaryColor === DEFAULT_WIDGET_COLOR && !initial.primaryColor ? {} : { primaryColor }), collectEmail, showAgentNames, requireTurnstile, ...(welcomeMessage.trim() ? { welcomeMessage: welcomeMessage.trim() } : { welcomeMessage: undefined }) },
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
      <h4 className="text-sm font-medium">Widget</h4>
      <label className="block text-sm font-medium">
        Welcome message
        <textarea className="field mt-1 font-normal" rows={2} maxLength={500} value={welcomeMessage} onChange={(e) => setWelcome(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">
        Colour
        <input className="field mt-1 h-10 w-20 p-1" type="color" value={primaryColor} onChange={(e) => setColor(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">
        Ask for an email
        <select className="field mt-1 w-auto font-normal" value={collectEmail} onChange={(e) => setCollectEmail(e.target.value as typeof collectEmail)}>
          <option value="never">Never</option>
          <option value="optional">Offer it, after the first message</option>
          <option value="required">Before the first message</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showAgentNames} onChange={(e) => setShowNames(e.target.checked)} />
        Show agents' names to visitors
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={requireTurnstile} onChange={(e) => setTurnstile(e.target.checked)} />
        Check that new visitors are people, with Cloudflare Turnstile
      </label>
      <Failure error={save.error} />
      {save.isSuccess && <p className="notice" role="status">Saved. The widget picks this up within a minute.</p>}
      <button className="button-quiet" disabled={save.isPending}>Save widget settings</button>
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
            Name
            <input className="field mt-1 font-normal" value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block text-sm font-medium">
            Allowed origins, one per line
            <textarea className="field mt-1 font-normal" rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} />
          </label>
          <Failure error={save.error} />
          {save.isSuccess && <p className="notice" role="status">Saved.</p>}
          <button className="button-quiet" disabled={save.isPending}>Save changes</button>
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
      <h3 className="font-medium">Add a website</h3>
      <label className="block text-sm font-medium">
        Name
        <input className="field mt-1 font-normal" value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">
        Allowed origins, one per line
        <textarea className="field mt-1 font-normal" rows={2} placeholder="https://www.example.com" value={origins} onChange={(e) => setOrigins(e.target.value)} />
      </label>
      <Failure error={create.error} />
      <button className="button" disabled={create.isPending}>Add website</button>
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
        Workspace name
        <input className="field mt-1 font-normal" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button className="button-quiet" disabled={rename.isPending}>Rename</button>
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
      <input className="field w-48" aria-label="New workspace name" placeholder="New workspace" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      <button className="button-quiet" disabled={create.isPending}>Create workspace</button>
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
    if (shorter && !window.confirm(`Delete closed conversations older than ${days} days, with their messages and files? This starts within the hour and cannot be undone.`)) return;
    save.mutate(days);
  };
  return (
    <section className="card space-y-2" aria-label="Retention">
      <label className="block text-sm font-medium">
        Keep closed conversations
        <select className="field mt-1 font-normal" value={value} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Forever</option>
          {choices.map((d) => <option key={d} value={String(d)}>{d % 365 === 0 ? `${d / 365} ${d === 365 ? 'year' : 'years'}` : `${d} days`} after the last message</option>)}
        </select>
      </label>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        Resolved and archived conversations are deleted, with their messages and files, once their last message is this old. Contacts left with no conversations go too. Open conversations are kept. An hourly sweep does this, and the audit log records each run.
      </p>
      <button className="button-quiet" disabled={days === saved || save.isPending} onClick={submit}>
        Save retention
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
      {websites.data?.data.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">No websites yet.</p>}
      <ul className="space-y-4">
        {websites.data?.data.map((website) => <WebsiteCard key={website.id} website={website} workspaceId={workspace.id} />)}
      </ul>
      <p className="text-xs text-slate-600 dark:text-slate-400">Add the snippet to your site, and list the site's address under allowed origins. Sites with a content security policy also need to allow this address for scripts and connections.</p>
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
    <section className="card space-y-2" aria-label="Push notifications">
      <h2 className="font-medium">Push notifications</h2>
      {relay.state === 'not_configured' && <p className="text-sm text-slate-600 dark:text-slate-400">This installation has no notification relay. Messages still reach the app while it is open.</p>}
      {relay.state === 'connected' && (
        <>
          <p className="text-sm">
            Through {relay.relay?.url}. {relay.registered ? `${relay.subscriptions} ${relay.subscriptions === 1 ? 'phone is' : 'phones are'} registered.` : 'No phone has registered yet.'}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            The relay holds this installation's address, its workspace names, and opaque IDs for each phone. Disconnecting asks it to erase all of that, and turns push off for everyone.
          </p>
          <button
            className="button-quiet"
            disabled={disconnect.isPending}
            onClick={() => window.confirm('Disconnect from the relay? Push stops for everyone, and the relay erases what it holds about this installation.') && disconnect.mutate()}
          >
            Disconnect and erase
          </button>
        </>
      )}
      {relay.state === 'disconnected' && (
        <>
          <p className="text-sm">Push is off. You disconnected from {relay.relay?.url}.</p>
          <button className="button-quiet" disabled={reconnect.isPending} onClick={() => reconnect.mutate()}>
            Reconnect
          </button>
          {disconnect.isError && <p className="text-xs text-slate-600 dark:text-slate-400">The relay has not confirmed the erasure yet.</p>}
          {disconnect.isError && (
            <button className="button-quiet" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Try the erasure again
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
    <section className="space-y-4" aria-label="Manage workspaces">
      <RelayPanel />
      <Failure error={workspaces.error} />
      <NewWorkspace onCreated={setChosen} />
      {workspaces.data?.nextCursor && <p className="notice">Only the first 100 are shown.</p>}
      {list.length === 0 && workspaces.data && <p className="text-sm text-slate-600 dark:text-slate-400">No workspaces yet.</p>}
      {workspace && (
        <>
          <label className="block text-sm font-medium">
            Workspace to manage
            <select className="field mt-1 font-normal" value={workspace.id} onChange={(e) => setChosen(e.target.value)}>
              {list.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <p className="text-xs text-slate-600 dark:text-slate-400">Managing a workspace does not show you its conversations. To read them, add yourself on the People page, which is recorded in the audit log.</p>
          {/* The key gives each workspace fresh form state, so nothing typed in one is saved to another. */}
          <ManagedWorkspace key={workspace.id} workspace={workspace} />
        </>
      )}
    </section>
  );
}
