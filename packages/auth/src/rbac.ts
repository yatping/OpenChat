/**
 * The roles inside a workspace, as data. Membership is read per request. Everything else, from people to
 * websites, belongs to the installation admin, who is not a workspace role. See ADR-0016.
 */
export const ROLES = ['supervisor', 'agent'] as const;
export type Role = (typeof ROLES)[number];

const ALL: readonly Role[] = ROLES;
const SUPERVISORS: readonly Role[] = ['supervisor'];

const CAPABILITIES = {
  'conversation.view': ALL,
  'conversation.reply': ALL,
  'conversation.note': ALL,
  'conversation.assign.self': ALL,
  'conversation.assign.others': SUPERVISORS,
  'contact.merge': SUPERVISORS,
  'tag.delete': SUPERVISORS,
  'suppression.manage': SUPERVISORS,
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
