import { expect, test } from 'bun:test';
import { deliveryRelays } from './relayGuard';
import { resolvePublicHost } from '@armada-bridge/bridge/src/net';

test('configured delivery relays fail closed on any unverifiable or private source',async()=>{
 const check=async(host:string)=>!!(await resolvePublicHost(host,async h=>{if(h.includes('unverifiable'))throw new Error('synthetic DNS failure');return [{address:'93.184.216.34',family:4}];}));
 await expect(deliveryRelays(['wss://public.example','wss://unverifiable.example'],['wss://fallback.example'],check)).rejects.toThrow();
 await expect(deliveryRelays(['ws://127.0.0.1'],['wss://fallback.example'])).rejects.toThrow();
 expect(await deliveryRelays(['wss://public.example'],['wss://fallback.example'],check)).toEqual(['wss://public.example']);
 expect(await deliveryRelays([],['wss://fallback.example'],check)).toEqual(['wss://fallback.example']);
});
