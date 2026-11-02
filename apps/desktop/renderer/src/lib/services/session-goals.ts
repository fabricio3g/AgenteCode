import { invoke, listen, isElectron } from './bridge';
import { appStore } from '$lib/stores/app.svelte';
import { codeStore } from '$lib/features/code/code.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import type { SessionGoal } from '$shared/session-goal';

export async function startSessionGoalEvents():Promise<()=>void>{
  if(!isElectron())return()=>{};
  let disposed=false;
  const pending=new Set<string>(),completed=new Set<string>();
  const off=await listen<{sessionId:string;chatId:string;space:'home'|'code';revision:number;checkpoint:number;prompt:string}>('session_goal_continue',event=>{
    const key=`${event.sessionId}:${event.revision}:${event.checkpoint}`;
    if(disposed||pending.has(key)||completed.has(key))return;
    pending.add(key);
    void(async()=>{
      for(let attempt=0;attempt<100;attempt++){
        if(disposed)return;
        const goal=await invoke<SessionGoal|null>('agente_goal_get',{sessionId:event.sessionId});
        if(!goal||goal.phase!=='working'||goal.revision!==event.revision||goal.turns!==event.checkpoint)return;
        const running=event.space==='code'?codeStore.runFor(event.chatId)?.running:appStore.isChatGenerating(event.chatId);
        if(!running){
          if(event.space==='code')await codeStore.send(event.chatId,event.prompt);
          else {
            const chat=appStore.findChat(event.chatId);if(!chat)throw new Error('The goal chat no longer exists.');
            if(appStore.currentChatId===event.chatId)appStore.setComposerMode('agent');
            else {chat.composerMode='agent';appStore.markChatDirty(chat.id);appStore.persist();}
            await appStore.sendCurrentMessage({chatId:event.chatId,queuedPrompt:{id:crypto.randomUUID(),content:event.prompt,attachments:[]}});
          }
          completed.add(key);if(completed.size>512)completed.delete(completed.values().next().value!);
          return;
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error('The previous turn is still stopping. Resume the goal once it is idle.');
    })().catch(error=>{toastStore.error(String(error));void invoke('agente_goal_action',{sessionId:event.sessionId,action:'pause'}).catch(()=>{});}).finally(()=>pending.delete(key));
  });
  return()=>{disposed=true;off();};
}
