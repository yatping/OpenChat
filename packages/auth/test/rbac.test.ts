import { describe, expect, it } from 'vitest';
import { ALL_CAPABILITIES, can, canAssignConversation, ROLES, type Capability, type Role } from '../src/index';

// A copy of the table in docs/architecture/security.md. Written out in full so a change to one has to be
// made deliberately in both, and every combination is asserted.
const TABLE: Record<Capability, [supervisor: boolean, agent: boolean]> = {
  'conversation.view': [true, true],
  'conversation.reply': [true, true],
  'conversation.note': [true, true],
  'conversation.assign.self': [true, true],
  'conversation.assign.others': [true, false],
  'contact.merge': [true, false],
  'suppression.manage': [true, false],
  'tag.delete': [true, false],
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
  ] as const)('%s %s', (role, _name, currentAssigneeId, newAssigneeId, expected) => {
    expect(canAssignConversation(role, { actorMemberId, currentAssigneeId, newAssigneeId })).toBe(expected);
  });
});
