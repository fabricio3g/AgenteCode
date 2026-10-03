/** Exercise real Electron native SQLite on a worker, including FIFO and shutdown. */
import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { ChatDatabaseWorker } from '../../main/chat-db-client';
const root = mkdtempSync(join(tmpdir(),'agente-database-worker-'));
app.setPath('userData',root);
app.whenReady().then(async()=>{
 const client = new ChatDatabaseWorker(resolve('dist-electron/main/chat-db-worker.cjs'),join(root,'history.db'));
 try {
  const session = {id:'worker-fixture',title:'Worker',createdAt:1,updatedAt:1,messages:Array.from({length:400},(_,i)=>({id:'worker-'+i,role:'assistant',content:'evidence '.repeat(128),createdAt:i+1}))};
  await client.request('saveChatSession',session);
  const intervals:number[]=[];let last=performance.now();
  const timer=setInterval(()=>{const now=performance.now();intervals.push(now-last);last=now;},1);
  const start=performance.now();
  const saves=[];
  for(let i=0;i<20;i++){session.messages.at(-1)!.content+=' update';saves.push(client.request('saveChatSession',session));}
  await Promise.all(saves);clearInterval(timer);
  const chats:any=await client.request('loadAllChats');
  assert.equal(chats[0].messages.at(-1).content,session.messages.at(-1)!.content);
  assert.equal(chats[0].messages.length,400);
  const report={updates:20,elapsedMs:performance.now()-start,mainThreadTimerMaxMs:Math.max(...intervals),timerTicks:intervals.length};
  assert.ok(intervals.length>0,'Main thread never yielded while saves ran');
  await client.close();
  const restarted = new ChatDatabaseWorker(resolve('dist-electron/main/chat-db-worker.cjs'),join(root,'history.db'));
  const recovered:any=await restarted.request('loadAllChats');
  assert.equal(recovered[0].messages.at(-1).content,session.messages.at(-1)!.content);
  await restarted.close();console.log('PASS:',JSON.stringify(report));
 }catch(error){console.error(error);process.exitCode=1;}finally{await client.close();app.exit(process.exitCode||0);}
});
