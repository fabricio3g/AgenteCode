export function parseHomeModeCommand(value:string):{research?:'chat'|'search'|'deep'|'max';mode?:'agent'|'instant';prompt:string}|null{
  const match=value.trim().match(/^\/(research|search|agent|instant)(?:\s+([\s\S]*))?$/i);if(!match)return null;
  const name=match[1].toLowerCase(),rest=(match[2]||'').trim();
  if(name==='agent'||name==='instant')return {mode:name,prompt:rest};
  if(name==='search')return {research:'search',prompt:rest};
  const option=rest.match(/^(off|deep|max|web)(?:\s+([\s\S]*))?$/i);
  return {research:option?({off:'chat',deep:'deep',max:'max',web:'search'} as const)[option[1].toLowerCase() as 'off'|'deep'|'max'|'web']:'deep',prompt:option?(option[2]||'').trim():rest};
}
