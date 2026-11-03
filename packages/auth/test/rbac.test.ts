import { describe, expect, it } from 'vitest';
import { ALL_CAPABILITIES, can, canAssignConversation, canGrantRole, canManageMember, ROLES, type Capability, type Role } from '../src/index';

// A copy of the table in docs/architecture/security.md. Written out in full so a change to one has to be
// made deliberately in both, and every combination is asserted.
const TABLE: Record<Capability, [owner: boolean, admin: boolean, supervisor: boolean, agent: boolean]> = {
  'conversation.view': [true, true, true, true],
  'conversation.reply': [true, true, true, true],
  'conversation.note': [true, true, true, true],
  'conversation.assign.self': [true, true, true, true],
  'conversation.assign.others': [true, true, true, false],
  'contact.merge': [true, true, true, false],
  'contact.export': [true, true, false, false],
  'contact.delete': [true, true, false, false],
  'website.manage': [true, true, false, false],
  'automation.manage': [true, true, false, false],
  'email.manage': [true, true, false, false],
  'member.invite': [true, true, false, false],
  'member.remove': [true, true, false, false],
  'workspace.manage': [true, true, false, false],
  'workspace.security': [true, false, false, false],
  'workspace.delete': [true, false, false, false],
  'workspace.transfer': [true, false, false, false],
};

describe('role table', () => {
  it('covers every capability', () => expect(Object.keys(TABLE).sort()).toEqual([...ALL_CAPABILITIES].sort()));

  const cases = ALL_CAPABILITIES.flatMap((capability) => ROLES.map((role, i) => [role, capability, TABLE[capability][i]] as [Role, Capability, boolean]));
  it.each(cases)('%s, %s: %s', (role, capability, expected) => expect(can(role, capability)).toBe(expected));
});

describe('canAssignConversation', () => {
  const actorMemberId = 'me';
  it.each([
    ['agent', 'takes an unassigned one', null, 'me', true],
    ['agent', 'transfers their own', 'me', 'them', true],
    ['agent', 'unassigns their own', 'me', null, true],
    ['agent', "takes someone else's", 'them', 'me', false],
    ['agent', 'gives an unassigned one away', null, 'them', false],
    ['agent', "moves someone else's", 'them', 'other', false],
    ['supervisor', "moves someone else's", 'them', 'other', true],
    ['admin', "moves someone else's", 'them', 'other', true],
    ['owner', "moves someone else's", 'them', 'other', true],
  ] as const)('%s %s', (role, _name, currentAssigneeId, newAssigneeId, expected) => {
    expect(canAssignConversation(role, { actorMemberId, currentAssigneeId, newAssigneeId })).toBe(expected);
  });
});

describe('canManageMember', () => {
  it.each([
    ['owner', 'owner', true],
    ['owner', 'admin', true],
    ['admin', 'owner', false],
    ['admin', 'admin', true],
    ['admin', 'agent', true],
    ['supervisor', 'agent', false],
    ['agent', 'agent', false],
  ] as const)('%s managing %s: %s', (actor, target, expected) => {
    expect(canManageMember(actor, target)).toBe(expected);
    expect(canGrantRole(actor, target)).toBe(expected);
  });
});
