import { DeletionIntakeError } from '../deletionPolicy';
import { discordPermissionObservation } from '../discord/adapter';
import type { WebhookSender } from '../router';
import { KIND_DELETE } from '@armada-bridge/concord-core';
import type { OpenedChat } from '@armada-bridge/concord-core';
import type { BridgeRouter, ChannelLink } from '../router';

/** Ordinary mirrors remain best-effort; nondurable deletion work must stop acknowledgement. */
export async function deliverConcordChat(
  router: Pick<BridgeRouter, 'onConcordChat'>,
  chat: OpenedChat,
  link: ChannelLink,
  onOrdinaryError: (error: unknown) => void,
): Promise<string[]> {
  try { return await router.onConcordChat(chat, link); }
  catch (error) {
    if (chat.kind === KIND_DELETE || error instanceof DeletionIntakeError) throw error;
    onOrdinaryError(error);
    return [];
  }
}

export function observeDeletionEffects(sender: WebhookSender,
  observe: (value: NonNullable<ReturnType<typeof discordPermissionObservation>>) => void): WebhookSender {
  const report = (error: unknown, operation: 'delete' | 'unreact') => {
    const observation = discordPermissionObservation(error, operation);
    if (observation) { try { observe(observation); } catch {} }
  };
  return new Proxy(sender, {
    get(target, key) {
      if (key === 'delete') return async (...args: Parameters<WebhookSender['delete']>) => {
        try { return await target.delete(...args); } catch (error) { report(error, 'delete'); throw error; }
      };
      if (key === 'unreact') return async (...args: Parameters<WebhookSender['unreact']>) => {
        try { return await target.unreact(...args); } catch (error) { report(error, 'unreact'); throw error; }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
