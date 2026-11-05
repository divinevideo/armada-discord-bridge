import { expect, it } from 'bun:test';
import { LinkDelivery } from './concord/linkDelivery';
import type { DeliveredChat } from './concord/replay';
import type { ChannelV2 } from '@armada-bridge/concord-core';
import { Shutdown } from './shutdown';

it('aborts startup immediately and cleans resources that arrive during shutdown', async () => {
  const order: string[] = [];
  const shutdown = new Shutdown(100);
  shutdown.register(async () => { order.push('first'); });
  const stopping = shutdown.begin();
  expect(shutdown.signal.aborted).toBe(true);
  shutdown.register(async () => { order.push('late'); });
  shutdown.finishStartup();
  await stopping;
  expect(order).toEqual(['late', 'first']);
});

it('bounds cleanup even if an effect never settles', async () => {
  const shutdown = new Shutdown(10);
  shutdown.register(() => new Promise<void>(() => {}));
  shutdown.finishStartup();
  const completed = await Promise.race([shutdown.begin().then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
  expect(completed).toBe(true);
});

it('aborts catch-up before cleanup and fences a late callback', async () => {
  const shutdown = new Shutdown(100);
  const delivery = new LinkDelivery({ onError: () => {} });
  shutdown.signal.addEventListener('abort', () => delivery.stop(), { once: true });
  const cleaned: string[] = [];
  shutdown.register(async () => { cleaned.push('lease released'); });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let effects = 0, checkpoints = 0, late: Promise<void> | undefined;
  const channel = { streams: [{ epoch: 0n, group: { pk: 'stream' } }] } as unknown as ChannelV2;
  const snapshot = { ownerId: 'owner', epoch: 'epoch', active: true, suspended: false, workerUncertain: true, sessionGeneration: 1, version: 0, activationFloor: 100, recoveryFloor: 100, ordinaryCoverage: {}, repairFloor: 100, coverage: {}, legacyBoundaries: {} };
  const run = delivery.repair({discover: async () => () => {},  store: { deliverySnapshot: async () => snapshot, certifyDelivery: async () => { checkpoints++; return true; } }, channel: () => channel,
    deliver: async (_chat, signal) => { entered(); await blocked; signal.throwIfAborted(); effects++; },
    replay: async (_channel, _since, opts) => {
      const chat = { rumorId: 'synthetic', streamPk: 'stream', sourceWrapCreatedAt: 100, createdAt: 100, epoch: 0n, kind: 5 } as DeliveredChat;
      late = opts.onBatch!({ chats: [chat] }, { signal: opts.signal! });
      void late.catch(() => {});
      await Promise.race([late, new Promise<void>((_resolve, reject) => opts.signal!.addEventListener('abort', () => reject(opts.signal!.reason), { once: true }))]);
    },
  });
  void run.catch(() => {});
  await started;
  shutdown.finishStartup();
  await shutdown.begin();
  expect(cleaned).toEqual(['lease released']);
  release(); await Promise.allSettled([run, late!]);
  expect(effects).toBe(0); expect(checkpoints).toBe(0);
});

it('handles real SIGTERM during a blocked synthetic catch-up', async () => {
  const script = `
    import {Shutdown} from './packages/bridge/src/shutdown.ts';
    import {LinkDelivery} from './packages/bridge/src/concord/linkDelivery.ts';
    const shutdown=new Shutdown(500), lane=new LinkDelivery({onError:()=>{}});
    shutdown.signal.addEventListener('abort',()=>lane.stop(),{once:true});
    let release; const blocked=new Promise(r=>release=r); let effects=0, checkpoints=0;
    const keepAlive=setInterval(()=>{},1000);
    let released=false; shutdown.register(()=>{clearInterval(keepAlive);released=true;});
    const snapshot={ownerId:'o',epoch:'e',active:true,suspended:false,workerUncertain:true,sessionGeneration:1,version:0,activationFloor:100,recoveryFloor:100,repairFloor:100,coverage:{},ordinaryCoverage:{},legacyBoundaries:{}};
    const channel={streams:[{epoch:0n,group:{pk:'s'}}]};
    const run=lane.repair({discover: async () => () => {}, store:{deliverySnapshot:async()=>snapshot,certifyDelivery:async()=>{checkpoints++;return true;}},channel:()=>channel,
      deliver:async(_chat,signal)=>{process.stdout.write('ready\\n');await blocked;signal.throwIfAborted();effects++;},
      replay:async(_c,_s,opts)=>{const pending=opts.onBatch({chats:[{rumorId:'r',streamPk:'s',sourceWrapCreatedAt:100,createdAt:100,epoch:0n,kind:5}]},{signal:opts.signal});void pending.catch(()=>{});await Promise.race([pending,new Promise((_r,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}))]);}});
    void run.catch(()=>{});
    process.on('SIGTERM',()=>{shutdown.finishStartup();void shutdown.begin().then(async()=>{release();await Promise.allSettled([run]);await Bun.sleep(0);process.stdout.write((released?'released\\n':'')+'effects='+effects+' checkpoints='+checkpoints+'\\n',()=>process.exit(0));});});
  `;
  const child=Bun.spawn([process.execPath,'-e',script],{cwd:process.cwd(),env:{PATH:process.env.PATH!,HOME:process.env.HOME!,TMPDIR:process.env.TMPDIR ?? '/tmp'},stdout:'pipe',stderr:'pipe'});
  const reader=child.stdout.getReader(), decoder=new TextDecoder(); let output='';
  try {
    for(;;) {const next=await reader.read();if(next.done)throw new Error('child exited before ready');output+=decoder.decode(next.value);if(output.includes('ready\n'))break;}
    child.kill('SIGTERM');
    for(;;) {const next=await reader.read();if(next.done)break;output+=decoder.decode(next.value);}
    expect(await child.exited).toBe(0);
    expect(output).toContain('released\n');expect(output).toContain('effects=0 checkpoints=0\n');
  } finally {child.kill();reader.releaseLock();}
}, 10_000);
