import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { buildSync } from 'esbuild';
import { parseGoalCommand, parseGoalVerdict, goalElapsed, goalPrompt } from '../../shared/session-goal.ts';
import { parseHomeModeCommand } from '../../shared/composer-command.ts';
const require=createRequire(import.meta.url);
const code=buildSync({entryPoints:[new URL('../../main/session-goals.ts',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],bundle:true,platform:'node',format:'cjs',external:['electron'],write:false}).outputFiles[0].text;
const id='11111111-1111-4111-8111-111111111111';
async function settle(condition){for(let i=0;i<100;i++){if(await condition())return;await new Promise(resolve=>setImmediate(resolve));}throw new Error('Goal operation did not settle.');}
function setup(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agente-goals-'));
  const owner=Object.assign(new EventEmitter(),{sent:[],isDestroyed:()=>false,send(channel,args){this.sent.push({channel,args});}});
  const app=Object.assign(new EventEmitter(),{getPath:()=>directory});
  const handlers=new Map(),listeners=new Set(),snapshots=new Map();
  let verdict={verdict:'continue',reason:'Fix the remaining case.',evidence:['A focused test failed.']};
  let delay=false,verifierSession;
  const client={calls:[],onClose:()=>()=>{},onNotification(fn){listeners.add(fn);return()=>listeners.delete(fn);},notify(method,value){for(const fn of [...listeners])fn(method,value);},async request(method,args){
    this.calls.push({method,args});
    if(method==='goal.get')return null;
    if(method==='session.get')return {snapshot:snapshots.get(args.session_id)||{session_id:args.session_id,revision:1,conversation:[{role:'user',content:'Fix it'},{role:'tool',content:'Focused test: one failed',tool_call_id:'t1'},{role:'assistant',content:'More work remains.'}]}};
    if(method==='turn.start'){
      verifierSession=args.session_id;snapshots.set(verifierSession,{session_id:verifierSession,revision:1,conversation:[{role:'assistant',content:JSON.stringify(verdict)}]});
      if(!delay)queueMicrotask(()=>this.notify('turn.outcome',{session_id:verifierSession,turn_id:'verify',status:'completed',tokens:5}));
      return {turn_id:'verify'};
    }
    if(method==='turn.cancel'&&args.turn_id==='verify'&&delay){queueMicrotask(()=>this.notify('turn.outcome',{session_id:verifierSession,turn_id:'verify',status:'cancelled',tokens:0}));}
    return {ok:true};
  }};
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,require:name=>name==='electron'?{app,BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:owner}]}}:require(name),console,Buffer,setTimeout,clearTimeout,Date,process},{timeout:3000});
  const api=module.exports;api.registerSessionGoals({handle:(name,handler)=>handlers.set(name,handler)},async()=>client);
  const invoke=(name,args)=>handlers.get(name)({sender:owner},args);
  const start=()=>invoke('agente_goal_set',{sessionId:id,chatId:'chat',space:'home',objective:'Fix checkout',criteria:'Focused test passes',constraints:'No heavy tests',start:true});
  api.trackGoalTurn(id,client,owner,'provider','model');
  t.after(async()=>{app.emit('before-quit');await new Promise(resolve=>setImmediate(resolve));fs.rmSync(directory,{recursive:true,force:true});});
  return {api,client,owner,invoke,start,setVerdict:value=>verdict=value,setDelay:value=>delay=value};
}
test('slash commands share one parser and selected modes preserve their prompt',()=>{
  assert.deepEqual(parseGoalCommand('/goal pause'),{action:'pause'});
  assert.deepEqual(parseGoalCommand('/goal edit'),{action:'edit'});
  assert.deepEqual(parseGoalCommand('/GOAL fix checkout'),{action:'start',objective:'fix checkout'});
  assert.equal(parseGoalCommand('/goals'),null);
  assert.deepEqual(parseHomeModeCommand('/research max find sources'),{research:'max',prompt:'find sources'});
  assert.deepEqual(parseHomeModeCommand('/plan'),null);
});
test('goal elapsed time is informational only and achievement requires evidence',()=>{
  const goal={elapsedMs:1000,startedAt:2000};
  assert.equal(goalElapsed(goal,4000),3000);
  assert.equal(goalElapsed({...goal,startedAt:undefined},90000),1000);
  assert.match(goalPrompt({objective:'Finish the task',criteria:'',constraints:''}),/Do not stop because of elapsed time or turn count/);
  assert.throws(()=>parseGoalVerdict('{"verdict":"achieved","reason":"done","evidence":[]}'),/evidence/);
});
test('starting dispatches work and pause rejects a stale continuation',async t=>{
  const env=setup(t);await env.start();
  const sent=env.owner.sent.find(item=>item.channel==='session_goal_continue');assert(sent);
  assert.doesNotMatch(sent.args.prompt,/budget expires/);
  await env.invoke('agente_goal_action',{sessionId:id,action:'pause'});
  assert.throws(()=>env.api.trackGoalTurn(id,env.client,env.owner,'provider','model',sent.args.prompt),/paused/);
  assert.equal((await env.invoke('agente_goal_get',{sessionId:id})).phase,'paused');
});
test('an unfinished verified turn dispatches exactly one continuation',async t=>{
  const env=setup(t);await env.start();
  env.client.notify('turn.outcome',{session_id:id,turn_id:'worker-1',status:'completed',tokens:10});
  await settle(()=>env.owner.sent.filter(item=>item.channel==='session_goal_continue').length===2);
  env.client.notify('turn.outcome',{session_id:id,turn_id:'worker-1',status:'completed',tokens:10});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(env.owner.sent.filter(item=>item.channel==='session_goal_continue').length,2);
  assert.equal((await env.invoke('agente_goal_get',{sessionId:id})).turns,1);
});

