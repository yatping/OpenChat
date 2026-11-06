import type { Me } from '@openchat/api-client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage, preference, queryClient, session } from '../app-context';
import { InboxPanel } from '../inbox/inbox-panel';
import { FollowUpRulesPanel, NotificationsPanel, SuppressionsPanel } from './notifications-panel';
import { PeoplePage } from './people-page';
import { CopyableSnippet, WorkspacesAdminPage } from './workspaces-admin-page';

type Membership = Me['memberships'][number];

async function signOut() {
  await api.logout().catch(() => undefined);
  // Nothing from this account may remain for whoever signs in next.
  queryClient.clear();
  session.signedOut();
}

function Failure({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

function WebsitesPanel({ membership }: { membership: Membership }) {
  const websites = useQuery({ queryKey: ['websites', membership.workspace.id], queryFn: () => api.listWebsites(membership.workspace.id) });
  return (
    <section className="space-y-4" aria-label="Websites">
      <Failure error={websites.error} />
      {websites.data?.data.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">No websites yet. An installation admin adds them.</p>}
      <ul className="space-y-4">
        {websites.data?.data.map((website) => (
          <li key={website.id} className="card space-y-3">
            <h3 className="font-medium">{website.name}</h3>
            <CopyableSnippet website={website} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The list of members changes rarely, and the inbox needs names and assignees. */
function InboxWithMembers({ membership }: { membership: Membership }) {
  const members = useQuery({ queryKey: ['members', membership.workspace.id], queryFn: () => api.listMembers(membership.workspace.id) });
  return <InboxPanel membership={membership} members={members.data?.data ?? []} />;
}

function MembersPanel({ membership }: { membership: Membership }) {
  const members = useQuery({ queryKey: ['members', membership.workspace.id], queryFn: () => api.listMembers(membership.workspace.id) });
  return (
    <section className="space-y-4" aria-label="Members">
      <Failure error={members.error} />
      <ul className="card divide-y divide-slate-200 dark:divide-slate-800">
        {members.data?.data.map((member) => (
          <li key={member.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-48 flex-1">
              <div className="text-sm font-medium">{member.name}</div>
              <div className="text-xs break-all text-slate-600 dark:text-slate-400">{member.email}</div>
            </div>
            {member.status === 'suspended' && <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Suspended</span>}
            {member.status === 'removed' && <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Removed</span>}
            <span className="text-sm capitalize">{member.role}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-600 dark:text-slate-400">An installation admin manages people, on the People page.</p>
    </section>
  );
}

const WORKSPACE_PREFERENCE = 'openchat.workspace';

export function WorkspaceApp() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.getMe });
  const [selectedId, setSelectedId] = useState(() => preference.get(WORKSPACE_PREFERENCE));
  const [tab, setTab] = useState<'inbox' | 'websites' | 'members' | 'notifications'>('inbox');
  const [adminPage, setAdminPage] = useState<'people' | 'workspaces' | null>(null);
  const isAdmin = me.data?.isInstallationAdmin === true;

  const memberships = me.data?.memberships ?? [];
  // A remembered workspace may be gone, or belong to someone else who used this browser.
  const current = memberships.find((m) => m.workspace.id === selectedId) ?? memberships[0];
  const select = (id: string) => {
    preference.set(WORKSPACE_PREFERENCE, id);
    setSelectedId(id);
  };

  return (
    <div className={`mx-auto space-y-6 px-4 py-6 ${tab === 'inbox' && !adminPage ? 'max-w-6xl' : 'max-w-3xl'}`}>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-lg font-semibold">OpenChat</h1>
        {memberships.length > 0 && current && (
          <select className="field w-auto" aria-label="Workspace" value={current.workspace.id} onChange={(e) => select(e.target.value)}>
            {memberships.map((m) => <option key={m.workspace.id} value={m.workspace.id}>{m.workspace.name}</option>)}
          </select>
        )}
        {isAdmin &&
          ([['people', 'People'], ['workspaces', 'Workspaces']] as const).map(([page, label]) => (
            <button key={page} className={adminPage === page ? 'button' : 'button-quiet'} aria-current={adminPage === page ? 'page' : undefined} onClick={() => setAdminPage(adminPage === page ? null : page)}>
              {label}
            </button>
          ))}
        <span className="text-sm text-slate-600 dark:text-slate-400">{me.data?.name}</span>
        <button className="button-quiet" onClick={() => void signOut()}>Sign out</button>
      </header>
      <Failure error={me.error} />
      {isAdmin && adminPage === 'people' && <PeoplePage myId={me.data?.id} />}
      {isAdmin && adminPage === 'workspaces' && <WorkspacesAdminPage />}
      {me.data && !current && !adminPage && (
        <p className="card text-sm">{isAdmin ? 'You are not in a workspace. To read its conversations, add yourself on the People page.' : 'You are not in a workspace yet. Ask your administrator to add you.'}</p>
      )}
      {current && !adminPage && (
        // The key gives each workspace fresh component state, so nothing typed in one appears in another.
        <div key={current.workspace.id} className="space-y-6">
          <nav className="flex flex-wrap gap-2" aria-label="Sections">
            {(['inbox', 'websites', 'members', 'notifications'] as const).map((name) => (
              <button key={name} className={tab === name ? 'button capitalize' : 'button-quiet capitalize'} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}>
                {name}
              </button>
            ))}
          </nav>
          {tab === 'inbox' ? <InboxWithMembers membership={current} /> : tab === 'websites' ? <WebsitesPanel membership={current} /> : tab === 'notifications' ? <div className="space-y-6"><NotificationsPanel workspaceId={current.workspace.id} />{current.role === 'supervisor' && <><FollowUpRulesPanel workspaceId={current.workspace.id} /><SuppressionsPanel workspaceId={current.workspace.id} /></>}</div> : <MembersPanel membership={current} />}
        </div>
      )}
    </div>
  );
}
