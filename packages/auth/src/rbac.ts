/** The role table from docs/architecture/security.md, as data. Membership is read per request. */
export const ROLES = ['owner', 'admin', 'supervisor', 'agent'] as const;
export type Role = (typeof ROLES)[number];

const ALL: readonly Role[] = ROLES;
const MANAGERS: readonly Role[] = ['owner', 'admin'];
const LEADS: readonly Role[] = ['owner', 'admin', 'supervisor'];
const OWNER: readonly Role[] = ['owner'];

const CAPABILITIES = {
  'conversation.view': ALL,
  'conversation.reply': ALL,
  'conversation.note': ALL,
  'conversation.assign.self': ALL,
  'conversation.assign.others': LEADS,
  'contact.merge': LEADS,
  'contact.export': MANAGERS,
  'contact.delete': MANAGERS,
  'website.manage': MANAGERS,
  'automation.manage': MANAGERS,
  'email.manage': MANAGERS,
  'member.invite': MANAGERS,
  'member.remove': MANAGERS,
  'workspace.manage': MANAGERS,
  'workspace.security': OWNER,
  'workspace.delete': OWNER,
  'workspace.transfer': OWNER,
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;
export const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];

export function can(role: Role, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly Role[]).includes(role);
}

/** An agent may transfer a conversation only if it is assigned to them. */
export function canAssignConversation(role: Role, input: { actorMemberId: string; currentAssigneeId: string | null; newAssigneeId: string | null }): boolean {
  if (can(role, 'conversation.assign.others')) return true;
  if (input.currentAssigneeId === input.actorMemberId) return true;
  return input.newAssigneeId === input.actorMemberId && input.currentAssigneeId === null;
}

/** Admins can manage anyone but owners. Nobody below admin manages members. */
export function canManageMember(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true;
  return actor === 'admin' && target !== 'owner';
}

/** Granting a role follows the same rule: an admin cannot create an owner. */
export const canGrantRole = canManageMember;
