import type { Me, Member, Website } from '@openchat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage, preference, queryClient, session } from '../app-context';
import { InboxPanel } from '../inbox/inbox-panel';

type Membership = Me['memberships'][number];
type Role = Member['role'];

const canManage = (role: Role) => role === 'owner' || role === 'admin';

async function signOut() {
  await api.logout().catch(() => undefined);
  // Nothing from this account may remain for whoever signs in next.
  queryClient.clear();
  session.signedOut();
}

const parseOrigins = (text: string) => text.split(/[\s,]+/).filter(Boolean);

function Failure({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

function CopyableSnippet({ website }: { website: Website }) {
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
    onSuccess: () => client.invalidateQueries({ queryKey: ['websites', workspaceId] }),
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

function WebsiteCard({ website, workspaceId, editable }: { website: Website; workspaceId: string; editable: boolean }) {
  const client = useQueryClient();
  const [name, setName] = useState(website.name);
  const [origins, setOrigins] = useState(website.allowedOrigins.join('\n'));
  const save = useMutation({
    mutationFn: () => api.updateWebsite(workspaceId, website.id, { name, allowedOrigins: parseOrigins(origins) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['websites', workspaceId] }),
  });
  return (
    <li className="card space-y-3">
      <h3 className="font-medium">{website.name}</h3>
      <CopyableSnippet website={website} />
      {editable && (
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
      )}
      {editable && <WidgetSettingsForm website={website} workspaceId={workspaceId} />}
    </li>
  );
}

function WebsitesPanel({ membership }: { membership: Membership }) {
  const workspaceId = membership.workspace.id;
  const client = useQueryClient();
  const websites = useQuery({ queryKey: ['websites', workspaceId], queryFn: () => api.listWebsites(workspaceId) });
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const create = useMutation({
    mutationFn: () => api.createWebsite(workspaceId, { name, allowedOrigins: parseOrigins(origins) }),
    onSuccess: async () => {
      setName('');
      setOrigins('');
      await client.invalidateQueries({ queryKey: ['websites', workspaceId] });
    },
  });
  const editable = canManage(membership.role);
  return (
    <section className="space-y-4" aria-label="Websites">
      <Failure error={websites.error} />
      {websites.data?.data.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">No websites yet.</p>}
      <ul className="space-y-4">
        {websites.data?.data.map((website) => <WebsiteCard key={website.id} website={website} workspaceId={workspaceId} editable={editable} />)}
      </ul>
      <p className="text-xs text-slate-600 dark:text-slate-400">Add the snippet to your site, and list the site's address under allowed origins. Sites with a content security policy also need to allow this address for scripts and connections.</p>
      {editable && (
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
      )}
    </section>
  );
}

/** The list of members changes rarely, and the inbox needs names and assignees. */
function InboxWithMembers({ membership }: { membership: Membership }) {
  const members = useQuery({ queryKey: ['members', membership.workspace.id], queryFn: () => api.listMembers(membership.workspace.id) });
  return <InboxPanel membership={membership} members={members.data?.data ?? []} />;
}

const ROLE_OPTIONS: Role[] = ['owner', 'admin', 'supervisor', 'agent'];

function MembersPanel({ membership }: { membership: Membership }) {
  const workspaceId = membership.workspace.id;
  const client = useQueryClient();
  const members = useQuery({ queryKey: ['members', workspaceId], queryFn: () => api.listMembers(workspaceId) });
  const refresh = () => client.invalidateQueries({ queryKey: ['members', workspaceId] });
  const update = useMutation({
    mutationFn: (input: { id: string; role?: Role; status?: 'active' | 'suspended' }) => {
      const { id, ...change } = input;
      return api.updateMember(workspaceId, id, change);
    },
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.removeMember(workspaceId, id), onSettled: refresh });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'supervisor' | 'agent'>('agent');
  const invite = useMutation({
    mutationFn: () => api.invite(workspaceId, { email, role }),
    onSuccess: () => setEmail(''),
  });
  const manager = canManage(membership.role);
  const manageable = (member: Member) => manager && member.id !== membership.memberId && (membership.role === 'owner' || member.role !== 'owner');
  const grantable = ROLE_OPTIONS.filter((option) => membership.role === 'owner' || option !== 'owner');
  return (
    <section className="space-y-4" aria-label="Members">
      <Failure error={members.error ?? update.error ?? remove.error} />
      <ul className="card divide-y divide-slate-200 dark:divide-slate-800">
        {members.data?.data.map((member) => (
          <li key={member.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-48 flex-1">
              <div className="text-sm font-medium">{member.name}</div>
              <div className="text-xs break-all text-slate-600 dark:text-slate-400">{member.email}</div>
            </div>
            {member.status === 'suspended' && <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Suspended</span>}
            {manageable(member) ? (
              <>
                <select aria-label={`Role for ${member.name}`} className="field w-auto" value={member.role} onChange={(e) => update.mutate({ id: member.id, role: e.target.value as Role })}>
                  {grantable.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
                <button className="button-quiet" onClick={() => update.mutate({ id: member.id, status: member.status === 'active' ? 'suspended' : 'active' })}>
                  {member.status === 'active' ? 'Suspend' : 'Reactivate'}
                </button>
                <button className="button-quiet" onClick={() => window.confirm(`Remove ${member.name} from this workspace?`) && remove.mutate(member.id)}>Remove</button>
              </>
            ) : (
              <span className="text-sm capitalize">{member.role}</span>
            )}
          </li>
        ))}
      </ul>
      {manager && (
        <form
          className="card space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate();
          }}
        >
          <h3 className="font-medium">Invite someone</h3>
          <div className="flex flex-wrap gap-3">
            <input className="field min-w-56 flex-1" aria-label="Email to invite" type="email" required placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select className="field w-auto" aria-label="Role to invite as" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="agent">agent</option>
              <option value="supervisor">supervisor</option>
              <option value="admin">admin</option>
            </select>
            <button className="button" disabled={invite.isPending}>Send invitation</button>
          </div>
          <Failure error={invite.error} />
          {invite.isSuccess && <p className="notice" role="status">Invitation queued for {invite.data.email}. The link lasts seven days.</p>}
        </form>
      )}
    </section>
  );
}

function NewWorkspace({ onCreated }: { onCreated: (id: string) => void }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.createWorkspace(name),
    onSuccess: async (workspace) => {
      setName('');
      await client.invalidateQueries({ queryKey: ['me'] });
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
      <button className="button-quiet" disabled={create.isPending}>Create</button>
      <Failure error={create.error} />
    </form>
  );
}

const WORKSPACE_PREFERENCE = 'openchat.workspace';

export function WorkspaceApp() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.getMe });
  const [selectedId, setSelectedId] = useState(() => preference.get(WORKSPACE_PREFERENCE));
  const [tab, setTab] = useState<'inbox' | 'websites' | 'members'>('inbox');

  const memberships = me.data?.memberships ?? [];
  // A remembered workspace may be gone, or belong to someone else who used this browser.
  const current = memberships.find((m) => m.workspace.id === selectedId) ?? memberships[0];
  const select = (id: string) => {
    preference.set(WORKSPACE_PREFERENCE, id);
    setSelectedId(id);
  };

  return (
    <div className={`mx-auto space-y-6 px-4 py-6 ${tab === 'inbox' ? 'max-w-6xl' : 'max-w-3xl'}`}>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-lg font-semibold">OpenChat</h1>
        {memberships.length > 0 && current && (
          <select className="field w-auto" aria-label="Workspace" value={current.workspace.id} onChange={(e) => select(e.target.value)}>
            {memberships.map((m) => <option key={m.workspace.id} value={m.workspace.id}>{m.workspace.name}</option>)}
          </select>
        )}
        <span className="text-sm text-slate-600 dark:text-slate-400">{me.data?.name}</span>
        <button className="button-quiet" onClick={() => void signOut()}>Sign out</button>
      </header>
      <Failure error={me.error} />
      {me.data && !current && <p className="card text-sm">You are not a member of any workspace yet. Ask an owner to invite you.</p>}
      {current && (
        // The key gives each workspace fresh component state, so nothing typed in one appears in another.
        <div key={current.workspace.id} className="space-y-6">
          <nav className="flex gap-2" aria-label="Sections">
            {(['inbox', 'websites', 'members'] as const).map((name) => (
              <button key={name} className={tab === name ? 'button capitalize' : 'button-quiet capitalize'} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}>
                {name}
              </button>
            ))}
          </nav>
          {tab === 'inbox' ? <InboxWithMembers membership={current} /> : tab === 'websites' ? <WebsitesPanel membership={current} /> : <MembersPanel membership={current} />}
          {memberships.some((m) => m.role === 'owner') && <NewWorkspace onCreated={select} />}
        </div>
      )}
    </div>
  );
}
