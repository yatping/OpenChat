import type { Me } from '@openchat/api-client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage, preference, queryClient, session } from '../app-context';
import { InboxPanel } from '../inbox/inbox-panel';
import { FollowUpRulesPanel, SuppressionsPanel } from './email-panels';
import { AuditLogPage } from './audit-log-page';
import { FailedJobsPage } from './failed-jobs-page';
import { PeoplePage } from './people-page';
import { CopyableSnippet, WorkspacesAdminPage } from './workspaces-admin-page';
import { SoftwareFooter } from '../software-footer';
import { Icon, Initials, type IconName } from '../icons';
import { t, type MessageKey } from '../i18n';
import { LanguagePicker } from '../language-picker';

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
    <section className="space-y-4" aria-label={t('sectionWebsites')}>
      <Failure error={websites.error} />
      {websites.data?.data.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">{t('noWebsitesMember')}</p>}
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
    <section className="space-y-4" aria-label={t('sectionMembers')}>
      <Failure error={members.error} />
      <ul className="card divide-y divide-slate-200 dark:divide-slate-800">
        {members.data?.data.map((member) => (
          <li key={member.id} className="flex flex-wrap items-center gap-3 py-3">
            <span className="avatar" aria-hidden="true"><Initials name={member.name} /></span>
            <div className="min-w-40 flex-1">
              <div className="text-sm font-medium">{member.name}</div>
              <div className="text-xs break-all text-slate-600 dark:text-slate-400">{member.email}</div>
            </div>
            {member.status === 'suspended' && <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{t('suspended')}</span>}
            {member.status === 'removed' && <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{t('removed')}</span>}
            <span className="text-sm">{t(member.role === 'supervisor' ? 'roleSupervisor' : 'roleAgent')}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-600 dark:text-slate-400">{t('membersManagedBy')}</p>
    </section>
  );
}

function EmailPanels({ workspaceId, isSupervisor }: { workspaceId: string; isSupervisor: boolean }) {
  if (!isSupervisor) return <p className="card text-sm">{t('supervisorEmail')}</p>;
  return (
    <div className="space-y-6">
      <FollowUpRulesPanel workspaceId={workspaceId} />
      <SuppressionsPanel workspaceId={workspaceId} />
    </div>
  );
}

const WORKSPACE_PREFERENCE = 'openchat.workspace';

const SECTIONS = [
  ['inbox', 'sectionInbox', 'inbox'],
  ['websites', 'sectionWebsites', 'websites'],
  ['members', 'sectionMembers', 'members'],
  ['email', 'sectionEmail', 'email'],
] as const satisfies readonly (readonly [string, MessageKey, IconName])[];
const ADMIN_PAGES = [
  ['people', 'adminPeople', 'people'],
  ['workspaces', 'adminWorkspaces', 'workspaces'],
  ['jobs', 'adminJobs', 'jobs'],
  ['audit', 'adminAudit', 'audit'],
] as const satisfies readonly (readonly [string, MessageKey, IconName])[];

type Section = (typeof SECTIONS)[number][0];
type AdminPage = (typeof ADMIN_PAGES)[number][0];

function RailButton({ label, icon, current, onClick }: { label: string; icon: IconName; current: boolean; onClick: () => void }) {
  return (
    <button type="button" className="rail-item shrink-0" aria-current={current ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} />
      <span className="sr-only">{label}</span>
      <span className="rail-tip" aria-hidden="true">{label}</span>
    </button>
  );
}

export function WorkspaceApp() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.getMe });
  const [selectedId, setSelectedId] = useState(() => preference.get(WORKSPACE_PREFERENCE));
  const [tab, setTab] = useState<Section>('inbox');
  const [adminPage, setAdminPage] = useState<AdminPage | null>(null);
  const isAdmin = me.data?.isInstallationAdmin === true;

  const memberships = me.data?.memberships ?? [];
  // A remembered workspace may be gone, or belong to someone else who used this browser.
  const current = memberships.find((m) => m.workspace.id === selectedId) ?? memberships[0];
  const select = (id: string) => {
    preference.set(WORKSPACE_PREFERENCE, id);
    setSelectedId(id);
  };
  const title = adminPage ? t(ADMIN_PAGES.find(([page]) => page === adminPage)![1]) : current ? t(SECTIONS.find(([name]) => name === tab)![1]) : 'OpenChat';
  const wide = tab === 'inbox' && !adminPage;

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="flex shrink-0 items-center gap-2 bg-navy-deep px-3 py-2 md:sticky md:top-0 md:h-dvh md:w-[72px] md:flex-col md:px-0 md:py-4">
        <img className="size-9 shrink-0 md:mb-4 md:size-10" src="/brand/mark-96.png" width={40} height={40} alt="OpenChat" />
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto md:flex-col md:overflow-visible">
          {current && (
            <nav className="flex shrink-0 gap-1 md:flex-col" aria-label={t('navSections')}>
              {SECTIONS.map(([name, label, icon]) => (
                <RailButton key={name} label={t(label)} icon={icon} current={!adminPage && tab === name} onClick={() => { setTab(name); setAdminPage(null); }} />
              ))}
            </nav>
          )}
          {isAdmin && (
            <nav className="flex shrink-0 gap-1 md:mt-3 md:flex-col md:border-t md:border-white/10 md:pt-3" aria-label={t('navAdministration')}>
              {ADMIN_PAGES.map(([page, label, icon]) => (
                <RailButton key={page} label={t(label)} icon={icon} current={adminPage === page} onClick={() => setAdminPage(adminPage === page ? null : page)} />
              ))}
            </nav>
          )}
        </div>
        <span className="avatar hidden ring-2 ring-white/20 md:inline-flex" aria-hidden="true"><Initials name={me.data?.name} /></span>
        <button type="button" className="rail-item shrink-0" onClick={() => void signOut()}>
          <Icon name="signOut" />
          <span className="sr-only">{t('signOut')}</span>
          <span className="rail-tip" aria-hidden="true">{t('signOut')}</span>
        </button>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:px-6 dark:border-slate-800 dark:bg-slate-900">
          <h1 className="flex-1 text-lg font-semibold tracking-tight">{title}</h1>
          {memberships.length > 0 && current && (
            <select className="field w-auto max-w-56" aria-label={t('workspace')} value={current.workspace.id} onChange={(e) => select(e.target.value)}>
              {memberships.map((m) => <option key={m.workspace.id} value={m.workspace.id}>{m.workspace.name}</option>)}
            </select>
          )}
          <span className="hidden text-sm text-slate-600 sm:inline dark:text-slate-400">{me.data?.name}</span>
          <LanguagePicker className="text-sm" />
        </header>
        <main className={`w-full flex-1 space-y-6 px-4 py-6 md:px-6 ${wide ? '' : 'mx-auto max-w-3xl'}`}>
          <Failure error={me.error} />
          {isAdmin && adminPage === 'people' && <PeoplePage myId={me.data?.id} />}
          {isAdmin && adminPage === 'workspaces' && <WorkspacesAdminPage />}
          {isAdmin && adminPage === 'jobs' && <FailedJobsPage />}
          {isAdmin && adminPage === 'audit' && <AuditLogPage />}
          {me.data && !current && !adminPage && (
            <p className="card text-sm">{t(isAdmin ? 'notInWorkspaceAdmin' : 'notInWorkspace')}</p>
          )}
          {current && !adminPage && (
            // The key gives each workspace fresh component state, so nothing typed in one appears in another.
            <div key={current.workspace.id}>
              {tab === 'inbox' ? <InboxWithMembers membership={current} /> : tab === 'websites' ? <WebsitesPanel membership={current} /> : tab === 'email' ? <EmailPanels workspaceId={current.workspace.id} isSupervisor={current.role === 'supervisor'} /> : <MembersPanel membership={current} />}
            </div>
          )}
        </main>
        <div className="px-4 pb-4 md:px-6">
          <SoftwareFooter />
        </div>
      </div>
    </div>
  );
}
