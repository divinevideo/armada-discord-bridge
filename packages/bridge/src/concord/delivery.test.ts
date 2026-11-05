import { expect, it } from 'bun:test';
import { observeDeletionEffects } from './delivery';
import type { ChannelLink, WebhookSender } from '../router';

it('observes deletion operation at the adapter and retains its error and guards', async () => {
  const link: ChannelLink = { communityId: 'a', concordChannelIdHex: 'b', discordGuildId: 'c', discordChannelId: 'd', enabled: true };
  const error = { code: 50013 }, authorize = () => {}, before = async () => {};
  const observations: string[] = [];
  let guards: unknown[] = [];
  const adapter: WebhookSender = {
    send: async () => 'id', edit: async () => {}, react: async () => {}, sendTyping: async () => {},
    delete: async (_link, _id, auth, dispatch) => { guards = [auth, dispatch]; throw error; },
    unreact: async (_link, _id, _emoji, auth, dispatch) => { guards = [auth, dispatch]; throw error; },
  };
  const sender = observeDeletionEffects(adapter, observation => observations.push(`${observation.operation}:${observation.permission}`));
  await expect(sender.delete(link, 'id', authorize, before)).rejects.toBe(error);
  expect(guards).toEqual([authorize, before]);
  await expect(sender.unreact(link, 'id', 'x', authorize, before)).rejects.toBe(error);
  expect(guards).toEqual([authorize, before]);
  expect(observations).toEqual(['delete:Manage Messages']);
});

it('reports lost channel access without replacing the adapter error', async () => {
  const link: ChannelLink = { communityId: 'a', concordChannelIdHex: 'b', discordGuildId: 'c', discordChannelId: 'd', enabled: true };
  const error = { code: 50001 }, observations: string[] = [];
  const adapter: WebhookSender = { send: async () => 'id', edit: async () => {}, react: async () => {}, sendTyping: async () => {}, delete: async () => {}, unreact: async () => { throw error; } };
  const sender = observeDeletionEffects(adapter, observation => { observations.push(`${observation.operation}:${observation.permission}`); throw new Error('alert failure'); });
  await expect(sender.unreact(link, 'id', 'x')).rejects.toBe(error);
  expect(observations).toEqual(['unreact:View Channel']);
});
