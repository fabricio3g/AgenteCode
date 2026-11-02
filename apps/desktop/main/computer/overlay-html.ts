/** Static isolated document. All task/app text is assigned with textContent. */
export function computerOverlayHtml(kind: 'veil' | 'bar', font = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>
    ${font ? `@font-face{font-family:Geist;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900;font-display:swap}` : ''}
    :root{color-scheme:light dark;--ink:light-dark(#242421,#efeee9);--dim:light-dark(#65655e,#b6b5ad);--sheet:light-dark(#fff,#242421);--line:light-dark(#e8e6e0,#45443e);--accent:light-dark(#a14f29,#dfa17d);--soft:light-dark(#f1efea,#38362f);--inverse:light-dark(#fff,#242421)}
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font:14px/1.45 'Geist',system-ui,sans-serif;color:var(--ink)}
    #veil{position:absolute;inset:0;pointer-events:none;background:linear-gradient(135deg,#c57d3b09,transparent 36%,#c57d3b06 78%,#c57d3b10);box-shadow:inset 0 0 70px #c57d3b0b}
    #pointer{position:absolute;left:0;top:0;pointer-events:none;display:none;filter:drop-shadow(0 1px 2px #0005);color:var(--accent)}
    #pointer svg{display:block;width:24px;height:30px}#pointer small{display:block;margin:1px 0 0 15px;padding:2px 7px;background:var(--sheet);color:var(--ink);border-radius:5px;font-size:12px}
    #bar{margin:8px;min-height:58px;display:flex;align-items:center;gap:13px;padding:10px 14px;border-radius:12px;background:var(--sheet);box-shadow:0 3px 14px #0002}
    #copy{flex:1;min-width:0}#status{font-weight:500}#activity{font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #meter{display:grid;grid-template-columns:repeat(2,4px);gap:2px;color:var(--accent);flex-shrink:0}#meter i{width:4px;height:4px;background:currentColor;opacity:.25}#meter i:nth-child(3n){opacity:1}#meter i:nth-child(2n){opacity:.55}
    body[data-active="true"] #meter i{animation:rain 1.25s linear infinite}#meter i:nth-child(2n){animation-delay:.3s}#meter i:nth-child(3n){animation-delay:.6s}@keyframes rain{50%{opacity:1}90%{opacity:.25}}
    #actions{display:flex;gap:7px;align-items:center;flex-shrink:0}button{border:0;border-radius:6px;background:transparent;color:var(--ink);font:inherit;padding:8px 10px;white-space:nowrap}button:hover{background:var(--soft)}button.primary{background:var(--ink);color:var(--inverse)}button:disabled{opacity:.45}kbd{font:12px/1.45 inherit;padding:2px 5px;border:1px solid currentColor;border-radius:4px;margin-right:5px}#elapsed{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
    @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
    @media(max-width:500px){#bar{gap:8px;padding:9px}#elapsed{display:none}button{padding:8px}#status{font-size:12px}}
  </style></head><body data-kind="${kind}">
  ${kind === 'veil' ? '<div id="veil"></div>' : '<nav id="bar" aria-label="Computer control"><span id="meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><div id="copy"><div id="status" role="status">Preparing computer control</div><div id="activity"></div></div><span id="elapsed"></span><div id="actions"><button id="takeover" class="primary"><kbd>Esc</kbd>Take over</button><button id="resume" class="primary" hidden>Resume</button><button id="end">End</button></div></nav>'}
  <script>
  (()=>{
    let current;
    const veil=document.getElementById('veil'),pointer=document.getElementById('pointer');
    const status=document.getElementById('status'),activity=document.getElementById('activity'),elapsed=document.getElementById('elapsed');
    const takeover=document.getElementById('takeover'),resume=document.getElementById('resume'),end=document.getElementById('end');
    function tick(){if(elapsed&&current?.startedAt)elapsed.textContent=Math.floor((Date.now()-current.startedAt)/1000)+'s';}
    function update(state){current=state;const active=state.phase==='active';document.body.dataset.active=String(active);
      if(veil)veil.hidden=!active;
      if(pointer){pointer.style.display=active&&state.pointer?'block':'none';if(state.pointer)pointer.style.transform='translate('+state.pointer.x+'px,'+state.pointer.y+'px)';}
      if(status){status.textContent=state.phase==='paused'?"You're in control":active?'Agente is using your computer':state.activity;activity.textContent=state.phase==='paused'?'Screen capture and agent input stopped':state.activity+' · '+(state.space==='code'?'Code':'Home');takeover.hidden=!active;resume.hidden=state.phase!=='paused';resume.disabled=!state.canResume;tick();}
    }
    if(takeover)takeover.onclick=()=>window.computerOverlay.control('takeover');
    if(resume)resume.onclick=()=>window.computerOverlay.control('resume');
    if(end)end.onclick=()=>window.computerOverlay.control('end');
    window.computerOverlay.onState(update);window.computerOverlay.ready();
    setInterval(tick,1000);
  })();
  </script></body></html>`;
}