test('editing a running goal dispatches the new objective after the old turn settles', async t => {
  const env = setup(t);
  await env.start();
  env.api.goalTurnStarted(id, 'previous-turn');
  const edited = await env.invoke('agente_goal_set', {
    sessionId: id, chatId: 'chat', space: 'home', objective: 'Fix refunds', criteria: 'Refund tests pass'
  });
  env.api.goalTurnStarted(id, 'previous-turn'); // Further events from the old turn.
  const continuations = () => env.owner.sent.filter(item => item.channel === 'session_goal_continue');
  assert.equal(continuations().length, 1);
  env.client.notify('turn.outcome', { session_id: id, turn_id: 'previous-turn', status: 'completed', tokens: 10 });
  await settle(() => continuations().length === 2);
  assert.equal(env.client.calls.some(call => call.method === 'turn.start'), false);
  assert.equal(continuations()[1].args.revision, edited.revision);
  assert.match(continuations()[1].args.prompt, /Objective: Fix refunds/);
});

test('editing while the goal is being checked cancels the obsolete verifier', async t => {
  const env = setup(t);
  env.setDelay(true);
  await env.start();
  env.api.goalTurnStarted(id, 'worker');
  env.client.notify('turn.outcome', { session_id: id, turn_id: 'worker', status: 'completed', tokens: 10 });
  await settle(() => env.client.calls.some(call => call.method === 'turn.start'));
  const edited = await env.invoke('agente_goal_set', { sessionId: id, chatId: 'chat', space: 'home', objective: 'Fix refunds' });
  assert.equal(edited.phase, 'working');
  assert.equal(edited.turns, 1);
  await settle(() => env.client.calls.some(call => call.method === 'turn.cancel' && call.args.turn_id === 'verify'));
  assert.match(env.owner.sent.filter(item => item.channel === 'session_goal_continue').at(-1).args.prompt, /Objective: Fix refunds/);
});
test('a fresh verifier can complete with evidence without launching another worker',async t=>{
  const env=setup(t);env.setVerdict({verdict:'achieved',reason:'The regression passed after the fix.',evidence:['Focused checkout test: exit 0.']});await env.start();
  env.client.notify('turn.outcome',{session_id:id,turn_id:'worker-2',status:'completed',tokens:10});
  await settle(async()=> (await env.invoke('agente_goal_get',{sessionId:id})).phase==='achieved');
  assert.equal(env.owner.sent.filter(item=>item.channel==='session_goal_continue').length,1);
  const verifier=env.client.calls.find(call=>call.method==='turn.start');assert.equal(verifier.args.home.max_tool_calls,0);
});
test('pause during verification cancels it and prevents a late success',async t=>{
  const env=setup(t);env.setDelay(true);await env.start();
  env.client.notify('turn.outcome',{session_id:id,turn_id:'worker-3',status:'completed',tokens:10});
  await settle(()=>env.client.calls.some(call=>call.method==='turn.start'));
  await env.invoke('agente_goal_action',{sessionId:id,action:'pause'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await env.invoke('agente_goal_get',{sessionId:id})).phase,'paused');
  assert.equal(env.owner.sent.filter(item=>item.channel==='session_goal_continue').length,1);
});
