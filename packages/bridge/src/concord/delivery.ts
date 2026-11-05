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
    if (chat.kind === KIND_DELETE) throw error;
    onOrdinaryError(error);
    return [];
  }
}
