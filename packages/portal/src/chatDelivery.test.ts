import { describe, expect, it } from 'bun:test';
import { channelsView, openChatBatch } from '@armada-bridge/concord-core';
import { LinkDelivery } from '@armada-bridge/bridge/src/concord/linkDelivery';
import { bootstrapFixture } from '../../../scripts/fixtures/community-bootstrap';
import fixture from '../../../test-fixtures/concord/community-interop.json';
import { BridgeManager } from './manager';

const { community, folded } = bootstrapFixture(fixture);
const channel = channelsView(community, folded)[0];
const message = { ...(await openChatBatch([fixture.chatEvent], channel))[0], sourceWrapCreatedAt: 100 };
const deletion = { ...(await openChatBatch([fixture.moderatorDeleteEvent], channel))[0], sourceWrapCreatedAt: 200 };

function harness(chats: typeof message[], failure: unknown) {
  let alerts=0,delivered=0,version=0,repairFloor:number|undefined=0,coverage:Record<string,number>={};
  const checkpoints:number[]=[];
  const snapshot=()=>({ownerId:'owner',epoch:'epoch',active:true,suspended:false,workerUncertain:true,sessionGeneration:1,
    version,activationFloor:0,recoveryFloor:0,repairFloor,coverage,ordinaryCoverage:{},legacyBoundaries:{},relays:['synthetic-relay']});
  const store={deliverySnapshot:async()=>snapshot(),setDeliveryRelays:async()=>snapshot(),markDeliveryGap:async(floor:number)=>{version++;repairFloor=Math.min(repairFloor??floor,floor);return snapshot();},
    certifyDelivery:async(expected:number,until:number,next:Record<string,number>,complete:boolean)=>{if(expected!==version)return false;checkpoints.push(until);version++;coverage=next;repairFloor=complete?undefined:until+1;return true;}};
  const delivery=new LinkDelivery({onError:()=>{},onGap:floor=>store.markDeliveryGap(floor)});
  const manager=Object.create(BridgeManager.prototype);
  manager.alertMissingWebhookPermission=async()=>{alerts++;};
  const rb={id:'synthetic-chat-delivery',channel,delivery,deliveryStore:store,pool:{urls:['synthetic-relay']},
    link:{communityId:community.idHex,concordChannelIdHex:channel.idHex,discordGuildId:'g',discordChannelId:'c',enabled:true},
    client:{backfillChannel:async(_channel:unknown,since:number,_limit:number,opts:any)=>{await opts.onBatch({chats},{signal:opts.signal});await opts.onWindowComplete({since,until:300,runUntil:300},{signal:opts.signal});}},
    router:{onConcordChat:async()=>{if(++delivered===1)throw failure;return ['mirror'];}},
  };
  return {manager,rb,checkpoints,alerts:()=>alerts,delivered:()=>delivered};
}

describe('portal catch-up delivery failure boundaries',()=>{
 it('contains missing-permission failures, alerts once, and continues catch-up',async()=>{
  const h=harness([message,message],{code:50013});await h.manager.backfillMissed(h.rb);
  expect(h.alerts()).toBe(1);expect(h.delivered()).toBe(2);expect(h.checkpoints).toEqual([300]);
 });
 it('commits only a completed earlier window when a later deletion fails',async()=>{
  const h=harness([],new Error('unused'));h.rb.router.onConcordChat=async()=>['mirror'];
  h.rb.client.backfillChannel=async(_channel:any,since:number,_limit:number,opts:any)=>{
   await opts.onBatch({chats:[message]},{signal:opts.signal});await opts.onWindowComplete({since,until:100,runUntil:300},{signal:opts.signal});
   h.rb.router.onConcordChat=async()=>{throw new Error('later deletion storage failure');};
   await opts.onBatch({chats:[deletion]},{signal:opts.signal});
  };
  await expect(h.manager.backfillMissed(h.rb)).rejects.toThrow('later deletion storage failure');expect(h.checkpoints).toEqual([100]);
 });
 it('coalesces catch-up retries and resumes after a relay failure',async()=>{
  const h=harness([],new Error('unused'));let queries=0,release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
  h.rb.client.backfillChannel=async(_channel:any,since:number,_limit:number,opts:any)=>{
   if(++queries===1){await blocked;throw new Error('relay unavailable');}
   await opts.onWindowComplete({since,until:300,runUntil:300},{signal:opts.signal});
  };
  const first=h.manager.backfillMissed(h.rb);expect(h.manager.backfillMissed(h.rb)).toBe(first);
  release();await expect(first).rejects.toThrow('relay unavailable');expect(h.checkpoints).toEqual([]);
  await h.manager.backfillMissed(h.rb);expect(queries).toBe(2);expect(h.checkpoints).toEqual([300]);
 });
 it('keeps a failed deletion nondurable and does not certify catch-up',async()=>{
  const h=harness([deletion,message],new Error('deletion storage unavailable'));
  await expect(h.manager.backfillMissed(h.rb)).rejects.toThrow('deletion storage unavailable');
  expect(h.delivered()).toBe(1);expect(h.checkpoints).toEqual([]);
 });
});
