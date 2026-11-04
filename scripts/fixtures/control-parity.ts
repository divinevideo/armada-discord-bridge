/** Differential fold vectors from the unchanged kernel; synthetic identities only. */
import { adminRole, buildRoleEdition, buildGrantEdition, buildBanlistEdition, buildChannelEdition, buildMetadataEdition, bytesToHex, currentControlWriteGroup, foldControlState, grantLocator, hex32, openControlWraps, sealEdition } from '@armada-bridge/concord-core';
import { moderationFixture } from './moderation-events';

export async function controlParityFixture() {
  const f = await moderationFixture(), group = currentControlWriteGroup(f.community);
  const owner = { actorPubkey: f.owner.pk, version: 1n };
  const parsed = async (rumor: Parameters<typeof sealEdition>[0], signer = f.owner.signer) => openControlWraps([await sealEdition(rumor, group, signer)], [group])[0];
  const ch = hex32('12'.repeat(32));
  const c1 = await parsed(buildChannelEdition(ch, {name:'old',private:false},owner));
  const c2 = await parsed(buildChannelEdition(ch, {name:'middle',private:false},{...owner,version:2n,prevHash:c1.selfHash}));
  const c3 = await parsed(buildChannelEdition(ch, {name:'new',private:false},{...owner,version:3n,prevHash:c2.selfHash}));
  const m3 = await parsed(buildMetadataEdition(f.community.id,{name:'snapshot',relays:[]},{...owner,version:3n,prevHash:hex32('34'.repeat(32))}));
  const role = adminRole('56'.repeat(32));
  const r = await parsed(buildRoleEdition(role,owner));
  const g = await parsed(buildGrantEdition(f.community.id,{member:f.member.pk,roleIds:[role.roleId]},owner));
  const memberChannel = await parsed(buildChannelEdition(ch,{name:'member-channel',private:false},{actorPubkey:f.member.pk,version:1n,authority:{entityId:grantLocator(f.community.id,hex32(f.member.pk)),version:g.version,editionHash:g.selfHash}}),f.member.signer);
  const ban = await parsed(buildBanlistEdition(f.community.id,[f.member.pk],owner));
  const first = foldControlState([r,g,memberChannel],f.community.id,f.owner.pk);
  const heads = (h: typeof first.heads) => Object.fromEntries([...h].sort(([a],[b])=>a.localeCompare(b)).map(([id,v])=>[id,{version:v.version.toString(),hash:bytesToHex(v.hash)}]));
  const vector = (name: string, editions: typeof c1[], prior?: typeof first.heads, snapshots?: Set<string>) => {
    const folded = foldControlState(editions,f.community.id,f.owner.pk,prior,snapshots);
    return {name, opened:editions.map(e=>({author:e.author,kind:e.opened.kind,sealKind:e.opened.sealKind,content:e.content,tags:e.opened.tags,rumorId:bytesToHex(e.rumorId),createdAt:e.opened.createdAt})),priorHeads:prior?heads(prior):{},snapshotRumorIds:[...snapshots??[]],expected:{heads:heads(folded.heads),incomplete:[...folded.incomplete].sort(),banned:[...folded.banned].sort()}};
  };
  return {sourceRevision:'3febf95aef198828fc156b08e2bda4b873e55f2a',communityId:f.community.idHex,owner:f.owner.pk,cases:[
    vector('singleton-compacted-v3',[c3]),
    vector('mixed-snapshot-entities',[c1,c3,m3],undefined,new Set([bytesToHex(m3.rumorId)])),
    vector('ban-refold-with-prior-floor',[r,g,memberChannel,ban],first.heads),
  ]};
}
if(import.meta.main) console.log(JSON.stringify(await controlParityFixture(),null,2));
