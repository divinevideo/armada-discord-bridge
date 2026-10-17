import { expect, test } from 'bun:test';
import { loadCommunityOrgs } from './config';
import { Decisions } from './decisions';
test('worker configuration needs only community scope, not evidence or staff credentials', () => {
  expect(loadCommunityOrgs({ MODERATION_COMMUNITY_ORGS: JSON.stringify({ ['a'.repeat(64)]: 'synthetic' }) }).get('a'.repeat(64))).toBe('synthetic');
  expect(() => loadCommunityOrgs({ MODERATION_COMMUNITY_ORGS: '{}' })).toThrow();
});
test('a keyless worker cannot accept staff decisions', async () => {
  const worker = new Decisions(undefined as never, undefined, new Map());
  await expect(worker.acceptDecision({} as never, {} as never)).rejects.toThrow(/acceptance disabled/);
});
