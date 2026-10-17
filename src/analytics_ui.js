function createUsageAnalytics({api,getChats,onOpenChat,isVisible,getEnabled,setEnabled,cutoffCard}) {
 const svgNS='http://www.w3.org/2000/svg',palette=['#5684dd','#a07bda','#db9361','#46a18d','#c36b93','#8c9c43','#628eaa','#bd7b51','#7880bb','#b5a050','#638769','#b57373'];
 const metricNames={turns:'Turns',activeMs:'Active time',toolCalls:'Tool calls'};
 const rangeCache=new Map();
 let root=null,data=null,range='7',leaderMetric='turns',request=0,loading=false,hiddenModels=new Set(),mountedRange=null;
 const el=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!=null)n.textContent=text;return n;};
 const svg=(tag,attrs={})=>{const n=document.createElementNS(svgNS,tag);for(const [key,value]of Object.entries(attrs))n.setAttribute(key,String(value));return n;};
 const count=value=>new Intl.NumberFormat(undefined,{notation:value>=10000?'compact':'standard',maximumFractionDigits:1}).format(value||0);
 const duration=ms=>{const m=Math.floor((ms||0)/60000);return m>=60?`${Math.floor(m/60)}h${m%60?` ${m%60}m`:''}`:m?`${m}m`:ms>0?'<1m':'0m';};
 const valueText=(key,v)=>key==='activeMs'?duration(v):count(v);
 const fullModel=row=>row.model==='unattributed'?'Unattributed':`${row.model.replace(/^gpt-/,'GPT-').replace(/-sol$/,' Sol').replace(/-astra$/,' Astra')} · ${row.effort==='max'?'Max':row.effort.replace(/^./,c=>c.toUpperCase())}`;
 const emptyTotals=()=>({turns:0,toolCalls:0,goals:0,activeMs:0});
 const totals=value=>Object.fromEntries(Object.keys(emptyTotals()).map(k=>[k,Number.isFinite(value?.[k])&&value[k]>=0?value[k]:0]));
 function sanitize(value){
  const models=Array.isArray(value?.models)?value.models.filter(m=>m&&typeof m.id==='string'&&typeof m.model==='string'&&typeof m.effort==='string'&&m.id.length<300).map(m=>({...totals(m),id:m.id,model:m.model,effort:m.effort})):[];
  const daily=Array.isArray(value?.daily)?value.daily.filter(d=>d&&/^\d{4}-\d{2}-\d{2}$/.test(d.date)&&d.models&&typeof d.models==='object').map(d=>({date:d.date,models:new Map(Object.entries(d.models).map(([id,t])=>[id,totals(t)]))})):[];
  const conversations=Array.isArray(value?.conversations)?value.conversations.filter(c=>c&&typeof c.id==='string'&&/^[a-f0-9]{64}$/.test(c.id)).map(c=>({...totals(c),id:c.id})):[];
  return {models,daily,conversations,totals:totals(value?.totals),lifetime:totals(value?.lifetime),since:Number.isFinite(value?.since)?value.since:null,today:/^\d{4}-\d{2}-\d{2}$/.test(value?.today)?value.today:new Date().toISOString().slice(0,10),timezone:typeof value?.timezone==='string'?value.timezone:'server time',activeDays:Number.isFinite(value?.activeDays)?value.activeDays:0,streak:Number.isFinite(value?.streak)?value.streak:0};
 }
 const style=el('style');style.textContent=`
#settings-dialog .analytics{--chart-grid:color-mix(in srgb,var(--line) 65%,transparent);display:grid;gap:18px;min-width:0}
#settings-dialog .analytics-hero{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(110deg,color-mix(in srgb,var(--selected) 78%,var(--panel)),var(--panel))}
#settings-dialog .analytics-eyebrow{font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:1.3px;color:var(--accent);margin:0 0 7px}
#settings-dialog .analytics-hero h4{font-size:24px;letter-spacing:-.7px;font-weight:650;margin:0;line-height:1.2}
#settings-dialog .analytics-hero p:last-child{font-size:12px;color:var(--muted);margin:8px 0 0}
#settings-dialog .analytics-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
#settings-dialog .analytics-select{font:inherit;font-size:12px;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px;max-width:100%}
#settings-dialog .analytics-controls button{padding:8px;font-size:11px;white-space:nowrap}
#settings-dialog .analytics-status{font-size:11px;color:var(--accent);display:flex;align-items:center;gap:5px;white-space:nowrap}
#settings-dialog .analytics-status:before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
#settings-dialog .analytics-status[data-paused=true]{color:var(--muted)}
#settings-dialog .analytics-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
#settings-dialog .analytics-kpi{border:1px solid var(--line);border-radius:13px;background:var(--panel);padding:16px;min-width:0}
#settings-dialog .analytics-kpi-label{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:8px;margin:0}
#settings-dialog .analytics-kpi-value{display:block;font-size:30px;font-weight:650;letter-spacing:-1px;line-height:1.2;margin:10px 0 7px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
#settings-dialog .analytics-kpi-foot{font-size:10px;color:var(--muted)}
#settings-dialog .analytics-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}
#settings-dialog .analytics-card{border:1px solid var(--line);border-radius:14px;padding:18px;min-width:0;background:var(--panel);overflow:hidden}
#settings-dialog .analytics-card h4{font-size:13px;font-weight:600;margin:0}
#settings-dialog .analytics-card-copy{font-size:11px;color:var(--muted);margin:5px 0 15px;line-height:1.5}
#settings-dialog .analytics-wide{grid-column:1/-1}
#settings-dialog .analytics-chart svg{display:block;width:100%;height:auto;fill:none;stroke:none;overflow:visible}
#settings-dialog .analytics-chart text{font-family:inherit;font-size:10px;fill:var(--muted)}
#settings-dialog .analytics-chart .chart-grid{stroke:var(--chart-grid);stroke-dasharray:3 4}
#settings-dialog .analytics-chart g[tabindex]:focus{outline:0;filter:brightness(.85)}
#settings-dialog .analytics-chart g[tabindex]:focus .chart-hit{stroke:var(--accent);stroke-width:1}
#settings-dialog .analytics-chart-detail{font-size:10px;color:var(--muted);min-height:15px;margin:8px 0 0;font-variant-numeric:tabular-nums}
#settings-dialog .analytics-legend{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:12px}
#settings-dialog .analytics-legend button{border:0;background:transparent;padding:2px 0;font-size:10px;color:var(--muted);gap:5px;text-align:left}
#settings-dialog .analytics-dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--series)}
#settings-dialog .analytics-legend button[aria-pressed=false]{opacity:.4;text-decoration:line-through}
#settings-dialog .analytics-league-tabs{display:flex;gap:4px;flex-wrap:wrap;margin:12px 0}
#settings-dialog .analytics-league-tabs button{border:0;padding:5px 8px;font-size:10px;color:var(--muted);background:var(--bg)}
#settings-dialog .analytics-league-tabs button[aria-pressed=true]{color:var(--accent);background:var(--selected)}
#settings-dialog .analytics-rank{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--line)}
#settings-dialog .analytics-rank:last-child{border-bottom:0;padding-bottom:0}
#settings-dialog .analytics-rank-number{display:grid;place-items:center;flex:none;width:25px;height:25px;border-radius:8px;background:var(--bg);color:var(--muted);font-size:11px;font-weight:600}
#settings-dialog .analytics-rank:first-child .analytics-rank-number{background:#e9be5330;color:#987219}
#settings-dialog .analytics-rank-copy{min-width:0;flex:1}
#settings-dialog button.analytics-chat-link{display:block;text-align:left;max-width:100%;padding:0;border:0;background:transparent;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#settings-dialog .analytics-rank-project{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:3px 0 0}
#settings-dialog .analytics-rank-value{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
#settings-dialog .analytics-model-row{margin:14px 0 0}
#settings-dialog .analytics-model-copy{display:flex;justify-content:space-between;gap:12px;font-size:11px;align-items:center}
#settings-dialog .analytics-model-name{display:flex;gap:6px;align-items:center;min-width:0;overflow-wrap:anywhere}
#settings-dialog .analytics-model-copy strong{font-size:11px;white-space:nowrap;font-weight:500;font-variant-numeric:tabular-nums}
#settings-dialog .analytics-model-track{height:5px;background:var(--bg);border-radius:9px;margin-top:8px;overflow:hidden}
#settings-dialog .analytics-model-track span{display:block;height:100%;border-radius:9px;background:var(--series)}
#settings-dialog .analytics-model-caption{font-size:10px;color:var(--muted);margin:5px 0 0}
#settings-dialog .analytics-momentum{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}
#settings-dialog .analytics-momentum-value{font-size:19px;font-weight:600;letter-spacing:-.5px;margin:0 0 4px}
#settings-dialog .analytics-momentum-label{font-size:10px;color:var(--muted)}
#settings-dialog .analytics-milestones{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px;padding-top:15px;border-top:1px solid var(--line)}
#settings-dialog .analytics-milestone{font-size:10px;padding:6px 9px;border:1px solid var(--line);border-radius:18px;color:var(--muted)}
#settings-dialog .analytics-milestone[data-earned=true]{background:var(--selected);color:var(--accent);border-color:transparent}
#settings-dialog .analytics-empty{padding:18px;border:1px dashed var(--line);border-radius:12px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6}
#settings-dialog .analytics-footnote{font-size:10px;color:var(--muted);margin:0;line-height:1.6}
#settings-dialog .analytics-loading{opacity:.65}
@media(max-width:900px){#settings-dialog .analytics-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}#settings-dialog .analytics-grid{grid-template-columns:1fr}#settings-dialog .analytics-hero{align-items:flex-start;flex-direction:column}#settings-dialog .analytics-controls{justify-content:flex-start}}
@media(max-width:580px){#settings-dialog.analytics-view{width:calc(100vw - 20px)}#settings-dialog .analytics-hero{padding:17px}#settings-dialog .analytics-hero h4{font-size:22px}#settings-dialog .analytics-kpis{gap:8px}#settings-dialog .analytics-kpi{padding:13px}#settings-dialog .analytics-kpi-value{font-size:25px}#settings-dialog .analytics-card{padding:14px}#settings-dialog .analytics{gap:12px}#settings-dialog .analytics-momentum{gap:8px}}
@media(prefers-reduced-motion:reduce){#settings-dialog .analytics *{transition:none!important}}
`;
 document.head.append(style);
 function dayBins(){
  const today=data?.today||new Date().toISOString().slice(0,10),map=new Map((data?.daily||[]).map(d=>[d.date,d.models]));
  const first=range==='all'?(data?.daily[0]?.date||today):new Date(new Date(today+'T12:00:00Z').getTime()-(Number(range)-1)*86400000).toISOString().slice(0,10);
  const length=Math.min(36600,Math.max(1,Math.round((Date.parse(today)-Date.parse(first))/86400000)+1)),size=Math.max(1,Math.ceil(length/90)),bins=[];
  for(let i=0;i<length;i+=size){const start=new Date(Date.parse(first)+i*86400000).toISOString().slice(0,10),end=new Date(Date.parse(first)+Math.min(length-1,i+size-1)*86400000).toISOString().slice(0,10),models=new Map();for(let j=i;j<Math.min(length,i+size);j++){const date=new Date(Date.parse(first)+j*86400000).toISOString().slice(0,10);for(const [id,t]of map.get(date)||[]){const sum=models.get(id)||emptyTotals();for(const k of Object.keys(sum))sum[k]+=t[k];models.set(id,sum);}}bins.push({start,end,models});}return bins;
 }
 function colorMap(){const map=new Map(),used=new Set();for(const [i,m]of (data?.models||[]).entries()){let hash=0;for(const c of m.id)hash=(hash*31+c.charCodeAt(0))>>>0;let n=hash%palette.length;while(used.has(n)&&used.size<palette.length)n=(n+1)%palette.length;used.add(n);map.set(m.id,palette[n]||palette[i%palette.length]);}return map;}
 function chart(key,title,copy,wide=false){
  const card=el('section',`analytics-card${wide?' analytics-wide':''}`);card.append(el('h4','',title),el('p','analytics-card-copy',copy));
  const chartWidth=wide?1040:520,wrap=el('div','analytics-chart'),image=svg('svg',{viewBox:`0 0 ${chartWidth} 200`,role:'img','aria-label':`${title} by model and effort`});wrap.append(image);
  const bins=dayBins(),visible=(data?.models||[]).filter(m=>!hiddenModels.has(m.id)),colors=colorMap();const sums=bins.map(b=>visible.reduce((s,m)=>s+(b.models.get(m.id)?.[key]||0),0));const rawMax=Math.max(...sums,1),max=key==='activeMs'?Math.max(rawMax,180000):Math.max(3,Math.ceil(rawMax/3)*3),width=chartWidth-64,height=142,left=43,top=8;
  for(let i=0;i<=3;i++){const y=top+height-i*height/3;image.append(svg('line',{x1:left,x2:chartWidth-9,y1:y,y2:y,class:'chart-grid'}));const text=svg('text',{x:left-8,y:y+3,'text-anchor':'end'});text.textContent=valueText(key,max*i/3);image.append(text);}
  const detail=el('p','analytics-chart-detail','Focus or hover a day to explore its totals.');detail.setAttribute('aria-live','polite');
  const groupWidth=width/bins.length,barWidth=Math.max(2,Math.min(36,groupWidth*.63));
  bins.forEach((bin,index)=>{const x=left+index*groupWidth+groupWidth/2-barWidth/2,g=svg('g',{tabindex:'0',role:'button','aria-label':`${bin.start}${bin.end!==bin.start?' to '+bin.end:''}: ${valueText(key,sums[index])} ${metricNames[key].toLowerCase()}`});let base=top+height;
   g.append(svg('rect',{x:x-3,y:top,width:barWidth+6,height:height+3,fill:'transparent',class:'chart-hit',rx:3}));
   for(const m of visible){const value=bin.models.get(m.id)?.[key]||0;if(!value)continue;const h=value/max*height;const rect=svg('rect',{x,y:base-h,width:barWidth,height:h,fill:colors.get(m.id),rx:Math.min(2,h/2)});const tip=svg('title');tip.textContent=`${bin.start} · ${fullModel(m)}: ${valueText(key,value)}`;rect.append(tip);g.append(rect);base-=h;}
   if(!sums[index])g.append(svg('rect',{x,y:top+height-2,width:barWidth,height:2,fill:'var(--line)',rx:1}));
   const show=()=>{detail.textContent=`${bin.start}${bin.end!==bin.start?' – '+bin.end:''} · ${valueText(key,sums[index])} ${metricNames[key].toLowerCase()}`;};g.addEventListener('pointerenter',show);g.addEventListener('focus',show);g.addEventListener('click',show);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();show();}});image.append(g);
   const every=Math.max(1,Math.ceil(bins.length/7));if(index%every===0||index===bins.length-1&&bins.length>1){const label=svg('text',{x:left+index*groupWidth+groupWidth/2,y:top+height+24,'text-anchor':'middle'});label.textContent=new Date(bin.start+'T12:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'});image.append(label);}
  });
  card.append(wrap,detail);const legend=el('div','analytics-legend');for(const m of data?.models||[]){const button=el('button','');button.type='button';button.setAttribute('aria-pressed',String(!hiddenModels.has(m.id)));button.dataset.analyticsFocus=`legend-${key}-${m.id}`;const dot=el('i','analytics-dot');dot.style.setProperty('--series',colors.get(m.id));button.append(dot,document.createTextNode(fullModel(m)));button.addEventListener('click',()=>{hiddenModels.has(m.id)?hiddenModels.delete(m.id):hiddenModels.add(m.id);render();});legend.append(button);}card.append(legend);return card;
 }
 function league(){
  const card=el('section','analytics-card');card.append(el('h4','','Conversation league'),el('p','analytics-card-copy','The conversations moving things forward in this period.'));
  const tabs=el('div','analytics-league-tabs');for(const [key,title]of Object.entries(metricNames)){const b=el('button','',title);b.type='button';b.setAttribute('aria-pressed',String(key===leaderMetric));b.dataset.analyticsFocus=`leader-${key}`;b.addEventListener('click',()=>{leaderMetric=key;render();});tabs.append(b);}card.append(tabs);
  const list=el('div','analytics-leaderboard');const rows=[...(data?.conversations||[])].filter(c=>c[leaderMetric]>0).sort((a,b)=>b[leaderMetric]-a[leaderMetric]||a.id.localeCompare(b.id)).slice(0,5),chats=new Map(getChats().map(c=>[c.id,c]));
  for(const [i,c]of rows.entries()){const meta=chats.get(c.id),row=el('div','analytics-rank'),copy=el('div','analytics-rank-copy');const b=el('button','analytics-chat-link',meta?.title||`Conversation ${c.id.slice(0,7)}`);b.type='button';b.title=meta?.title||c.id;b.addEventListener('click',()=>onOpenChat(c.id));copy.append(b,el('p','analytics-rank-project',meta?.workspace||'Conversation'));row.append(el('span','analytics-rank-number',i+1),copy,el('span','analytics-rank-value',valueText(leaderMetric,c[leaderMetric])));list.append(row);}
  if(!rows.length)list.append(el('div','analytics-empty','Your next conversation could take the lead.'));card.append(list);return card;
 }
 function mix(){const card=el('section','analytics-card');card.append(el('h4','','Model mix'),el('p','analytics-card-copy','Estimated active time, with turns and tools for context.'));const colors=colorMap(),rows=[...(data?.models||[])].sort((a,b)=>b.activeMs-a.activeMs||b.toolCalls-a.toolCalls),max=Math.max(1,...rows.map(m=>m.activeMs));
  for(const m of rows){const row=el('div','analytics-model-row'),copy=el('div','analytics-model-copy'),name=el('span','analytics-model-name'),dot=el('i','analytics-dot');row.style.setProperty('--series',colors.get(m.id));name.append(dot,document.createTextNode(fullModel(m)));copy.append(name,el('strong','',duration(m.activeMs)));const track=el('div','analytics-model-track'),bar=el('span','');bar.style.width=`${m.activeMs/max*100}%`;track.append(bar);row.append(copy,track,el('p','analytics-model-caption',`${count(m.turns)} turns · ${count(m.toolCalls)} tools`));card.append(row);}if(!rows.length)card.append(el('div','analytics-empty','Your model mix will appear with new activity.'));return card;}
 function render(){
  if(!root?.isConnected)return;const focused=document.activeElement?.dataset?.analyticsFocus;root.replaceChildren();root.classList.toggle('analytics-loading',loading&&!data);const d=data||sanitize(null),enabled=getEnabled();
  const hero=el('section','analytics-hero'),copy=el('div','');copy.append(el('p','analytics-eyebrow','Agent activity'),el('h4','',range==='all'?'The bigger picture':`The last ${range} days`),el('p','',d.since?`Collecting since ${new Date(d.since).toLocaleDateString()} · ${d.timezone}`:'A fresh start. New activity only.'));
  const controls=el('div','analytics-controls'),select=el('select','analytics-select');select.setAttribute('aria-label','Analytics date range');select.dataset.analyticsFocus='range';for(const [value,label]of [['7','Last 7 days'],['30','Last 30 days'],['90','Last 90 days'],['all','Lifetime']]){const option=el('option','',label);option.value=value;select.append(option);}select.value=range;select.addEventListener('change',()=>{range=select.value;data=rangeCache.get(range)||null;void load();});
  const toggle=el('button','',enabled?'Pause collection':'Resume collection');toggle.type='button';toggle.setAttribute('aria-label','Collect analytics');toggle.setAttribute('aria-pressed',String(enabled));toggle.addEventListener('click',()=>{setEnabled(!getEnabled());render();});
  const refresh=el('button','','↻');refresh.type='button';refresh.setAttribute('aria-label','Refresh analytics');refresh.disabled=loading;refresh.addEventListener('click',()=>void load());const state=el('span','analytics-status',enabled?'Collecting':'Paused');state.dataset.paused=String(!enabled);controls.append(state,select,toggle,refresh);hero.append(copy,controls);root.append(hero);
  const kpis=el('div','analytics-kpis');for(const [key,title]of [['turns','Confirmed turns'],['activeMs','Active time · estimated'],['toolCalls','Tool calls'],['goals','Goals completed']]){const card=el('div','analytics-kpi');const value=el('strong','analytics-kpi-value',valueText(key,d.totals[key]));value.title=key==='activeMs'?`${Math.round(d.totals[key]/1000)} seconds`:`${d.totals[key]}`;card.append(el('p','analytics-kpi-label',title),value,el('span','analytics-kpi-foot',`${valueText(key,d.lifetime[key])} lifetime`));kpis.append(card);}root.append(kpis);
  if(!d.totals.turns&&!d.totals.toolCalls&&!d.totals.goals)root.append(el('div','analytics-empty',loading?'Loading your activity…':'Your next turn starts the story. New turns, tools and completed goals will appear here. No history has been backfilled.'));
  const charts=el('div','analytics-grid');charts.append(chart('turns',range==='all'?'Turns over time':'Daily turns','Confirmed ChatGPT sends, stacked by model and effort.'),chart('activeMs','Time in motion','Estimated active time; waiting loops and long idle gaps excluded.'),chart('toolCalls',range==='all'?'Tool calls over time':'Daily tool calls','Agent work requests. Idle waits and interface polling are excluded.',true),league(),mix());root.append(charts);
  const momentum=el('section','analytics-card analytics-wide');momentum.append(el('h4','','Momentum'));const numbers=el('div','analytics-momentum');const daily=d.daily.map(day=>[...day.models.values()].reduce((s,t)=>s+t.turns,0));for(const [value,label]of [[`${d.streak} ${d.streak===1?'day':'days'}`,'Current streak'],[count(d.activeDays),'Active days in this period'],[count(Math.max(0,...daily)),'Best day · turns']]){const item=el('div','');item.append(el('p','analytics-momentum-value',value),el('span','analytics-momentum-label',label));numbers.append(item);}numbers.style.marginTop='16px';momentum.append(numbers);const milestones=el('div','analytics-milestones');for(const [key,target,label]of [['goals',1,'First goal'],['turns',10,'10 turns'],['toolCalls',100,'100 tools'],['toolCalls',1000,'1,000 tools']]){const earned=d.lifetime[key]>=target,badge=el('span','analytics-milestone',`${earned?'✓ ':''}${label}`);badge.dataset.earned=String(earned);badge.title=`${count(Math.min(d.lifetime[key],target))} / ${count(target)} lifetime`;milestones.append(badge);}momentum.append(milestones);root.append(momentum);
  root.append(el('p','analytics-footnote','Active time is a native-activity estimate, not internal reasoning time or billed usage. Parallel conversations add agent-hours. Days follow the server timezone. Local, best-effort collection never controls chat delivery or goals.'));
  if(cutoffCard)root.append(cutoffCard());
  if(focused)for(const node of root.querySelectorAll('[data-analytics-focus]'))if(node.dataset.analyticsFocus===focused){node.focus({preventScroll:true});break;}
 }
 async function load(){const epoch=++request;loading=true;render();try{const response=await api(`/api/analytics/usage?days=${range}`);const value=await response.json();if(epoch!==request)return;data=sanitize(value);mountedRange=range;rangeCache.set(range,data);}catch{/* Optional analytics remains silent and preserves the last successful view. */}finally{if(epoch===request){loading=false;render();}}}
 const timer=setInterval(()=>{if(isVisible()&&!document.hidden&&!loading)void load();},30000);
 window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
 return {mount(parent){root=el('div','analytics');root.id='usage-analytics';parent.append(root);render();if(!data||mountedRange!==range)void load();}};
}
