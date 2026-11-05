import type { Person } from '@openchat/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../app-context';

const ROLES = ['owner', 'admin', 'supervisor', 'agent'] as const;
type Role = (typeof ROLES)[number];

function Failure({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

/** For installation admins. The API answers 404 to anyone else, so hiding this page is only a convenience. */
export function PeoplePage({ myId }: { myId: string | undefined }) {
  const people = useQuery({ queryKey: ['people'], queryFn: () => api.listPeople({ limit: 100 }) });
  const workspaces = useQuery({ queryKey: ['admin-workspaces'], queryFn: () => api.listAdminWorkspaces({ limit: 100 }) });
  return (
    <section className="space-y-4" aria-label="People">
      <Failure error={people.error ?? workspaces.error} />
      <AddPerson />
      <ul className="space-y-4">
        {people.data?.data.map((person) => <PersonCard key={person.id} person={person} isMe={person.id === myId} workspaces={workspaces.data?.data ?? []} />)}
      </ul>
      {(people.data?.nextCursor || workspaces.data?.nextCursor) && <p className="notice">Only the first 100 are shown.</p>}
    </section>
  );
}

function AddPerson() {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const create = useMutation({
    mutationFn: () => api.createPerson({ name, email }),
    onSuccess: async () => {
      setName('');
      setEmail('');
      await client.invalidateQueries({ queryKey: ['people'] });
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
      <h2 className="font-medium">Add someone</h2>
      <div className="flex flex-wrap gap-3">
        <input className="field min-w-40 flex-1" aria-label="Name" required maxLength={100} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field min-w-56 flex-1" aria-label="Email" type="email" required placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="button" disabled={create.isPending}>Add</button>
      </div>
      <Failure error={create.error} />
      {create.isSuccess && <p className="notice" role="status">We emailed {create.data.email} a link to choose a password. It lasts seven days. Now add them to a workspace.</p>}
    </form>
  );
}

function PersonCard({ person, isMe, workspaces }: { person: Person; isMe: boolean; workspaces: { id: string; name: string }[] }) {
  const client = useQueryClient();
  const refreshed = { onSuccess: () => client.invalidateQueries({ queryKey: ['people'] }) };
  const deactivate = useMutation({ mutationFn: () => api.deactivatePerson(person.id), ...refreshed });
  const reactivate = useMutation({ mutationFn: () => api.reactivatePerson(person.id), ...refreshed });
  const setAdmin = useMutation({ mutationFn: (isInstallationAdmin: boolean) => api.updatePerson(person.id, { isInstallationAdmin }), ...refreshed });
  const assign = useMutation({ mutationFn: ({ workspaceId, role }: { workspaceId: string; role: Role }) => api.assignPerson(person.id, workspaceId, { role }), ...refreshed });
  const unassign = useMutation({ mutationFn: (workspaceId: string) => api.unassignPerson(person.id, workspaceId), ...refreshed });

  const current = person.memberships.filter((m) => m.status !== 'removed');
  const available = workspaces.filter((workspace) => !current.some((m) => m.workspaceId === workspace.id));
  const [chosen, setChosen] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const target = available.some((workspace) => workspace.id === chosen) ? chosen : available[0]?.id;

  return (
    <li className="card space-y-3" aria-label={person.name}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <div className="text-sm font-medium">{person.name}{person.deactivated ? ' (Removed)' : ''}</div>
          <div className="text-xs break-all text-slate-600 dark:text-slate-400">{person.email}</div>
        </div>
        {person.isInstallationAdmin && <span className="text-xs font-medium">Installation admin</span>}
        {person.deactivated ? (
          <button className="button-quiet" onClick={() => reactivate.mutate()}>Reactivate account</button>
        ) : (
          <>
            <button className="button-quiet" onClick={() => setAdmin.mutate(!person.isInstallationAdmin)}>{person.isInstallationAdmin ? 'Remove admin role' : 'Make admin'}</button>
            {!isMe && <button className="button-quiet" onClick={() => window.confirm(`Deactivate ${person.name}? They are signed out everywhere. Their messages stay, and you can reactivate them later.`) && deactivate.mutate()}>Deactivate account</button>}
          </>
        )}
      </div>
      <Failure error={deactivate.error ?? reactivate.error ?? setAdmin.error ?? assign.error ?? unassign.error} />
      {current.length > 0 && (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {current.map((membership) => (
            <li key={membership.memberId} className="flex flex-wrap items-center gap-3 py-2">
              <span className="min-w-40 flex-1 text-sm">{membership.workspaceName}</span>
              {membership.status === 'suspended' && <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Suspended</span>}
              <select aria-label={`Role for ${person.name} in ${membership.workspaceName}`} className="field w-auto" value={membership.role} disabled={person.deactivated} onChange={(e) => assign.mutate({ workspaceId: membership.workspaceId, role: e.target.value as Role })}>
                {ROLES.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
              <button className="button-quiet" onClick={() => window.confirm(`Remove ${person.name} from ${membership.workspaceName}?`) && unassign.mutate(membership.workspaceId)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {!person.deactivated && target && (
        <form
          className="flex flex-wrap gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            assign.mutate({ workspaceId: target, role });
          }}
        >
          <select aria-label={`Workspace to add ${person.name} to`} className="field min-w-40 flex-1" value={target} onChange={(e) => setChosen(e.target.value)}>
            {available.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <select aria-label={`Role to give ${person.name}`} className="field w-auto" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <button className="button-quiet" disabled={assign.isPending}>Add to workspace</button>
        </form>
      )}
    </li>
  );
}
