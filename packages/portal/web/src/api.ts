/** Thin JSON fetch wrapper; every API error surfaces as a thrown Error. */

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    credentials: "same-origin",
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export interface Me {
  user: { id: string; username: string; avatarUrl?: string } | null;
  guilds?: Array<{ id: string; name: string; icon?: string }>;
  devLogin: boolean;
}

export interface BridgeSummary {
  bridge_id: string;
  status: string;
  status_detail?: string;
  community_name?: string;
  community_id?: string;
  discord_guild_id?: string;
  discord_channel_id?: string;
  concord_channel_id?: string;
  confirm_code?: string;
  primary_pk?: string;
  bridged_count: string;
}
