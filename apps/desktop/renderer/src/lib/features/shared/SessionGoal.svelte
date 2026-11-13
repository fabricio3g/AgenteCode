<script lang="ts">
  import { Target, Pause, Play, ChevronDown, Check } from '$lib/icons';
  import { tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import { invoke, listen } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { goalElapsed, parseGoalCommand, type SessionGoal } from '$shared/session-goal';
  let {sessionId,ensureSession,running=false,chatId,space='home'}:{sessionId?:string;ensureSession:()=>string;running?:boolean;chatId:string;space?:'home'|'code'}=$props();
  let goal=$state<SessionGoal|null>(null),open=$state(false),details=$state(false),busy=$state(false),confirming=$state(false);
  let objective=$state(''),criteria=$state(''),constraints=$state('');
  let startNew=$state(false);
  let editor=$state<HTMLTextAreaElement>();
  let now=$state(Date.now());
  const active=$derived(goal?.phase==='working'||goal?.phase==='evaluating');
  const stateLabel=$derived(goal?({working:'Working',evaluating:'Checking',paused:'Paused',needs_input:'Needs input',achieved:'Achieved'})[goal.phase]:'');
  const latestResult=$derived(goal?.evidence.at(-1)||goal?.reason||(goal?.phase==='achieved'?'Goal achieved.':'No result yet.'));
  const motionDuration=()=>document.documentElement.classList.contains('a11y-reduce-motion')||matchMedia('(prefers-reduced-motion: reduce)').matches?0:160;
  $effect(()=>{
    const id=sessionId;
    goal=null;open=false;details=false;
    if(!id)return;
    let live=true;let off:(()=>void)|undefined;
    void invoke<SessionGoal|null>('agente_goal_get',{sessionId:id,chatId,space}).then(value=>{if(live)goal=value;}).catch(error=>{if(live)toastStore.error(String(error));});
    void listen<SessionGoal&{cleared?:boolean}>('session_goal_changed',value=>{if(live&&value.sessionId===id)goal=value.cleared?null:value;}).then(remove=>{if(live)off=remove;else remove();});
    return()=>{live=false;off?.();};
  });
  $effect(()=>{if(!active)return;now=Date.now();const timer=setInterval(()=>now=Date.now(),1000);return()=>clearInterval(timer);});
  export async function edit(){
    startNew=!goal||goal.phase==='achieved';
    objective=goal?.objective||'';criteria=goal?.criteria||'';constraints=goal?.constraints||'Keep checks lightweight and avoid parallel heavy processes.';open=true;await tick();editor?.focus();
  }
  async function save(){
    if(busy||!objective.trim())return;busy=true;
    try{
      const id=sessionId||ensureSession();
      goal=await invoke<SessionGoal>('agente_goal_set',{sessionId:id,chatId,space,objective,criteria,constraints,start:startNew});
      open=false;
    }catch(error){toastStore.error(String(error));}finally{busy=false;}
  }
  async function action(value:'pause'|'resume'){
    if(!sessionId||busy)return;busy=true;
    try{goal=await invoke<SessionGoal>('agente_goal_action',{sessionId,action:value});}
    catch(error){toastStore.error(String(error));}finally{busy=false;}
  }
  async function clear(){
    if(!sessionId||busy)return;busy=true;
    try{await invoke('agente_goal_clear',{sessionId});goal=null;confirming=false;details=false;}
    catch(error){toastStore.error(String(error));}finally{busy=false;}
  }
  export async function command(value:string):Promise<boolean>{
    const command=parseGoalCommand(value);if(!command)return false;
    if(command.action==='start'){startNew=true;objective=command.objective;criteria='';constraints='Keep checks lightweight and avoid parallel heavy processes.';await save();}
    else if(command.action==='view'){if(goal)details=!details;else await edit();}
    else if(command.action==='clear')confirming=true;
    else await action(command.action);
    return true;
  }
</script>
{#if goal}
  <section class="goal-bar" aria-label="Session goal">
    <div class="goal-top"><Button variant="plain" class="goal-open" aria-expanded={details} title={goal.objective} onclick={()=>details=!details}><Target class="size-3.5 shrink-0"/><span class="goal-objective">{goal.objective}</span><ChevronDown class="size-3 shrink-0"/></Button><span class="goal-state" aria-live="polite">{stateLabel}</span>{#if goal.phase==='achieved'}<Check class="size-3.5 shrink-0"/>{:else}<IconButton label={active?'Pause goal':'Resume goal'} size="xs" disabled={busy} onclick={()=>action(active?'pause':'resume')}>{#if active}<Pause class="size-3.5"/>{:else}<Play class="size-3.5"/>{/if}</IconButton>{/if}</div>
    <div class="goal-next"><span class="goal-result" title={latestResult}><span class="goal-caption">Latest result</span> {latestResult}</span><span>{Math.floor(goalElapsed(goal,now)/60_000)}m elapsed</span></div>
    {#if details}<div class="goal-details" transition:slide={{duration:motionDuration()}}>
      <div><span class="goal-caption">Done when</span><p>{goal.criteria||'The requested outcome has been verified with evidence.'}</p></div>
      {#if goal.constraints}<div><span class="goal-caption">Constraints</span><p>{goal.constraints}</p></div>{/if}
      <div><span class="goal-caption">Latest evidence</span>{#if goal.evidence.length}<ul>{#each goal.evidence as evidence}<li>{evidence}</li>{/each}</ul>{:else}<p>No verified completion evidence yet.</p>{/if}</div>
      <div class="goal-stats"><span>{goal.turns} turns · {goal.tokens.toLocaleString()} tokens</span><span>{running?'Turn running':active?'Continuing toward the goal':'No automatic continuation'}</span></div>
      <div class="goal-actions"><Button variant="ghost" size="xs" disabled={busy} onclick={edit}>Edit goal</Button><Button variant="ghost" size="xs" disabled={busy} onclick={()=>confirming=true}>Clear goal</Button></div>
    </div>{/if}
  </section>
{/if}
{#if open}<Dialog title={goal?'Edit goal':'Set a goal'} description="Work continues across turns until verified, blocked or paused by you." size="md" onclose={()=>open=false}>
    <div class="goal-form"><label>Outcome<Textarea bind:ref={editor} bind:value={objective} rows={2} maxlength={4000} placeholder="What should be achieved?" /></label><label>Done when<Textarea bind:value={criteria} rows={2} maxlength={4000} placeholder="How should completion be verified?" /></label><label>Constraints<Textarea bind:value={constraints} rows={2} maxlength={4000} /></label><p class="goal-caption">No time limit. Existing permissions and hardware-aware resource limits still apply. Computer takeover pauses work.</p></div>
  {#snippet footer()}<Button variant="ghost" disabled={busy} onclick={()=>open=false}>Cancel</Button><Button disabled={busy||!objective.trim()} onclick={save}>{goal?'Save changes':'Start goal'}</Button>{/snippet}
</Dialog>{/if}
{#if confirming}<Dialog title="Clear goal" description="Stop automatic continuation and remove this goal? The chat history remains." size="sm" onclose={()=>confirming=false}>{#snippet footer()}<Button variant="ghost" onclick={()=>confirming=false}>Cancel</Button><Button disabled={busy} onclick={clear}>Clear goal</Button>{/snippet}</Dialog>{/if}
<style>
  .goal-bar{pointer-events:auto;min-width:0;padding:0.375rem 0.75rem;font-size:var(--text-xs);color:var(--muted-foreground)}
  .goal-top{display:flex;align-items:center;gap:0.5rem;min-width:0}
  :global(.goal-open){display:flex;align-items:center;gap:0.375rem;flex:1;min-width:0;text-align:left;color:var(--foreground)}
  .goal-objective{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.goal-state{flex-shrink:0}
  .goal-next{display:flex;justify-content:space-between;gap:1rem;padding-left:1.25rem;margin-top:0.125rem}.goal-result{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.goal-next>span:last-child{flex-shrink:0;font-variant-numeric:tabular-nums}
  .goal-details{display:flex;flex-direction:column;gap:0.75rem;padding:0.75rem 0 0.25rem 1.25rem;overflow-wrap:anywhere;color:var(--foreground)}
  .goal-caption,.goal-stats{font-size:var(--text-xs);color:var(--muted-foreground)}p{margin:0.125rem 0}ul{margin:0.25rem 0;padding-left:1.125rem}.goal-stats{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0.5rem}.goal-actions{display:flex;gap:0.5rem}
  .goal-form{display:flex;flex-direction:column;gap:1rem;padding:1.25rem}.goal-form label{display:flex;flex-direction:column;gap:0.375rem;font-size:var(--text-sm)}
</style>
