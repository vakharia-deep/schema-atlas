import { comparePlans } from './plan.js';
import { importSlowLogFile } from './slow-logs.js';
const $=id=>document.getElementById(id);
const fmt=(n,unit='')=>n==null?'—':Number(n).toLocaleString(undefined,{maximumFractionDigits:2})+(unit?' '+unit:'');
const time=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleTimeString():value||'Time unavailable';};
const integer=value=>value==null?'—':/^\d{1,20}$/.test(String(value))?BigInt(value).toLocaleString():'—';
const bytes=value=>{if(value==null)return '—';const n=Number(value);if(n<1024)return `${n} B`;const exponent=Math.min(4,Math.floor(Math.log(n)/Math.log(1024)));return `${(n/1024**exponent).toFixed(1)} ${['B','KB','MB','GB','TB'][exponent]}`;};
const sections={capture:'Capture',plan:'Plan inspector',indexes:'Index usage',logs:'Slow-query logs',compare:'Compare',setup:'Setup'};
export function createProfilingWorkspace({el,getSession,canRun,onBusy,notify,onInspect,onConnect}){
  const root=$('profiling-workspace'),states=new Map();let model=null,active=null,tab='capture',busy=false,operation=null,shown=false;
  const make=()=>({diagnostics:null,startedAt:null,capture:null,plans:[],selected:null,sql:'',parameters:'[]',baseline:null,indexUsage:null,logs:null,importedQuery:null});
  const b=(text,fn,primary=false)=>el('button',{class:'button '+(primary?'primary':'subtle'),onclick:fn},text);
  const text=(tag,value,cls='')=>el(tag,{class:cls},value);
  const card=(title,...children)=>el('section',{class:'profile-card'},text('h3',title),...children);
  const note=message=>text('p',message,'profile-note');
  const source=p=>p.source==='application'?(p.measured?'Captured application execution':'Captured application plan'):p.source==='measured'?'Measured now':'Estimated now';
  root.append(el('nav',{class:'profile-tabs','aria-label':'Profiling sections'},...Object.entries(sections).map(([key,label])=>b(label,()=>switchTab(key)))),
    el('div',{id:'profile-status',class:'profile-status',role:'status','aria-live':'polite'}),
    el('div',{id:'profile-error',class:'error',role:'alert',hidden:true}),el('div',{id:'profile-content'}));
  async function request(action,input){
    if(busy||!canRun())throw new Error('Wait for the current operation to finish.');
    if(!model?.capabilities.query)throw new Error('Connect a PostgreSQL database first.');
    busy=true;onBusy(true);operation=crypto.randomUUID().replaceAll('-','');renderControls();
    $('profile-error').hidden=true;
    const cancel=b('Cancel operation',()=>fetch(`/api/connections/${model.repository.id}/queries/${operation}/cancel`,{method:'POST',headers:{'X-Atlas-CSRF':getSession().csrf}}).catch(()=>{}));
    $('profile-status').replaceChildren(text('span','Working…'),cancel);
    try{
      const res=await fetch(`/api/connections/${model.repository.id}/profiling/${operation}/${action}`,{method:'POST',headers:{'X-Atlas-CSRF':getSession().csrf,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});
      const data=await res.json();if(!res.ok)throw new Error(data.error||'Profiling could not complete.');return data;
    }finally{busy=false;operation=null;onBusy(false);$('profile-status').replaceChildren();renderControls();}
  }
  function fail(error){$('profile-error').textContent=error.message;$('profile-error').hidden=false;}
  function safe(fn){return async()=>{try{await fn();}catch(e){fail(e);}};}
  function renderControls(){root.querySelectorAll('button,input,textarea,select').forEach(n=>{n.disabled=busy||!active;});}
  function switchTab(next){if(busy)return;rememberEditor();tab=next;render();root.scrollTop=0;if(next==='setup'&&!active?.diagnostics&&active)void diagnose();if(next==='indexes'&&!active?.indexUsage&&active)void loadIndexes();}
  function rememberEditor(){if(active&&$('profile-sql')){if(active.sql!==$('profile-sql').value)active.importedQuery=null;active.sql=$('profile-sql').value;active.parameters=$('profile-parameters').value;}}
  async function diagnose(){try{active.diagnostics=await request('diagnostics');active.startedAt=active.diagnostics.activeCapture?.startedAt||null;render();}catch(e){fail(e);}}
  function addPlan(p){active.importedQuery=null;active.plans.unshift(p);if(active.plans.length>8){const index=active.plans.findLastIndex(v=>v.id!==active.baseline);active.plans.splice(index,1);}active.selected=p.id;}
  async function loadIndexes(){try{active.indexUsage=await request('indexes');render();}catch(e){fail(e);}}
  function indexUsageView(){
    const result=active.indexUsage;
    const area=el('div',{},card('Index usage without extensions',note('Read PostgreSQL’s built-in table and index counters. No pg_stat_statements, plan logging or restart is required.'),b('Refresh index usage',loadIndexes,true)));
    if(!result){area.append(note('Load index usage to inspect the current counters.'));return area;}
    area.append(note(`Updated ${time(result.scannedAt)} · Database statistics reset: ${result.statsReset||'not reported'} · Server started: ${result.serverStartedAt||'not reported'}`),
      note('Cumulative counters can lag, survive clean restarts, or be reset for individual objects. They do not identify which query used an index. No scans recorded is not a recommendation to drop an index; consider constraints, rare workloads and replica activity.'));
    for(const warning of result.warnings)area.append(text('p',warning,'profile-callout'));
    const search=el('input',{type:'search','aria-label':'Filter index usage',placeholder:'Find a schema, table or index…',maxlength:150});
    const filter=el('select',{'aria-label':'Index usage filter'},el('option',{value:'all'},'All indexes'),el('option',{value:'zero'},'No scans recorded'),el('option',{value:'used'},'Scans recorded'),el('option',{value:'invalid'},'Invalid / not ready'));
    const sort=el('select',{'aria-label':'Sort index usage'},el('option',{value:'bytes'},'Largest indexes first'),el('option',{value:'scans'},'Most scans first'),el('option',{value:'name'},'Index name'));
    const grid=el('div',{class:'profile-table-wrap'}),tableGrid=el('div',{class:'profile-table-wrap'}),count=note('');
    const draw=()=>{
      const q=search.value.toLowerCase();
      const indexes=result.indexes.filter(i=>(i.schema+'.'+i.table+' '+i.name).toLowerCase().includes(q)&&(filter.value==='all'||filter.value==='zero'&&result.tracking&&i.scans==='0'||filter.value==='used'&&result.tracking&&Number(i.scans)>0||filter.value==='invalid'&&(!i.valid||!i.ready)));
      indexes.sort((a,c)=>{if(sort.value==='name')return a.name.localeCompare(c.name);const x=BigInt(a[sort.value]||0),y=BigInt(c[sort.value]||0);return x>y?-1:x<y?1:a.name.localeCompare(c.name);});
      count.textContent=`${indexes.length} of ${result.indexes.length} indexes in this snapshot`;
      grid.replaceChildren(table(['Table / index','Size','Index scans','Entries read','Rows fetched','Last scan','Status'],indexes.map(i=>[
        el('div',{},b(i.schema+'.'+i.table,()=>indexTable(i.schema,i.table)),text('code',i.name),text('small',[i.primary?'Primary key':null,i.unique?'Unique':null,i.exclusion?'Exclusion constraint':null].filter(Boolean).join(' · '))),
        bytes(i.bytes),integer(i.scans),integer(i.entriesRead),integer(i.rowsFetched),i.lastScan||'Unavailable',!i.valid?'Invalid':!i.ready?'Not ready':!result.tracking?'Tracking disabled':i.scans==='0'?'No scans recorded':'Scans recorded',
      ])));
      if(!indexes.length)grid.append(note('No indexes match these filters.'));
      const tables=result.tables.filter(t=>(t.schema+'.'+t.name).toLowerCase().includes(q)).sort((a,c)=>Number(c.sequentialScans)-Number(a.sequentialScans));
      tableGrid.replaceChildren(table(['Table','Sequential scans','Rows read sequentially','Index scans','Est. live rows'],tables.map(t=>[b(t.schema+'.'+t.name,()=>indexTable(t.schema,t.name)),integer(t.sequentialScans),integer(t.sequentialRows),integer(t.indexScans),integer(t.estimatedRows)])));
      if(!tables.length)tableGrid.append(note('No tables match this search.'));
    };
    for(const control of [search,filter,sort])control.addEventListener('input',draw);
    area.append(card('Indexes',el('div',{class:'profile-actions'},search,filter,sort),count,grid,note('Rows fetched counts heap fetches from simple index scans; bitmap and index-only scans can make it much lower than entries read. Last scan requires PostgreSQL 16+. Partitioned parent indexes have no physical scans; inspect the child indexes.')),
      card('Table access',note('Tables are ordered by sequential scans. A sequential scan can be the right choice for small tables or queries reading many rows. These are scan counts, not query counts.'),tableGrid));draw();return area;
  }
  function indexTable(schema,name){const t=model.tables.find(t=>t.prefix===schema&&t.name===name);if(t)onInspect(t.id);else notify('This table is absent from the schema snapshot. Refresh schema first.');}
  function slowLogsView(){
    const picker=el('input',{type:'file',accept:'.json,.jsonl,.ndjson,.log,.txt','aria-label':'Import PostgreSQL slow-query log'});
    picker.addEventListener('change',safe(async()=>{
      const file=picker.files[0];if(!file)return;const owner=active;
      busy=true;onBusy(true);renderControls();$('profile-error').hidden=true;$('profile-status').textContent='Reading log in this browser…';
      try{const result=await importSlowLogFile(file,model.database.name);if(active===owner)owner.logs={...result,name:file.name.slice(0,200)};}
      finally{busy=false;onBusy(false);$('profile-status').replaceChildren();render();}
    }));
    const area=el('div',{},card('Inspect existing slow-query logs',note('Import PostgreSQL JSON-lines or plain-text logs up to 2 MB. Files are parsed locally and are never uploaded. Imported records stay in this tab’s memory until cleared, reloaded or disconnected.'),picker,
      note('Needs duration records containing statement: or execute …: SQL, usually from log_min_duration_statement. Logging thresholds and sampling limit what appears here. Ordinary slow logs do not prove index usage.')));
    const result=active.logs;if(!result)return area;
    area.append(el('div',{class:'profile-actions'},note(`${result.name} · ${result.rows.length} recorded ${result.rows.length===1?'execution':'executions'}`),b('Clear imported logs',()=>{active.logs=null;if(active.importedQuery){active.sql='';active.parameters='[]';active.importedQuery=null;}$('profile-error').hidden=true;render();})));
    for(const warning of result.warnings)area.append(text('p',warning,'profile-callout'));
    if(!result.rows.length){area.append(note('No supported executions for this database were found. Use raw PostgreSQL JSON-lines or stderr text with duration and SQL in the same record. CSV, provider wrappers and separate statement/duration records are not supported.'));return area;}
    const search=el('input',{type:'search','aria-label':'Filter imported SQL',placeholder:'Find SQL, application or role…',maxlength:150});
    const minimum=el('input',{type:'number',min:0,step:'any',value:0,'aria-label':'Minimum logged duration in milliseconds'});
    const sort=el('select',{'aria-label':'Sort slow queries'},el('option',{value:'duration'},'Slowest first'),el('option',{value:'time'},'Latest timestamp first'));
    const grid=el('div',{class:'profile-table-wrap'}),status=note('');let page=0;
    const previous=b('Previous',()=>{page--;draw();}),next=b('Next',()=>{page++;draw();});
    function draw(){
      const term=search.value.toLowerCase(),threshold=Math.max(0,Number(minimum.value)||0);
      const rows=result.rows.filter(r=>r.durationMs>=threshold&&(r.sql+' '+r.application+' '+r.user).toLowerCase().includes(term));
      rows.sort((a,c)=>sort.value==='time'?(Date.parse(c.timestamp)||0)-(Date.parse(a.timestamp)||0):c.durationMs-a.durationMs);
      page=Math.max(0,Math.min(page,Math.ceil(rows.length/50)-1));
      grid.replaceChildren(table(['SQL','Logged duration','Recorded at','Source',''],rows.slice(page*50,page*50+50).map(r=>[
        text('code',r.sql),fmt(r.durationMs,'ms'),r.timestamp||'Unavailable',el('div',{},text('span',r.database||'Database unverified'),text('small',[r.application,r.user].filter(Boolean).join(' · ')||'Role / application unavailable')),
        b('Review in profiler',()=>{active.sql=r.sql;active.parameters='[]';active.selected=null;active.importedQuery={durationMs:r.durationMs,database:r.database};tab='plan';render();root.scrollTop=0;}),
      ])));
      if(!rows.length)grid.append(note('No executions match these filters.'));
      status.textContent=`${rows.length} matching executions · Page ${page+1} of ${Math.max(1,Math.ceil(rows.length/50))}`;
      previous.disabled=page===0;next.disabled=(page+1)*50>=rows.length;
    }
    for(const control of [search,minimum,sort])control.addEventListener('input',()=>{page=0;draw();});
    area.append(card('Recorded executions',el('div',{class:'profile-actions'},search,el('label',{},'Minimum duration (ms)',minimum),sort),grid,el('div',{class:'profile-actions'},previous,status,next),note('Review copies the SQL into Plan inspector without running it. Check the database, schema and parameter values before explaining. A newly generated plan can differ from the original application execution.')));
    queueMicrotask(draw);return area;
  }
  function captureView(){
    const d=active.diagnostics,controls=el('div',{class:'profile-actions'});
    controls.append(b(active.startedAt?'Stop profiling':'Start profiling',safe(async()=>{
      if(active.startedAt){active.capture=await request('stop');active.startedAt=null;for(const p of active.capture.plans.slice(0,8).reverse())addPlan(p);}
      else {const r=await request('start');active.startedAt=r.startedAt;active.capture=null;}
      render();
    }),true));
    if(active.startedAt)controls.append(b('Discard session',safe(async()=>{await request('discard');active.startedAt=null;render();})));
    const area=el('div',{},card('Profile a workflow',note(active.startedAt?`Capturing since ${new Date(active.startedAt).toLocaleTimeString()}. Perform the action in your app, then stop. Maximum 30 minutes.`:'Start a capture, use your application, then stop to see the database activity during that window.'),controls,
      note('Includes other activity in the selected database. Query patterns are aggregates, not a timeline of individual requests.')));
    if(d?.applicationPlans.available)area.append(note('Start and stop select the measurement window. PostgreSQL plan logging continues until disabled in database settings.'));
    if(d&&!d.statistics.available||d&&!d.applicationPlans.available)area.append(el('div',{class:'profile-callout'},text('strong','Some capture capabilities need setup'),note(d.statistics.available?'Query patterns are available. Application index usage needs captured plans.':'Query statistics are not enabled for this database.'),b('Open setup',()=>switchTab('setup'))));
    const result=active.capture;if(!result)return area;
    area.append(text('p',`${new Date(result.startedAt).toLocaleTimeString()} – ${new Date(result.endedAt).toLocaleTimeString()} · ${result.rows.length} query patterns · ${result.plans.length} captured plans`,'profile-note'));
    for(const w of result.warnings)area.append(text('p',w,'profile-callout'));
    const toolbar=el('div',{class:'profile-actions'},el('input',{id:'profile-filter',type:'search',placeholder:'Find SQL or database user…','aria-label':'Filter captured queries',maxlength:150}),el('select',{id:'profile-sort','aria-label':'Sort captured queries'},el('option',{value:'totalMs'},'Total execution time'),el('option',{value:'calls'},'Execution count'),el('option',{value:'meanMs'},'Average execution time'),el('option',{value:'reads'},'Shared blocks read')));
    const grid=el('div',{class:'profile-table-wrap'}),queryCard=card('Query patterns',toolbar,grid),planList=el('div',{});
    const draw=()=>{
      const term=$('profile-filter')?.value.toLowerCase()||'',key=$('profile-sort')?.value||'totalMs';
      const rows=result.rows.filter(r=>(r.sql+' '+r.user).toLowerCase().includes(term)).sort((a,b)=>b[key]-a[key]);
      grid.replaceChildren(table(['Query pattern / role','Calls','Total','Average','Rows','Buffer hits','Blocks read',''],rows.map(r=>[
        el('div',{},text('code',r.sql),text('small',r.user+(r.sqlTruncated?' · SQL truncated at 2,000 characters':''))),fmt(r.calls),fmt(r.totalMs,'ms'),fmt(r.meanMs,'ms'),fmt(r.rows),fmt(r.hits),fmt(r.reads),r.sqlTruncated?text('small','Paste the complete SQL in Plan inspector'):b('Inspect',()=>{active.importedQuery=null;active.sql=r.sql;active.parameters='[]';tab='plan';render();})])));
      if(!rows.length)grid.append(note('No matching query patterns. Try a longer workflow and check Setup.'));
      const matchingPlans=result.plans.filter(p=>(p.sql+' '+p.user+' '+p.application).toLowerCase().includes(term));
      planList.replaceChildren(...matchingPlans.map(p=>el('div',{class:'profile-captured'},el('div',{},text('strong',`${p.application} · ${fmt(p.executionMs,'ms')}`),text('code',p.sql.slice(0,350)),note(`${p.measured?'Executed indexes':'Selected indexes'}: ${p.indexes.join(', ')||'None'}`)),b('View captured plan',()=>{if(!active.plans.some(x=>x.id===p.id))addPlan(p);active.selected=p.id;tab='plan';render();root.scrollTop=0;}))));
      if(!matchingPlans.length)planList.append(note(result.plans.length?'No application plans match this filter.':'No application plans were captured. Check the logging threshold, reconnect your app after setup, and reproduce the action.'));
    };toolbar.addEventListener('input',draw);toolbar.addEventListener('change',draw);area.append(queryCard);
    const plans=card('Captured application plans',note('These plans came from application sessions. Selecting one does not re-run its SQL.'),planList);
    area.append(plans);queueMicrotask(draw);return area;
  }
  function table(head,rows){return el('table',{class:'profile-table'},el('thead',{},el('tr',{},...head.map(h=>el('th',{},h)))),el('tbody',{},...rows.map(row=>el('tr',{},...row.map(v=>el('td',{},v))))));}
  function editor(){
    const sql=el('textarea',{id:'profile-sql','aria-label':'SQL to profile',spellcheck:'false',maxlength:31000,rows:5,placeholder:'SELECT … WHERE id = $1'});sql.value=active.sql;
    const params=el('textarea',{id:'profile-parameters','aria-label':'Profile parameter values',rows:1,maxlength:16000,spellcheck:'false'});params.value=active.parameters;
    const run=analyze=>safe(async()=>{rememberEditor();let parameters;try{parameters=JSON.parse(active.parameters);}catch{throw new Error('Enter parameters as a JSON array, for example [42, "active"].');}
      const p=await request('explain',{sql:active.sql,parameters,analyze,timeout:Number($('profile-timeout').value)});addPlan(p);render();});
    return card('Explain a query',active.importedQuery?note(`Imported execution: ${fmt(active.importedQuery.durationMs,'ms')} in the log. ${active.importedQuery.database?'Database: '+active.importedQuery.database+'.':'Database could not be verified from this record.'} Review SQL and supply any $1, $2 parameters yourself. No query has been run by the import.`):null,el('label',{for:'profile-sql'},'SQL'),sql,el('div',{class:'profile-parameter-row'},el('label',{},'Parameter values as a JSON array ($1, $2, …)',params),el('label',{},'Timeout',el('select',{id:'profile-timeout','aria-label':'Profiling timeout'},el('option',{value:'5000'},'5 seconds'),el('option',{value:'15000',selected:true},'15 seconds'),el('option',{value:'20000'},'20 seconds')))),
      el('div',{class:'profile-actions'},b('Explain only',run(false)),b('Run & profile',run(true),true)),note('Explain only plans the statement. Run & profile executes it in a read-only transaction. Use representative parameter values; a new plan may differ from a previous application execution.'));
  }
  function planView(){
    const p=active.plans.find(p=>p.id===active.selected),area=el('div',{},p?.source==='application'?el('details',{class:'profile-editor-fold'},el('summary',{},'Profile another query'),editor()):editor());
    if(active.plans.length){const select=el('select',{'aria-label':'Plan history'},...active.plans.map(p=>el('option',{value:p.id},`${source(p)} · ${time(p.capturedAt)} · ${p.sql.slice(0,80)}`)));select.value=active.selected;select.addEventListener('change',()=>{rememberEditor();active.selected=select.value;render();});area.append(el('div',{class:'profile-history'},text('label','Plans in this tab'),select));}
    if(!p){area.append(card('Your execution plan will appear here',note('Explain a query above, or select a captured application plan.')));return area;}
    area.append(el('div',{class:'profile-plan-heading'},el('div',{},text('span',source(p),'profile-badge'),text('h3',p.measured?'What happened in this execution':'What PostgreSQL plans to do')),b(active.baseline===p.id?'Baseline saved':'Save as baseline',()=>{active.baseline=p.id;notify('Baseline saved in this browser tab.');render();})));
    area.append(el('details',{class:'profile-card'},el('summary',{},'Statement for this plan'),text('pre',p.sql),note('Parameters: '+(p.parameters?JSON.stringify(p.parameters):'Not recorded by application plan logging'))));
    area.append(el('div',{class:'profile-metrics'},...[
      ['Execution',fmt(p.executionMs,'ms')],['Planning',fmt(p.planningMs,'ms')],['Shared buffer hits',fmt(p.plan.hits)],['Shared blocks read',fmt(p.plan.reads)],['Output rows / loop',fmt(p.plan.actualRows)],['Temporary blocks written',fmt(p.plan.tempWritten)]
    ].map(([k,v])=>el('div',{},text('small',k),text('strong',v)))));
    area.append(note(`${p.measured?'Indexes in executed nodes':'Indexes selected'}: ${p.indexes.join(', ')||'None'}. A sequential scan can be appropriate, especially on small development tables.`));
    if(p.findings.length)area.append(card('Worth investigating',...p.findings.map(f=>text('p',f.text,'profile-finding'))));
    area.append(el('div',{class:'profile-plan-grid'},card('Execution tree',note('Node times include their children and are per-loop averages. Do not add them together. “—” means unavailable.'),planNode(p.plan,0)),el('aside',{id:'profile-index-context',class:'profile-card'},text('h3','Table & index context'),note('Choose “Inspect table / index” on a plan node to see its definitions.'))));
    if(p.settings.length)area.append(el('details',{class:'profile-card'},el('summary',{},'Non-default planner settings'),table(['Setting','Value'],p.settings.map(s=>[s.name,s.value]))));
    return area;
  }
  function planNode(n,depth){
    const item=el('details',{class:'profile-node',...(depth<3?{open:true}:{})},el('summary',{},text('strong',n.type),text('span',[n.schema&&n.relation?n.schema+'.'+n.relation:n.relation,n.index&&'via '+n.index,n.loops===0?'Not executed':null].filter(Boolean).join(' · '))));
    item.append(text('p',`Rows: ${fmt(n.actualRows)} actual / ${fmt(n.estimatedRows)} estimated · Loops: ${fmt(n.loops)} · Inclusive time per loop: ${fmt(n.totalTime,'ms')}`,'profile-node-metrics'));
    for(const c of n.conditions)item.append(el('div',{class:'profile-condition'},text('small',c.label),text('code',c.text)));
    if(n.relation||n.index)item.append(b('Inspect table / index',()=>indexContext(n)));
    if(n.removed!==null)item.append(note(`Rows removed by filter per loop: ${fmt(n.removed)}`));
    if(n.heapFetches!==null)item.append(note(`Heap fetches: ${fmt(n.heapFetches)}`));
    if(n.sortMethod)item.append(note(`Sort: ${n.sortMethod} · ${n.sortSpace||'space unavailable'}`));
    for(const c of n.children)item.append(planNode(c,depth+1));return item;
  }
  function indexContext(n){
    const panel=$('profile-index-context'),matches=(model?.tables||[]).filter(t=>n.relation?t.name===n.relation&&(!n.schema||t.prefix===n.schema):t.indexes.some(i=>i.name===n.index));
    panel.replaceChildren(text('h3','Table & index context'));
    if(!matches.length){panel.append(note('This relation is absent from the current schema snapshot. Refresh schema in the explorer.'));return;}
    for(const t of matches){panel.append(text('h4',`${t.prefix}.${t.name}`),b('Open full table metadata',()=>onInspect(t.id)),note('Existing indexes below are metadata, not automatic recommendations. The plan identifies which index was selected.'));
      for(const i of t.indexes)panel.append(el('details',{class:'profile-index',...(i.name===n.index?{open:true}:{})},el('summary',{},`${i.name}${i.name===n.index?' · In this plan':''}`),text('pre',i.definition||JSON.stringify(i.columns)),note(`Valid: ${i.options?.valid??'unknown'} · Primary: ${i.primary??false} · Unique: ${i.unique??false}`)));
      if(!t.indexes.length)panel.append(note('No indexes in this schema snapshot.'));
    }
  }
  function compareView(){
    const area=card('Compare two plans',note('Use the same data, parameter values and planner settings for a meaningful comparison. Repeat measured runs: cache warming and background activity can change timing. Up to eight plans are retained in this browser tab.'));
    if(active.plans.length<2){area.append(note('Profile a query and save it as a baseline. Change your query or create an index through your normal workflow, then profile again.'));return area;}
    const selector=label=>el('select',{'aria-label':label},...active.plans.map(p=>el('option',{value:p.id},`${source(p)} · ${p.sql.slice(0,70)} · ${fmt(p.executionMs,'ms')}`)));
    const a=selector('Baseline plan'),c=selector('Comparison plan');a.value=active.baseline||active.plans[1].id;c.value=active.plans[0].id;
    const output=el('div',{});area.append(el('div',{class:'profile-compare-selectors'},el('label',{},'Baseline',a),el('label',{},'Comparison',c)),output);
    const draw=()=>{
      const x=active.plans.find(p=>p.id===a.value),y=active.plans.find(p=>p.id===c.value);output.replaceChildren();
      if(x.id===y.id){output.append(note('Choose two different plans.'));return;}
      if(!x.measured||!y.measured)output.append(text('p','At least one plan is estimated. Actual execution metrics are unavailable for that plan.','profile-callout'));
      if(x.sql!==y.sql||JSON.stringify(x.parameters)!==JSON.stringify(y.parameters))output.append(note('SQL or supplied parameter values differ. Inspect both contexts below before attributing a change to an index.'));
      if((x.source==='application')!==(y.source==='application'))output.append(note('Application capture and manual EXPLAIN can use different instrumentation. Timing differences are indicative; compare buffer activity and row counts too.'));
      output.append(table(['Metric','Baseline','Comparison','Change'],comparePlans(x,y).map(m=>[m.label,fmt(m.a,m.unit),fmt(m.b,m.unit),m.delta===null?'—':`${m.delta>0?'+':''}${fmt(m.delta,m.unit)}${m.percent===null?'':` (${m.percent>0?'+':''}${fmt(m.percent)}%)`}`])),el('div',{class:'profile-compare-selectors'},...[[x,'Baseline'],[y,'Comparison']].map(([p,label])=>card(label,text('span',source(p),'profile-badge'),text('pre',p.sql),note('Parameters: '+(p.parameters?JSON.stringify(p.parameters):'Not recorded')),note('Indexes: '+(p.indexes.join(', ')||'None')),table(['Scan','Relation','Index'],p.scans.map(s=>[s.type+(s.loops===0?' (not executed)':''),[s.schema,s.relation].filter(Boolean).join('.')||'—',s.index||'—']))))));
    };a.addEventListener('change',draw);c.addEventListener('change',draw);draw();return area;
  }
  function setupView(){
    const d=active.diagnostics,area=el('div',{},card('Profiling readiness',note('Checks only. This page never changes PostgreSQL configuration.'),b('Check setup',safe(diagnose))));
    if(!d){area.append(note('Checking capabilities…'));return area;}
    area.append(el('div',{class:'profile-readiness'},...[
      ['Manual EXPLAIN',true,'Available with the selected database role. Measured profiling runs read-only statements.'],
      ['Query patterns',d.statistics.available,d.statistics.message],
      ['Application plans',d.applicationPlans.available,d.applicationPlans.message]
    ].map(([label,ready,message])=>card(label,text('span',ready?'Ready':'Setup needed',ready?'profile-badge':'profile-badge pending'),note(message)))));
    area.append(note(`${d.database} · PostgreSQL ${d.version} · ${d.allUsers?'All database roles visible':'Only your database role is visible'}`),
      card('1. Query statistics',note('Add pg_stat_statements to shared_preload_libraries while preserving existing entries, then restart your local PostgreSQL server. Install the extension in the selected database:'),text('pre','CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'),note('Statistics are collected from this point onward. Enabling the preload library requires a server restart.')),
      card('2. Application execution plans',note('For PostgreSQL 15+, enable logging_collector and include jsonlog in log_destination. Load auto_explain for your application’s sessions. Apply session_preload_libraries and auto_explain settings at database or role level to scope logging to one development database. Example settings:'),text('pre',"logging_collector = on\nlog_destination = 'stderr,jsonlog'\nsession_preload_libraries = 'auto_explain'\nauto_explain.log_min_duration = '0ms'\nauto_explain.log_format = 'json'\nauto_explain.log_analyze = on\nauto_explain.log_buffers = on\nauto_explain.log_timing = off\nauto_explain.log_parameter_max_length = 0"),note('Use 0ms only for short local investigations; it logs every eligible statement and can grow logs quickly. Set auto_explain.log_min_duration to -1 and reconnect your app to stop plan logging. Stopping a browser capture only selects its measurement window. Restart for the collector and reconnect your application for session settings. With timing off, row counts and buffers are measured but per-node times are unavailable.'),note('Automatic log reading needs superuser or pg_read_server_files permissions. SQL and plans can contain literal values; keep database logs private. This tool reads only the selected database’s records from the active JSON log, up to 512 KB per capture.')),
      card('What the measurements mean',note('A capture is a before/after statistics difference, not a list of every execution. Background activity contributes. Resets, evictions and log rotation are reported. No P95 or per-query CPU / total-memory claim is made from aggregate counters.'),note('Results, SQL and baselines stay in this tab’s memory and clear on reload or disconnect. Capturing does not reset PostgreSQL counters or alter your schema.')));
    return area;
  }
  function render(){
    const tabs=root.querySelectorAll('.profile-tabs button');tabs.forEach((n,i)=>{const selected=Object.keys(sections)[i]===tab;n.classList.toggle('active',selected);n.setAttribute('aria-pressed',String(selected));});
    $('profile-content').replaceChildren(active?({capture:captureView,plan:planView,indexes:indexUsageView,logs:slowLogsView,compare:compareView,setup:setupView}[tab])():card('Connect a database to start profiling',note('Use your saved connection or connect a local PostgreSQL database.'),b('Connect PostgreSQL',onConnect,true)));
    renderControls();if(!active)root.querySelectorAll('button').forEach(n=>{if(/Connect/.test(n.textContent))n.disabled=false;});
  }
  return {
    setConnection(next){rememberEditor();model=next?.capabilities.query?next:null;const id=model?.repository.id;if(!id){states.clear();active=null;}else{if(!states.has(id))states.set(id,make());active=states.get(id);}render();queueMicrotask(()=>{if(shown&&active&&!active.diagnostics&&canRun())void diagnose();});},
    open(){shown=true;render();if(active&&!active.diagnostics&&canRun())void diagnose();},
    hide(){rememberEditor();shown=false;}
  };
}
