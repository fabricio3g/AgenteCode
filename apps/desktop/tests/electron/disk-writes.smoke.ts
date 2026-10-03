/** Actual SQLite/WAL writes using an isolated database, with restart verification. */
import { app } from 'electron';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { saveChatSession, loadAllChats, closeDb } from '../../main/chat-db';
import { getAppPaths } from '../../main/paths';
process.env.TALAMOLM_HOME = mkdtempSync(join(tmpdir(), 'agente-disk-bench-'));
app.setPath('userData', process.env.TALAMOLM_HOME);
const writes = () => { try { return Number(/^write_bytes:\s+(\d+)/m.exec(readFileSync('/proc/self/io','utf8'))?.[1] || 0); } catch { return null; } };
app.whenReady().then(async () => {
 try {
  const chat = { id:'disk-fixture',title:'Disk fixture',createdAt:1,updatedAt:1,messages:Array.from({length:400},(_,index)=>({id:'m-'+index,role:'assistant',content:'Evidence '.repeat(128),createdAt:index+1,done:true,attachments:[{id:'a-'+index,name:'fixture.txt',type:'text/plain',data:'attachment '.repeat(128)}],versions:[{content:'Original '+index,createdAt:1}]})) };
  saveChatSession(chat);
  const before = writes();
  const wal = join(getAppPaths().cacheRoot,'chat-history.db-wal');
  const bytesBefore = statSync(wal).size;
  const start = performance.now();
  for(let index=0;index<20;index++){chat.messages.at(-1)!.content += ' changed';chat.updatedAt++;saveChatSession(chat);}
  const report = {updates:20,messages:400,elapsedMs:performance.now()-start,processWriteBytes:before===null?null:writes()!-before,walGrowthBytes:statSync(wal).size-bytesBefore};
  chat.messages.shift();saveChatSession(chat);closeDb();
  const recovered=loadAllChats().find((item:any)=>item.id===chat.id);
  assert.equal(recovered.messages.length,399);
  assert.equal(recovered.messages.at(-1).content,chat.messages.at(-1)!.content);
  assert.equal(recovered.messages.at(-1).attachments[0].data,chat.messages.at(-1)!.attachments[0].data);
  assert.equal(recovered.messages.at(-1).versions[0].content,'Original 399');
  console.log('PASS:',JSON.stringify(report));
 } catch(error){console.error(error);process.exitCode=1;}finally{closeDb();app.exit(process.exitCode||0);}
});
