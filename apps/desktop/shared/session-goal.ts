export type GoalPhase = 'working' | 'evaluating' | 'paused' | 'needs_input' | 'achieved';
export interface SessionGoal {
  sessionId: string; chatId: string; space: 'home' | 'code'; revision: number;
  objective: string; criteria: string; constraints: string;
  phase: GoalPhase; reason: string; evidence: string[]; turns: number; tokens: number;
  elapsedMs: number; startedAt?: number; updatedAt: number; noProgress: number;
}
export type GoalCommand = {action:'view'|'pause'|'resume'|'clear'} | {action:'start';objective:string};
export function parseGoalCommand(text: string): GoalCommand | null {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const value = (match[1] || '').trim();
  if (!value) return {action:'view'};
  if (['pause','resume','clear'].includes(value.toLowerCase())) return {action:value.toLowerCase() as 'pause'|'resume'|'clear'};
  return {action:'start',objective:value};
}
export function goalElapsed(goal: SessionGoal, now=Date.now()): number {
  return goal.elapsedMs + (goal.startedAt === undefined ? 0 : Math.max(0,now-goal.startedAt));
}
export function goalPrompt(goal: SessionGoal): string {
  return `Objective: ${goal.objective}\nDone when: ${goal.criteria || 'Verify the requested outcome with evidence.'}\nConstraints: ${goal.constraints || 'Keep existing permissions and resource limits.'}\nContinue across turns for as long as needed until the goal is verified or a real blocker requires the user's input. Do not claim success without evidence. Do not stop because of elapsed time or turn count. Respect hardware limits and avoid parallel heavy work.`;
}
export function parseGoalVerdict(text: string): {verdict:'achieved'|'continue'|'needs_input';reason:string;evidence:string[]} {
  const start=text.indexOf('{'),end=text.lastIndexOf('}');
  const value=JSON.parse(text.slice(start,end+1));
  if (!['achieved','continue','needs_input'].includes(value.verdict) || typeof value.reason!=='string' || !value.reason.trim() || !Array.isArray(value.evidence) || value.evidence.some((item:unknown)=>typeof item!=='string')) throw new Error('Goal verification did not return a valid verdict.');
  if (value.verdict==='achieved' && !value.evidence.length) throw new Error('Completion requires evidence.');
  return {verdict:value.verdict,reason:value.reason.slice(0,2000),evidence:value.evidence.slice(0,8).map((item:string)=>item.slice(0,2000))};
}
