import { createQueryWorkspace } from './query.js';
import { createProfilingWorkspace } from './profiling.js';
import { overviewColumns, overviewRows } from './overview.js';
const $ = id => document.getElementById(id);
const state = { model:null, session:null, selected:null, tab:'columns', view:'graph', positions:new Map(), zoom:1, originX:60, originY:60, query:'', busy:false, sqlBusy:false, screen:'schema', fullscreen:false, overviewSort:{column:'name',direction:'ascending'} };
const CARD_WIDTH=280, GRAPH_PADDING=90;
const NS = 'http://www.w3.org/2000/svg';
// Metadata is always rendered as text; database values never become HTML or script.
function el(tag, props={}, ...children) {
  const n=document.createElement(tag);
  for(const [key,value]of Object.entries(props)) {
    if(key==='class')n.className=value;
    else if(key==='text')n.textContent=value;
    else if(key.startsWith('on'))n.addEventListener(key.slice(2),value);
    else if(value!=null)n.setAttribute(key,String(value));
  }
  for(const child of children.flat())if(child!=null)n.append(typeof child==='string'?document.createTextNode(child):child);
  return n;
}
const button=(label,fn,cls='')=>el('button',{class:cls,onclick:fn},label);
const clear=n=>n.replaceChildren();
const fmt=v=>v==null?'Not declared':typeof v==='object'?JSON.stringify(v):String(v);
const shortType=v=>(v||'unknown').replace('timestamp without time zone','timestamp').replace('timestamp with time zone','timestamptz');
const current=()=>state.model?.tables.find(t=>t.id===state.selected);
function notify(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('toast').hidden=true,3500);}
function sourceLine(){return el('div',{class:'source-ref'},'PostgreSQL catalog');}
function sectionTitle(title,count){return el('div',{class:'section-title'},title,count!=null?el('span',{class:'count'},String(count)):null);}
function note(message){return el('p',{class:'muted-note'},message);}
function infoGrid(values){const grid=el('dl',{class:'details-grid'});for(const [k,v]of values)grid.append(el('dt',{},k),el('dd',{},fmt(v)));return grid;}
const isLive=()=>state.model?.capabilities.provider==='postgres';
const partitionStrategy=t=>t.partitions.find(p=>p.type==='strategy');
const partitionChildren=t=>t.partitions.filter(p=>p.type==='child');
function objectKind(t){return partitionStrategy(t)?'Partitioned table':t.partitionOf?'Partition':t.kind||'Table';}
function partitionLabel(t){const p=partitionStrategy(t);return p?`Partitioned · ${p.strategy||'unknown'}`:t.partitionOf?'Partition':t.kind||'Table';}
function partitionStatus(t){return partitionStrategy(t)?'Yes':/view|foreign/.test(t.kind)?'Not applicable':'No';}
function humanBytes(v){if(v==null)return 'Unavailable';const n=Number(v);if(n<1024)return `${n} B`;const e=Math.min(4,Math.floor(Math.log(n)/Math.log(1024)));return `${(n/1024**e).toFixed(1)} ${['B','KB','MB','GB','TB'][e]}`;}
function sqlDefinition(text){return el('details',{class:'definition-details'},el('summary',{},'SQL definition'),el('pre',{},text));}
function updateConnectionState(data){
  for(const key of ['connections','savedConnections','selectedProfileId','storage'])if(Object.hasOwn(data,key))state.session[key]=data[key];
}
function connectionInventory(){
  const saved=state.session?.savedConnections||[],ids=new Set(saved.map(p=>p.id));
  return [...saved,...(state.session?.connections||[]).filter(p=>!ids.has(p.profileId))];
}
function connectionChoice(id){
  const live=state.session?.connections.find(c=>c.id===id);
  return live?.profileId&&(state.session.savedConnections||[]).some(p=>p.id===live.profileId)?live.profileId:id;
}
function renderConnections(selected){
  const choice=connectionChoice(selected??state.model?.repository.id??''),all=connectionInventory();clear($('repository'));
  $('repository').append(el('option',{value:''},all.length?'Choose a connection…':'No database connected'));
  for(const c of all)$('repository').append(el('option',{value:c.id},c.name+(c.saved?' · Saved':'')));
  $('repository').value=choice;$('repository').disabled=!all.length;
  const saveWasDisabled=$('db-save').disabled;$('db-save').disabled=!state.session?.storage?.available;
  if($('db-save').disabled)$('db-save').checked=false;else if(saveWasDisabled)$('db-save').checked=true;
  $('save-connection').hidden=!isLive()||!!(state.session?.connections.find(c=>c.id===state.model?.repository.id)?.profileId);
  $('save-connection').disabled=!state.session?.storage?.available;
  $('connection-storage-note').textContent=state.session?.storage?.available?'Saved passwords are encrypted on this server, protected by its operating system credential store. Your browser keeps a private access cookie.':state.session?.storage?.message||'Start the updated server to enable saved connections.';
}
function applyModel(data){
  const initial=!state.model||state.model.repository.id!==data.repository.id;state.model=data;
  if(initial){resetRelationshipExplorer();state.positions.clear();state.selected=data.tables.find(t=>t.name==='projects')?.id||data.tables[0]?.id||null;state.tab='columns';state.query='';$('search').value='';$('diagram-search').value='';$('schema-filter').value='';$('partition-filter').value='';$('focus').checked=false;state.zoom=1;loadLayout();}
  else if(!data.tables.some(t=>t.id===state.selected))state.selected=data.tables[0]?.id||null;
  const schema=$('schema-filter').value;clear($('schema-filter'));$('schema-filter').append(el('option',{value:''},'All schemas'));for(const prefix of [...new Set(data.tables.map(t=>t.prefix))])$('schema-filter').append(el('option',{value:prefix},prefix));$('schema-filter').value=[...new Set(data.tables.map(t=>t.prefix))].includes(schema)?schema:'';
  sqlWorkspace.setConnection(data);profilingWorkspace.setConnection(data);placeTables();render();
  if(initial)requestAnimationFrame(()=>centerTable(state.selected));
  $('refresh').disabled=false;$('export').disabled=false;
}

async function refresh() {
  if(state.busy||state.sqlBusy||!$('repository').value)return;
  state.busy=true;$('refresh').disabled=true;$('repository').disabled=true;$('disconnect').disabled=true;document.body.classList.add('busy');$('scan-status').textContent='Reading schema metadata…';$('error').hidden=true;
  try {
    const id=$('repository').value;
    const request=()=>fetch(id.startsWith('saved-')?'/api/profiles/'+id+'/connect':'/api/connections/'+encodeURIComponent(id)+'/refresh',{method:'POST',headers:{'X-Atlas-CSRF':state.session.csrf}});
    let response=await request();
    if(response.status===401&&id.startsWith('saved-')){
      const renewed=await fetch('/api/session');if(!renewed.ok)throw new Error('Could not restore your connection session.');
      state.session=await renewed.json();response=await request();
    }
    const data=await response.json();if(!response.ok)throw new Error(data.error||'The schema could not be refreshed.');
    const model=data.model||data,initial=!state.model||state.model.repository.id!==model.repository.id;
    if(data.connection)updateConnectionState(data);applyModel(model);renderConnections(model.repository.id);
    if(!initial)notify(model.changes.total?model.changes.total+' tables changed since the last scan.':'Schema is up to date. No metadata changes.');
  } catch(error) {$('error').textContent=error.message;$('error').hidden=false;$('scan-status').textContent='Could not connect or refresh';if(state.model)$('repository').value=connectionChoice(state.model.repository.id);}
  finally {state.busy=false;$('refresh').disabled=!state.model;$('repository').disabled=!connectionInventory().length;$('disconnect').disabled=false;document.body.classList.remove('busy');}
}
function render() {
  const m=state.model;
  $('repo-title').textContent=m.repository.name;
  $('source-type').textContent='PostgreSQL connected';$('source-badge').textContent='● Live PostgreSQL';$('connection-dot').classList.remove('offline');$('disconnect').hidden=!isLive();
  $('provenance').textContent='Live PostgreSQL catalog · Read-only snapshot';
  $('stat-tables').textContent=m.tables.length;
  $('stat-relations').textContent=m.relationships.length;
  $('stat-indexes').textContent=m.tables.reduce((sum,t)=>sum+t.indexes.length,0);
  $('stat-partitions').textContent=m.tables.filter(t=>t.partitions.some(p=>p.type==='strategy')).length;
  $('table-count').textContent=m.tables.length;
  $('warning-count').textContent=m.warnings.length;
  $('change-count').textContent=m.changes.total;
  $('scan-status').textContent=`Updated ${new Date(m.scannedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · ${m.scan.milliseconds} ms`;
  $('revision').textContent=`Snapshot ${m.revision} · PostgreSQL ${m.database.version}`;
  renderList();renderGraph();renderInspector();renderOverview();renderRelationships();
}
function searchMatches(t){const q=state.query.toLowerCase().trim(),schema=$('schema-filter').value,partition=$('partition-filter').value;
  const statusMatch=!partition||(partition==='partitioned'&&!!partitionStrategy(t))||(partition==='partition'&&!!t.partitionOf)||(partition==='ordinary'&&!partitionStrategy(t)&&!t.partitionOf&&(!t.kind||t.kind==='table'));
  return statusMatch&&(!schema||t.prefix===schema)&&(!q||t.id.toLowerCase().includes(q)||t.columns.some(c=>c.name.toLowerCase().includes(q)));}
function visibleTables() {
  let ts=state.model?.tables.filter(searchMatches)||[];
  if($('focus').checked&&state.selected){const ids=new Set([state.selected]);for(const r of state.model.relationships)if(r.from===state.selected)ids.add(r.to);else if(r.to===state.selected)ids.add(r.from);ts=ts.filter(t=>ids.has(t.id));}
  return ts;
}
function selectTable(id,pan=false,remember=true) {
  if(id!==state.selected){if(remember&&state.view==='relations'&&state.selected)relationshipTrail.push(state.selected);if(relationshipTrail.length>30)relationshipTrail.shift();relationshipLimit={incoming:8,outgoing:8,self:8};$('relationship-filter').value='';$('relationship-table-search').value='';}
  if(state.screen!=='schema')showScreen('schema');state.selected=id;renderList();renderGraph();renderInspector();renderOverview();renderRelationships();
  if(pan)centerTable(id);
}
function renderList() {
  clear($('table-list'));let prefix=null;
  for(const t of state.model.tables.filter(searchMatches)) {
    if(prefix!==t.prefix){prefix=t.prefix;$('table-list').append(el('div',{class:'schema-label'},`${prefix} schema`));}
    const b=button('',()=>selectTable(t.id,true),'table-row'+(t.id===state.selected?' selected':''));
    b.setAttribute('title',t.id);b.setAttribute('aria-label',`Inspect ${t.id}`);b.setAttribute('aria-pressed',t.id===state.selected);
    b.append(el('span',{class:'table-glyph'},'▦'),el('span',{class:'table-name'},t.name));
    if(partitionStrategy(t)||t.partitionOf)b.append(el('span',{class:'partition-marker',title:partitionLabel(t),'aria-label':partitionLabel(t)},partitionStrategy(t)?'P+':'P'));
    b.append(el('span',{class:'table-size'},String(t.columns.length)));$('table-list').append(b);
  }
}
const nodeHeight=t=>42+30+12+Math.min(7,t?.columns.length||0)*26+30;
function placeTables(reset=false) {
  if(reset)state.positions.clear();
  const tables=state.model.tables;
  // Put highly connected tables first, then their immediate dependants.
  const degree=new Map();for(const r of state.model.relationships){degree.set(r.from,(degree.get(r.from)||0)+1);degree.set(r.to,(degree.get(r.to)||0)+1);}
  const ordered=[...tables].sort((a,b)=>(degree.get(b.id)||0)-(degree.get(a.id)||0)||a.id.localeCompare(b.id));
  const cols=Math.max(2,Math.min(8,Math.ceil(Math.sqrt(ordered.length)))),ids=new Set(tables.map(t=>t.id));
  for(const id of state.positions.keys())if(!ids.has(id))state.positions.delete(id);
  // Keep existing/dragged positions stable; append new objects below occupied rows.
  const occupiedBottom=Math.max(0,...tables.filter(t=>state.positions.has(t.id)).map(t=>state.positions.get(t.id).y+nodeHeight(t)));
  const startY=state.positions.size?Math.ceil((occupiedBottom+60)/365)*365:0;
  ordered.filter(t=>!state.positions.has(t.id)).forEach((t,i)=>state.positions.set(t.id,{x:(i%cols)*360,y:startY+Math.floor(i/cols)*365}));
}
function renderGraph() {
  if(state.view!=='graph')return;
  clear($('nodes'));const tables=visibleTables();$('empty').hidden=!!tables.length;$('visible-count').textContent=`${tables.length} / ${state.model.tables.length} objects`;
  if(!tables.length)$('empty').textContent=state.model.tables.length?'No tables match your filters.':'No tables or views found in accessible user schemas. Check database and schema permissions.';
  for(const t of tables) {
    const added=state.model.changes.added.includes(t.id),changed=state.model.changes.changed.some(c=>c.id===t.id);
    const card=el('div',{class:`table-node${state.selected===t.id?' selected':''}${added?' added':changed?' changed':''}`,tabindex:'0',role:'button','aria-label':`Inspect table ${t.id}`, 'aria-pressed':state.selected===t.id});
    const p=state.positions.get(t.id);card.style.left=`${p.x}px`;card.style.top=`${p.y}px`;
    card.append(el('div',{class:'node-head'},el('span',{class:'node-icon'},'▦'),el('span',{class:'node-title',title:t.id},t.name),el('span',{class:'node-count',title:t.prefix},t.prefix)));
    const properties=el('div',{class:'node-properties'},el('span',{class:'object-badge'+(partitionStrategy(t)||t.partitionOf?' partition-badge':''),title:partitionStrategy(t)?.key||t.partitionOf||objectKind(t)},partitionLabel(t)));
    if(partitionStrategy(t))properties.append(el('span',{class:'child-count'},`${partitionChildren(t).length} partitions`));
    if(t.partitionOf&&partitionStrategy(t))properties.append(el('span',{class:'object-badge partition-badge',title:t.partitionOf},'Also a partition'));
    card.append(properties);
    const columns=el('div',{class:'node-columns'});
    const prioritized=[...t.columns].sort((a,b)=>Number(b.primaryKey)-Number(a.primaryKey)||Number(!!b.reference)-Number(!!a.reference));
    for(const c of prioritized.slice(0,7))columns.append(el('div',{class:'node-column'},el('span',{class:`key${c.primaryKey?' pk':c.reference?' fk':''}`},c.primaryKey?'⚿':c.reference?'↗':'·'),el('span',{class:'column-name'},c.name),el('span',{class:'column-type',title:c.type},shortType(c.type))));
    card.append(columns,el('div',{class:'node-foot'},el('span',{},`${t.columns.length} columns${t.columns.length>7?` · +${t.columns.length-7} more`:''}`),el('span',{},`${t.indexes.length} indexes`)));
    let dragged=false,start=null;
    card.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.stopPropagation();dragged=false;start={x:e.clientX,y:e.clientY,px:p.x,py:p.y};card.setPointerCapture(e.pointerId);});
    card.addEventListener('pointermove',e=>{if(!start)return;const dx=(e.clientX-start.x)/state.zoom,dy=(e.clientY-start.y)/state.zoom;if(Math.abs(dx)+Math.abs(dy)>4)dragged=true;if(dragged){p.x=Math.max(0,start.px+dx);p.y=Math.max(0,start.py+dy);card.style.left=`${p.x}px`;card.style.top=`${p.y}px`;drawEdges();}});
    card.addEventListener('pointerup',()=>{if(!start)return;start=null;if(dragged){saveLayout();transform();}else selectTable(t.id);});
    card.addEventListener('pointercancel',()=>{start=null;});
    card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectTable(t.id);}});
    $('nodes').append(card);
  }
  drawEdges();transform();
}
function svg(tag,attrs={}){const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;}
function drawEdges() {
  clear($('edges'));const ids=new Set(visibleTables().map(t=>t.id)),byID=new Map(state.model.tables.map(t=>[t.id,t]));
  for(const r of state.model.relationships) {
    if(!ids.has(r.from)||!ids.has(r.to))continue;
    const from=state.positions.get(r.from),to=state.positions.get(r.to);if(!from||!to)continue;
    const fromTable=byID.get(r.from),toTable=byID.get(r.to);
    const priority=t=>[...t.columns].sort((a,b)=>Number(b.primaryKey)-Number(a.primaryKey)||Number(!!b.reference)-Number(!!a.reference));
    const row=(t,name)=>{const idx=priority(t).findIndex(c=>c.name===name);return idx>=0&&idx<7?91+idx*26:nodeHeight(t)-15;};
    const right=to.x>=from.x;let x1=from.x+(right?CARD_WIDTH:0),x2=to.x+(right?0:CARD_WIDTH),y1=from.y+row(fromTable,r.column),y2=to.y+row(toTable,r.targetColumn);
    const offset=Math.max(45,Math.abs(x2-x1)*.45),sign=right?1:-1;
    const d=r.from===r.to?`M ${x1} ${y1} C ${x1+90} ${y1}, ${x1+90} ${y1-65}, ${x1} ${y1-65}`:`M ${x1} ${y1} C ${x1+offset*sign} ${y1}, ${x2-offset*sign} ${y2}, ${x2} ${y2}`;
    const active=r.from===state.selected||r.to===state.selected;
    const line=svg('path',{d,class:active?'highlight':''});
    const title=svg('title');title.textContent=`${r.from} (${(r.columns||[r.column]).join(', ')}) → ${r.to} (${(r.targetColumns||[r.targetColumn]).join(', ')})`;line.append(title);$('edges').append(line);
    // A unique FK can reference each parent only once.
    const childMark=r.cardinality==='one_to_one'?`M ${x1+6*sign} ${y1-4} L ${x1+6*sign} ${y1+4}`:`M ${x1} ${y1-4} L ${x1+8*sign} ${y1} L ${x1} ${y1+4}`;
    $('edges').append(svg('path',{d:`${childMark} M ${x2-6*sign} ${y2-4} L ${x2-6*sign} ${y2+4}`,class:active?'highlight':''}));
  }
}
function diagramBounds(){
  const positions=visibleTables().map(t=>({...state.positions.get(t.id),h:nodeHeight(t)}));
  if(!positions.length)return {minX:0,minY:0,maxX:0,maxY:0};
  return {minX:Math.min(...positions.map(p=>p.x)),minY:Math.min(...positions.map(p=>p.y)),maxX:Math.max(...positions.map(p=>p.x+CARD_WIDTH)),maxY:Math.max(...positions.map(p=>p.y+p.h))};
}
function transform(){
  const b=diagramBounds(),viewport=$('diagram-viewport');
  state.originX=GRAPH_PADDING;state.originY=GRAPH_PADDING;
  $('diagram-space').style.width=`${Math.max(viewport.clientWidth,(b.maxX+GRAPH_PADDING*2)*state.zoom)}px`;
  $('diagram-space').style.height=`${Math.max(viewport.clientHeight,(b.maxY+GRAPH_PADDING*2)*state.zoom)}px`;
  $('world').style.transform=`translate(${state.originX*state.zoom}px,${state.originY*state.zoom}px) scale(${state.zoom})`;
  $('zoom-label').textContent=`${Math.round(state.zoom*100)}%`;
}
function centerTable(id){
  const p=state.positions.get(id),t=state.model?.tables.find(t=>t.id===id);if(!p||!t)return;
  transform();const v=$('diagram-viewport');
  v.scrollLeft=(p.x+CARD_WIDTH/2+state.originX)*state.zoom-v.clientWidth/2;
  v.scrollTop=(p.y+nodeHeight(t)/2+state.originY)*state.zoom-v.clientHeight/2;
}
function fit(){
  if(!visibleTables().length)return;const b=diagramBounds(),v=$('diagram-viewport');
  state.zoom=Math.min(1,Math.max(.001,Math.min(v.clientWidth/(b.maxX-b.minX+GRAPH_PADDING*2),(v.clientHeight-65)/(b.maxY-b.minY+GRAPH_PADDING*2))));
  transform();v.scrollLeft=((b.minX+b.maxX)/2+state.originX)*state.zoom-v.clientWidth/2;v.scrollTop=((b.minY+b.maxY)/2+state.originY)*state.zoom-v.clientHeight/2;
}
function zoomBy(factor,clientX,clientY){
  const v=$('diagram-viewport'),rect=v.getBoundingClientRect(),cx=clientX==null?v.clientWidth/2:clientX-rect.left,cy=clientY==null?v.clientHeight/2:clientY-rect.top;
  const worldX=(v.scrollLeft+cx)/state.zoom-state.originX,worldY=(v.scrollTop+cy)/state.zoom-state.originY;
  state.zoom=Math.max(.01,Math.min(2,state.zoom*factor));transform();
  v.scrollLeft=(worldX+state.originX)*state.zoom-cx;v.scrollTop=(worldY+state.originY)*state.zoom-cy;
}
function readableView(){state.zoom=1;transform();const target=visibleTables().find(t=>t.id===state.selected)||visibleTables()[0];if(target)centerTable(target.id);}
function filterDiagram(){if(!state.model)return;renderList();renderGraph();renderOverview();readableView();}
function viewAnchor(){const v=$('diagram-viewport');return {x:(v.scrollLeft+v.clientWidth/2)/state.zoom-state.originX,y:(v.scrollTop+v.clientHeight/2)/state.zoom-state.originY};}
function restoreAnchor(anchor){transform();const v=$('diagram-viewport');v.scrollLeft=(anchor.x+state.originX)*state.zoom-v.clientWidth/2;v.scrollTop=(anchor.y+state.originY)*state.zoom-v.clientHeight/2;}
function setFullscreen(enabled){
  const anchor=viewAnchor();state.fullscreen=enabled;$('workspace').classList.toggle('is-fullscreen',enabled);document.body.classList.toggle('diagram-fullscreen',enabled);
  $('fullscreen').textContent=enabled?'⤢ Exit full screen':'⛶ Full screen';$('fullscreen').setAttribute('aria-label',enabled?'Exit full screen':'Enter full screen');$('fullscreen').setAttribute('aria-pressed',String(enabled));
  for(const element of document.querySelectorAll('.sidebar, main > .topbar, main > .heading, main > .stats, main > #error'))element.inert=enabled;
  requestAnimationFrame(()=>restoreAnchor(anchor));
}
function toggleFullscreen(){setFullscreen(!state.fullscreen);$('fullscreen').focus();}
$('fullscreen').addEventListener('click',toggleFullscreen);
$('toggle-details').addEventListener('click',()=>{const anchor=viewAnchor(),hidden=$('workspace').classList.toggle('details-hidden');$('toggle-details').textContent=hidden?'Show details':'Hide details';$('toggle-details').setAttribute('aria-expanded',String(!hidden));$('inspector').inert=hidden;requestAnimationFrame(()=>restoreAnchor(anchor));});
new ResizeObserver(()=>transform()).observe($('diagram-viewport'));
function saveLayout(){try{localStorage.setItem(`atlas-layout-v2:${state.model.repository.id}:${state.model.repository.path}`,JSON.stringify([...state.positions]));}catch{/* Layout persistence is optional. */}}
function loadLayout(){try{const stored=JSON.parse(localStorage.getItem(`atlas-layout-v2:${state.model.repository.id}:${state.model.repository.path}`)||'[]');if(Array.isArray(stored)&&stored.length<=5000)for(const[id,p]of stored)if(typeof id==='string'&&p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.y>=0&&p.x<100000&&p.y<100000)state.positions.set(id,p);}catch{/* Ignore malformed layout preferences. */}}

function renderInspector() {
  const pane=$('inspector');clear(pane);const t=current();
  if(!t){pane.append(el('div',{class:'empty-panel'},el('h3',{},'Every detail, one click away.'),el('p',{},'Connect PostgreSQL, then select a table to inspect its columns, keys, indexes, constraints, partitions and more.')));return;}
  const head=el('div',{class:'inspector-head'},el('div',{class:'inspector-kicker'},'OBJECT DETAILS',el('span',{class:'type-badge'},objectKind(t).toUpperCase())),el('h2',{},t.name),el('p',{class:'inspector-desc'},t.comment||`${t.prefix} schema · ${state.model.database.name}`),el('div',{class:'table-meta'},el('span',{},`${t.columns.length} columns`),el('span',{},`${t.indexes.length} indexes`),el('span',{},`${t.primaryKey.length} PK columns`)));
  const partition=partitionStrategy(t),children=partitionChildren(t);
  const partitionSummary=el('div',{class:'partition-summary'},el('strong',{},`Partitioned: ${partitionStatus(t)}`));
  if(partition)partitionSummary.append(el('span',{},`${partition.strategy||'Unknown method'} · ${children.length} direct partitions`),el('code',{},partition.key||'Key unavailable'));
  if(t.partitionOf)partitionSummary.append(el('span',{},'This table is a partition of'),button(t.partitionOf,()=>navigateTable(t.partitionOf),'reference-link'),el('code',{},t.options.partitionBound||'Bound unavailable'));
  head.append(partitionSummary);head.append(button('⌨ Query table',()=>sqlWorkspace.table(t),'button query-table-button'));
  const tabs=el('div',{class:'inspector-tabs',role:'tablist','aria-label':'Metadata categories'});
  for(const[id,label]of[['columns','Columns'],['indexes','Indexes'],['relations','Relations'],['details','Details']]){const b=button(label,()=>{state.tab=id;renderInspector();},state.tab===id?'active':'');b.setAttribute('role','tab');b.setAttribute('aria-selected',state.tab===id);tabs.append(b);}
  const content=el('div',{class:'inspector-content',role:'tabpanel'});pane.append(head,tabs,content);
  if(state.tab==='columns') {
    content.append(sectionTitle('COLUMNS',t.columns.length));
    for(const c of t.columns) {
      const row=el('div',{class:'column-detail'}),heading=el('div',{class:'column-heading'},el('span',{},c.name));
      if(c.primaryKey)heading.append(el('span',{class:'badge'},'PK'));if(c.reference)heading.append(el('span',{class:'badge fk'},'FK'));
      heading.append(el('span',{class:'column-data-type'},shortType(c.type)));row.append(heading);
      const attrs=el('div',{class:'column-attributes'},el('span',{class:'not-null'},c.nullable===false?'NOT NULL':c.nullable===true?'Nullable':'Nullability unverified'));
      if(c.default!==null)attrs.append(el('span',{},`· Default: ${fmt(c.default)}`));
      for(const key of ['size','precision','scale','comment','generated','identity'])if(c.options[key])attrs.append(el('span',{},`· ${key}: ${fmt(c.options[key])}`));
      row.append(attrs);
      const refs=c.references?.length?c.references:c.reference?[c.reference]:[];
      for(const r of refs){row.append(button(`↗ ${r.table}.${r.column}`,()=>navigateTable(r.table),'reference-link'));row.append(el('div',{class:'column-attributes'},`On delete: ${r.onDelete} · On update: ${r.onUpdate}`));}
      const details=el('details',{class:'column-extra'},el('summary',{},'Catalog properties'),sourceLine(c.source));
      const extra=c.options;if(Object.keys(extra).length)details.append(infoGrid(Object.entries(extra).filter(([,v])=>v!=null)));
      for(const r of refs)details.append(infoGrid(Object.entries(r).filter(([k])=>!['table','column','onDelete','onUpdate'].includes(k))));row.append(details);content.append(row);
    }
  } else if(state.tab==='indexes') {
    content.append(sectionTitle('INDEXES',t.indexes.length));
    if(!t.indexes.length)content.append(note('No indexes on this object.'));
    for(const i of t.indexes){
      const card=el('div',{class:'metadata-card'},el('span',{class:`tag${i.primary?' primary-tag':''}`},i.primary?'PRIMARY KEY':i.unique?'UNIQUE':'INDEX'),el('span',{class:'tag'},i.using.toUpperCase()),el('h3',{},i.name),el('code',{},i.columns.join(', ')));
      if(i.where)card.append(el('p',{},'Predicate'),el('code',{},fmt(i.where)));if(i.include?.length)card.append(el('p',{},`Include: ${i.include.join(', ')}`));
      if(i.statistics)card.append(el('p',{},`Size: ${humanBytes(i.statistics.bytes)}`));
      const extra=Object.entries(i.options||{}).filter(([k,v])=>v!=null&&!['name','using','where','include','concurrently','unique','prefix','sql'].includes(k));if(extra.length)card.append(infoGrid(extra));
      if(i.definition)card.append(sqlDefinition(i.definition));card.append(sourceLine(i.source));content.append(card);
    }
  } else if(state.tab==='relations') {
    const relations=state.model.relationships.filter(r=>r.from===t.id||r.to===t.id);content.append(sectionTitle('RELATIONSHIPS',relations.length));
    if(!relations.length)content.append(note('No foreign-key constraints reference this object. Relationships without database constraints cannot be inferred.'));
    for(const r of relations){
      const outgoing=r.from===t.id,target=outgoing?r.to:r.from;
      const card=el('div',{class:'metadata-card'},el('span',{class:'tag'},'FOREIGN KEY'),el('h3',{},r.name||`${r.from}.${r.column}`),el('code',{},`${r.from} (${(r.columns||[r.column]).join(', ')}) → ${r.to} (${(r.targetColumns||[r.targetColumn]).join(', ')})`),button(`Open ${target}`,()=>navigateTable(target),'reference-link'),el('p',{},outgoing?'Outgoing reference to parent.':'Incoming reference from child.'),el('p',{},`Delete: ${r.onDelete} · Update: ${r.onUpdate}`));
      card.append(infoGrid([['Cardinality',r.cardinality==='one_to_one'?'One to one':'Many to one'],['Nullable reference',r.optional],['Validated',r.validated],['Deferrable',r.deferrable],['Initially deferred',r.initiallyDeferred],['Match',r.match],['Inherited',r.inherited]]));card.append(sourceLine(r.source));content.append(card);
    }
  } else {
    content.append(sectionTitle('TABLE PROPERTIES'),infoGrid([['Schema',t.prefix],['Partitioned',partitionStatus(t)],['Is a partition',t.partitionOf?'Yes':'No'],['Primary key',t.primaryKey.join(', ')||'None'],['Source','PostgreSQL catalog'],['Database state','Live snapshot']]));
    content.append(infoGrid([['Object type',t.kind],['Total size',humanBytes(t.statistics.totalBytes)],['Index size',humanBytes(t.statistics.indexBytes)],['Data size',humanBytes(t.statistics.dataBytes)],['Estimated rows',t.statistics.estimatedRows??'Not analyzed']]));
    if(Object.keys(t.options).length)content.append(sectionTitle('TABLE OPTIONS'),infoGrid(Object.entries(t.options)));
    if(t.viewDefinition)content.append(sqlDefinition(t.viewDefinition));
    content.append(el('br'),sectionTitle('PARTITIONS',partitionChildren(t).length));
    if(t.partitionOf)content.append(el('div',{class:'metadata-card'},el('h3',{},'Partition of'),button(t.partitionOf,()=>navigateTable(t.partitionOf),'reference-link'),el('code',{},t.options.partitionBound||'Bound not resolved')));
    if(!t.partitions.length&&!t.partitionOf)content.append(note('This object is not partitioned.'));
    for(const p of t.partitions)content.append(el('div',{class:'metadata-card'},el('span',{class:'tag'},p.type==='strategy'?p.strategy.toUpperCase():'PARTITION'),el('h3',{},p.key||p.name),p.type==='child'?button('Open partition',()=>navigateTable(p.name),'reference-link'):null,p.bound?el('code',{},p.bound):null,sourceLine(p.source)));
    content.append(el('br'),sectionTitle('CONSTRAINTS',t.constraints.length));if(!t.constraints.length)content.append(note('No explicit constraints on this object.'));
    for(const c of t.constraints)content.append(el('div',{class:'metadata-card'},el('span',{class:'tag'},c.type.toUpperCase()),el('h3',{},c.name),el('code',{},fmt(c.definition)),c.options?infoGrid(Object.entries(c.options)):null,sourceLine(c.source)));
    content.append(el('br'),sectionTitle('TRIGGERS',t.triggers.length));if(!t.triggers.length)content.append(note('No user-defined triggers.'));
    for(const tr of t.triggers)content.append(el('div',{class:'metadata-card'},el('h3',{},tr.name),el('p',{},`Enabled: ${{O:'origin / local',D:'disabled',R:'replica',A:'always'}[tr.enabled]||tr.enabled}`),el('code',{},tr.definition)));
    content.append(el('br'),sectionTitle('ROW SECURITY POLICIES',t.policies.length));if(!t.policies.length)content.append(note('No row security policies.'));
    for(const policy of t.policies)content.append(el('div',{class:'metadata-card'},el('h3',{},policy.name),infoGrid(Object.entries(policy).filter(([k])=>k!=='name'))));
    content.append(el('br'),sectionTitle('TABLE GRANTS',t.grants.length));
    for(const grant of t.grants)content.append(el('div',{class:'metadata-card'},el('h3',{},grant.grantee),el('code',{},grant.privilege),el('p',{},`Grantor: ${grant.grantor} · Grantable: ${grant.grantable?'yes':'no'}`)));
    content.append(note('Grants are catalog ACL entries. Role inheritance and column-specific privileges are not expanded.'));
  }
}
function navigateTable(id){if(!state.model.tables.some(t=>t.id===id)){notify('Referenced object is outside the visible schemas or snapshot.');return;}state.query='';$('search').value='';$('schema-filter').value='';$('partition-filter').value='';$('diagram-search').value='';selectTable(id,true);}
function renderOverview(){
  if(state.view!=='list')return;
  clear($('overview'));const table=el('table',{class:'overview-table'});
  table.append(el('thead',{},el('tr',{},overviewColumns.map(({key,label})=>{
    const active=state.overviewSort.column===key,direction=active?state.overviewSort.direction:'none';
    const next=direction==='ascending'?'descending':'ascending',action=`Sort by ${label.toLowerCase()}, ${next}`;
    return el('th',{scope:'col','aria-sort':direction},el('button',{
      type:'button',class:'overview-sort','data-sort':key,'aria-label':action,title:action,
      onclick:()=>{
        state.overviewSort={column:key,direction:next};renderOverview();
        $('overview').querySelector(`[data-sort="${key}"]`).focus({preventScroll:true});
      },
    },label,el('span',{class:'overview-sort-icon','aria-hidden':'true'},active?(direction==='ascending'?'↑':'↓'):'↕')));
  }))));
  const tbody=el('tbody');
  for(const row of overviewRows(visibleTables(),state.model.relationships,state.overviewSort)){
    const t=row.table;
    tbody.append(el('tr',{},el('td',{},button(t.id,()=>selectTable(t.id))),el('td',{},el('span',{class:'object-badge'+(partitionStrategy(t)||t.partitionOf?' partition-badge':'')},row.type)),el('td',{},row.partitioning),el('td',{},String(row.columns)),el('td',{},String(row.indexes)),el('td',{},String(row.foreignKeys)),el('td',{},row.estimatedRows??'—'),el('td',{},humanBytes(row.totalBytes)),el('td',{},humanBytes(row.indexBytes)),el('td',{},humanBytes(row.dataBytes))));
  }
  table.append(tbody);$('overview').append(table,note('Total size = data + indexes. Data includes TOAST and table overhead. Sizes belong to each object; partition parents do not include their children.'));
}


let relationshipTrail=[],relationshipLimit={incoming:8,outgoing:8,self:8};
function resetRelationshipExplorer(){
  relationshipTrail=[];relationshipLimit={incoming:8,outgoing:8,self:8};
  $('relationship-table-search').value='';$('relationship-filter').value='';
}
function renderRelationshipPicker(){
  const tables=state.model?.tables||[],q=$('relationship-table-search').value.trim().toLowerCase();
  const matches=tables.filter(t=>t.id.toLowerCase().includes(q)).sort((a,b)=>a.id.localeCompare(b.id)),select=$('relationship-table');
  clear(select);
  if(!matches.some(t=>t.id===state.selected))select.append(el('option',{value:''},matches.length?'Choose a matching table…':'No matching tables'));
  for(const t of matches)select.append(el('option',{value:t.id},t.id));
  select.value=matches.some(t=>t.id===state.selected)?state.selected:'';
  select.disabled=!matches.length;$('relationship-table-search').disabled=!tables.length;
  $('relationship-picker-count').textContent=matches.length+' / '+tables.length+' tables';
}
function relationshipCard(group){
  const target=state.model.tables.find(t=>t.id===group.id);
  const card=el('article',{class:'relationship-card'});
  const open=button(group.id,()=>{selectTable(group.id);$('relationship-explorer').scrollTop=0;},'relationship-table-link');
  open.disabled=!target;open.setAttribute('title',target?'Explore '+group.id:'Outside the current snapshot');
  card.append(el('div',{class:'relationship-card-title'},open,el('span',{class:'relationship-key-count'},group.links.length+(group.links.length===1?' key':' keys'))));
  if(target)card.append(el('p',{class:'relationship-table-meta'},partitionLabel(target)+' · '+target.columns.length+' columns'));
  else card.append(el('p',{class:'relationship-table-meta'},'Outside the current snapshot'));
  function binding(r){
    const from=r.columns||[r.column],to=r.targetColumns||[r.targetColumn];
    const detail=el('div',{class:'relationship-binding'},
      el('div',{class:'relationship-binding-name'},r.name||'Foreign key'));
    from.forEach((name,i)=>detail.append(el('div',{class:'relationship-mapping'},el('code',{},r.from+'.'+name),el('span',{'aria-label':'references'},'→'),el('code',{},r.to+'.'+(to[i]||'?')))));
    const cardinality=r.cardinality==='one_to_one'?'One → one':r.cardinality==='many_to_one'?'Many → one':'Cardinality unverified';
    const optional=typeof r.optional==='boolean'?r.optional:typeof r.nullable==='boolean'?r.nullable:null;
    detail.append(el('p',{class:'relationship-rules'},cardinality+(optional===null?'':optional?' · Nullable reference':' · Required reference')+(r.inherited?' · Inherited key':'')));
    const more=el('details',{class:'relationship-key-details'},el('summary',{},'Key details'));
    more.append(infoGrid([['On delete',r.onDelete],['On update',r.onUpdate],['Validated',r.validated],['Deferrable',r.deferrable],['Initially deferred',r.initiallyDeferred]].filter(([,v])=>v!==undefined)));
    detail.append(more);return detail;
  }
  card.append(binding(group.links[0]));
  if(group.links.length>1){
    const extra=el('details',{class:'relationship-extra'},el('summary',{},'Show '+(group.links.length-1)+' more keys to this table'));
    for(const r of group.links.slice(1))extra.append(binding(r));
    card.append(extra);
  }
  return card;
}
function renderRelationships(){
  if(state.view!=='relations')return;
  renderRelationshipPicker();const t=current(),summary=$('relationship-summary');
  clear(summary);for(const id of ['relationship-incoming','relationship-outgoing','relationship-self'])clear($(id));
  relationshipTrail=relationshipTrail.filter(id=>state.model?.tables.some(t=>t.id===id));
  $('relationship-back').disabled=!relationshipTrail.length;$('relationship-filter').disabled=!t;
  if(!t){
    summary.append(el('div',{class:'relationship-empty'},el('h2',{},'Choose a table to explore its relationships'),note(state.model?'No tables are available in this snapshot.':'Connect PostgreSQL to explore the tables in your database.')));
    $('relationship-count').textContent='0 relationships';return;
  }
  const links=state.model.relationships.filter(r=>r.from===t.id||r.to===t.id),q=$('relationship-filter').value.trim().toLowerCase();
  const filtered=links.filter(r=>[r.from,r.to,r.name,...(r.columns||[r.column]),...(r.targetColumns||[r.targetColumn])].some(v=>String(v||'').toLowerCase().includes(q)));
  const matching=new Set(filtered);
  const incoming=links.filter(r=>r.to===t.id&&r.from!==t.id),outgoing=links.filter(r=>r.from===t.id&&r.to!==t.id),self=links.filter(r=>r.from===t.id&&r.to===t.id);
  const head=el('div',{class:'relationship-focus'},el('h2',{},t.id));
  head.append(el('div',{class:'relationship-focus-meta'},el('span',{class:'object-badge'},partitionLabel(t)),el('span',{},t.columns.length+' columns'),el('span',{},t.indexes.length+' indexes'),el('span',{},'Partitioned: '+partitionStatus(t))));
  if(t.primaryKey.length)head.append(el('p',{class:'relationship-primary'},el('strong',{},'Primary key '),el('code',{},t.primaryKey.join(', '))));
  if(t.partitionOf)head.append(el('p',{class:'relationship-primary'},'Partition of '+t.partitionOf));
  const incomingCount=new Set(incoming.map(r=>r.from)).size,outgoingCount=new Set(outgoing.map(r=>r.to)).size;
  head.append(el('div',{class:'relationship-totals'},
    el('span',{},incomingCount+' referencing '+(incomingCount===1?'table':'tables')),
    el('span',{},outgoingCount+' referenced '+(outgoingCount===1?'table':'tables')),
    self.length?el('span',{},self.length+(self.length===1?' self reference':' self references')):null));
  const actions=el('div',{class:'relationship-focus-actions'},button('Inspect metadata',()=>{
    $('workspace').classList.remove('details-hidden');$('inspector').inert=false;$('toggle-details').textContent='Hide details';$('toggle-details').setAttribute('aria-expanded','true');
    $('inspector').setAttribute('tabindex','-1');$('inspector').focus();
  },'button subtle'));
  head.append(actions);summary.append(head);
  $('relationship-count').textContent=filtered.length+' / '+links.length+' relationships';
  function lane(key,title,description,all){
    const root=$('relationship-'+key),grouped=new Map();
    for(const r of all.filter(r=>matching.has(r))){const id=key==='incoming'?r.from:r.to;if(!grouped.has(id))grouped.set(id,{id,links:[]});grouped.get(id).links.push(r);}
    const groups=[...grouped.values()].sort((a,b)=>a.id.localeCompare(b.id));
    root.append(el('div',{class:'relationship-lane-heading'},el('h3',{},title),el('span',{},String(groups.length))),el('p',{class:'relationship-lane-description'},description));
    if(!groups.length)root.append(el('p',{class:'relationship-empty'},all.length?'No relationships match this filter.':'No declared relationships in this direction.'));
    for(const group of groups.slice(0,relationshipLimit[key]))root.append(relationshipCard(group));
    if(groups.length>relationshipLimit[key]){
      const more=button('Show next '+Math.min(8,groups.length-relationshipLimit[key])+' tables ('+(groups.length-relationshipLimit[key])+' remaining)',()=>{
        const firstHidden=groups[relationshipLimit[key]]?.id;relationshipLimit[key]+=8;renderRelationships();
        [...$('relationship-'+key).querySelectorAll('.relationship-table-link')].find(b=>b.textContent===firstHidden)?.focus();
      },'button relationship-more');root.append(more);
    }
  }
  lane('incoming','Referenced by','These tables have foreign keys pointing to '+t.name+'.',incoming);
  lane('outgoing','References',t.name+' has foreign keys pointing to these tables.',outgoing);
  if(self.length)lane('self','Self references','Relationships between rows within this table.',self);
}
$('relationship-table-search').addEventListener('input',renderRelationshipPicker);
$('relationship-table').addEventListener('change',e=>{if(e.target.value)selectTable(e.target.value);});
$('relationship-filter').addEventListener('input',()=>{relationshipLimit={incoming:8,outgoing:8,self:8};renderRelationships();});
$('relationship-back').addEventListener('click',()=>{const id=relationshipTrail.pop();if(id)selectTable(id,false,false);});

function showReport(kind) {
  if(!state.model)return;const body=$('report-body');clear(body);
  if(kind==='changes') {
    $('report-title').textContent='What changed';$('report-eyebrow').textContent='SCHEMA SNAPSHOT COMPARISON';const c=state.model.changes;
    body.append(el('p',{},c.baseline?'First snapshot saved as the baseline. After database schema changes, refresh to compare.':c.total?`${c.total} table${c.total===1?'':'s'} changed since the previous successful scan.`:'No table metadata changes since the previous successful scan.'));
    for(const kind of ['added','removed','changed'])for(const change of c[kind]){const id=typeof change==='string'?change:change.id;body.append(el('div',{class:'report-row'},el('span',{class:`change-tag ${kind}`},kind),el('strong',{},id),typeof change==='object'?el('p',{},`Updated: ${change.details.join(', ')}${change.addedColumns.length?` · New columns: ${change.addedColumns.join(', ')}`:''}${change.removedColumns.length?` · Removed columns: ${change.removedColumns.join(', ')}`:''}`):null));}
    body.append(el('p',{},'Comparison is against the previous successful snapshot for this connection. Columns, indexes, constraints, partitions, triggers, policies and grants are compared. Changing row estimates or storage sizes does not count as a schema change.'));
  } else {
    $('report-title').textContent='Know what you’re looking at';$('report-eyebrow').textContent='SCAN COVERAGE';const m=state.model;
    body.append(el('p',{},m.coverage.note),el('p',{},m.coverage.metadataNotes));
    body.append(infoGrid([['Database',m.database.name],['Server',`${m.database.host}:${m.database.port}`],['PostgreSQL',m.database.version],['Connected as',m.database.username],['Transport',m.database.tls?'Verified TLS':'Local / SSH tunnel'],['Read-only transaction',m.database.readOnly],['Snapshot isolation',m.database.isolation],['Encoding',m.database.encoding],['Collation',m.database.collation],['Objects',m.tables.length],['Scan duration',`${m.scan.milliseconds} ms`]]),el('p',{},'All indexes, including primary-key indexes, are included. Ordinary tables, partitions, views, materialized views and foreign tables are shown in schemas accessible to the connected role. System schemas are excluded. Cross-database links are not inferred. PostgreSQL 12+ is required.'));
    for(const w of m.warnings)body.append(el('div',{class:'report-row'},el('div',{},w.message),sourceLine(w)));
    if(!m.warnings.length)body.append(el('p',{},'Catalog scan completed successfully. Refresh to see newer DDL changes.'));
  }
  $('report').showModal();
}
function exportSnapshot(){if(!state.model)return;const blob=new Blob([JSON.stringify(state.model,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);const a=el('a',{href:url,download:`schema-atlas-${state.model.revision}.json`});a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);notify('Snapshot exported.');}
function view(name){
  showScreen('schema');state.view=name;$('canvas').hidden=name!=='graph';$('overview').hidden=name!=='list';$('relationship-explorer').hidden=name!=='relations';
  document.querySelector('.stats').hidden=name==='relations';
  $('workspace').classList.toggle('relationship-mode',name==='relations');
  for(const [id,value]of [['graph-view','graph'],['list-view','list'],['relations-view','relations']]){$(id).classList.toggle('active',name===value);$(id).setAttribute('aria-pressed',String(name===value));}
  if(name==='relations')renderRelationships();else if(state.model){if(name==='list')renderOverview();else {renderGraph();requestAnimationFrame(()=>centerTable(state.selected));}}
}
$('refresh').addEventListener('click',refresh);$('repository').addEventListener('change',refresh);
for(const id of ['search','diagram-search'])$(id).addEventListener('input',e=>{state.query=e.target.value;$('search').value=state.query;$('diagram-search').value=state.query;filterDiagram();});
$('focus').addEventListener('change',filterDiagram);$('partition-filter').addEventListener('change',filterDiagram);$('fit').addEventListener('click',fit);
$('layout').addEventListener('click',()=>{if(!state.model)return;placeTables(true);saveLayout();renderGraph();readableView();});
$('zoom-label').addEventListener('click',readableView);$('zoom-in').addEventListener('click',()=>zoomBy(1.2));$('zoom-out').addEventListener('click',()=>zoomBy(1/1.2));$('export').addEventListener('click',exportSnapshot);
$('relations-view').addEventListener('click',()=>view('relations'));$('graph-view').addEventListener('click',()=>view('graph'));$('list-view').addEventListener('click',()=>view('list'));$('diagram-nav').addEventListener('click',()=>{$('report').close();view('graph');});$('changes-nav').addEventListener('click',()=>showReport('changes'));$('coverage-nav').addEventListener('click',()=>showReport('coverage'));$('close-report').addEventListener('click',()=>$('report').close());
const viewport=$('diagram-viewport');let pan=null;
viewport.addEventListener('pointerdown',e=>{const rect=viewport.getBoundingClientRect();if(e.button!==0||e.pointerType==='touch'||e.target.closest('.table-node')||e.clientX>=rect.left+viewport.clientWidth||e.clientY>=rect.top+viewport.clientHeight)return;pan={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};viewport.setPointerCapture(e.pointerId);viewport.classList.add('panning');});
viewport.addEventListener('pointermove',e=>{if(pan){viewport.scrollLeft=pan.left+pan.x-e.clientX;viewport.scrollTop=pan.top+pan.y-e.clientY;}});
for(const type of ['pointerup','pointercancel'])viewport.addEventListener(type,()=>{pan=null;viewport.classList.remove('panning');});
viewport.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();zoomBy(Math.exp(-e.deltaY*.01),e.clientX,e.clientY);}else if(e.shiftKey&&!e.deltaX){e.preventDefault();viewport.scrollLeft+=e.deltaY;}},{passive:false});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&state.fullscreen){e.preventDefault();setFullscreen(false);$('fullscreen').focus();return;}
  if(document.querySelector('dialog[open]')||['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName))return;
  if(e.key==='/'){e.preventDefault();$(state.screen==='sql'?'sql-editor':'diagram-search').focus();}else if(e.key==='1')view('graph');else if(e.key==='2')showScreen('sql');else if(e.key==='3')showScreen('profiling');else if(e.key==='0'&&state.model)readableView();else if(e.key==='+'||e.key==='=')zoomBy(1.2);else if(e.key==='-')zoomBy(1/1.2);
});
const welcome=$('empty').firstElementChild.cloneNode(true);
function disconnected(){
  resetRelationshipExplorer();state.model=null;sqlWorkspace.setConnection(null);profilingWorkspace.setConnection(null);state.selected=null;state.positions.clear();state.zoom=1;state.query='';$('search').value='';$('diagram-search').value='';$('partition-filter').value='';$('visible-count').textContent='0 objects';transform();clear($('nodes'));clear($('edges'));clear($('table-list'));clear($('overview'));$('empty').replaceChildren(welcome.cloneNode(true));$('empty').hidden=false;$('empty').querySelector('button').addEventListener('click',openConnection);
  $('repo-title').textContent='No database connected';$('source-type').textContent='Not connected';$('source-badge').textContent='PostgreSQL catalog';$('connection-dot').classList.add('offline');$('scan-status').textContent='Connect a database to begin';$('revision').textContent='Waiting for a connection';$('provenance').textContent='Read-only PostgreSQL catalog inspection';$('disconnect').hidden=true;$('save-connection').hidden=true;$('refresh').disabled=true;$('export').disabled=true;$('error').hidden=true;
  for(const key of ['stat-tables','stat-relations','stat-indexes','stat-partitions'])$(key).textContent='—';for(const key of ['table-count','warning-count','change-count'])$(key).textContent='0';clear($('schema-filter'));$('schema-filter').append(el('option',{value:''},'All schemas'));renderInspector();view('graph');
}
function openConnection(){if(state.busy||state.sqlBusy)return;renderConnections();$('connection-error').hidden=true;$('connection-dialog').showModal();}
function closeConnection(){if(state.busy||state.sqlBusy)return;$('connection-dialog').close();$('connection-form').reset();$('ca-field').hidden=true;}
$('connect-sidebar').addEventListener('click',openConnection);$('connect-empty').addEventListener('click',openConnection);$('close-connection').addEventListener('click',closeConnection);$('cancel-connection').addEventListener('click',closeConnection);
$('connection-dialog').addEventListener('cancel',e=>{e.preventDefault();closeConnection();});
function renderSavedConnections(){
  const list=$('saved-connections-list');clear(list);$('saved-connections-error').hidden=true;
  const profiles=state.session?.savedConnections||[];
  if(!profiles.length)list.append(note('No saved connections yet. Connect PostgreSQL with “Save this connection and password” checked.'));
  for(const p of profiles){
    const actions=el('div',{class:'saved-profile-actions'}),card=el('article',{class:'saved-profile'},
      el('div',{},el('h3',{},p.name),el('p',{},p.database+' · '+p.host+':'+p.port),el('small',{},p.user+' · '+(p.tls==='verify'?'Verified TLS':'Local / SSH tunnel'))),actions);
    actions.append(button('Connect',()=>{if(state.busy||state.sqlBusy)return;$('saved-connections-dialog').close();$('repository').value=p.id;void refresh();},'button primary'));
    let confirm=false;
    const forget=button('Forget',async()=>{
      if(state.busy||state.sqlBusy)return;
      if(!confirm){confirm=true;forget.textContent='Confirm forget';return;}
      state.busy=true;forget.disabled=true;
      try{
        const response=await fetch('/api/profiles/'+p.id+'/forget',{method:'POST',headers:{'X-Atlas-CSRF':state.session.csrf}}),data=await response.json();
        if(!response.ok)throw new Error(data.error||'Could not forget this profile.');
        updateConnectionState(data);renderConnections();renderSavedConnections();notify('Saved profile removed. Active connections are unchanged.');
      }catch(error){$('saved-connections-error').textContent=error.message;$('saved-connections-error').hidden=false;}
      finally{state.busy=false;forget.disabled=false;}
    },'button subtle');
    actions.append(forget);list.append(card);
  }
}
$('manage-connections').addEventListener('click',()=>{if(state.busy||state.sqlBusy)return;renderSavedConnections();$('saved-connections-dialog').showModal();});
$('close-saved-connections').addEventListener('click',()=>{if(!state.busy)$('saved-connections-dialog').close();});
$('saved-connections-dialog').addEventListener('cancel',e=>{if(state.busy)e.preventDefault();});
$('save-connection').addEventListener('click',async()=>{
  if(state.busy||state.sqlBusy||!isLive())return;state.busy=true;$('save-connection').disabled=true;
  try{
    const response=await fetch('/api/connections/'+state.model.repository.id+'/save',{method:'POST',headers:{'X-Atlas-CSRF':state.session.csrf}}),data=await response.json();
    if(!response.ok)throw new Error(data.error||'Could not save the connection.');
    updateConnectionState(data);renderConnections();notify('Connection saved. It will be available after restarting Schema Atlas.');
  }catch(error){$('error').textContent=error.message;$('error').hidden=false;}
  finally{state.busy=false;$('save-connection').disabled=!state.session?.storage?.available;}
});
$('db-tls').addEventListener('change',()=>{$('ca-field').hidden=$('db-tls').value!=='verify';});
$('db-host').addEventListener('input',()=>{$('db-tls').value=['localhost','127.0.0.1','::1'].includes($('db-host').value.trim())?'local':'verify';$('ca-field').hidden=$('db-tls').value!=='verify';});
$('connection-form').addEventListener('submit',async event=>{
  event.preventDefault();if(state.busy||state.sqlBusy)return;state.busy=true;$('submit-connection').disabled=true;$('submit-connection').textContent='Connecting…';$('connection-error').hidden=true;
  let payload;
  try{
    payload={name:$('db-name').value,host:$('db-host').value.trim(),port:Number($('db-port').value),database:$('db-database').value,user:$('db-user').value,password:$('db-password').value,tls:$('db-tls').value,ca:$('db-tls').value==='verify'?$('db-ca').value:''};
    if(state.session.storage?.available)payload.save=$('db-save').checked;
    const response=await fetch('/api/connections',{method:'POST',headers:{'Content-Type':'application/json','X-Atlas-CSRF':state.session.csrf},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not connect.');
    if(data.connections)updateConnectionState(data);else state.session.connections.push(data.connection);applyModel(data.model);renderConnections(data.connection.id);$('connection-dialog').close();$('connection-form').reset();$('ca-field').hidden=true;notify(`Connected to ${data.connection.database}.`);
  }catch(error){$('connection-error').textContent=error.message;$('connection-error').hidden=false;}
  finally{if(payload)payload.password='';state.busy=false;$('submit-connection').disabled=false;$('submit-connection').textContent='Connect & explore';}
});
$('disconnect').addEventListener('click',async()=>{
  if(state.busy||state.sqlBusy||!isLive())return;state.busy=true;const id=state.model.repository.id;
  try{const response=await fetch(`/api/connections/${id}/disconnect`,{method:'POST',headers:{'X-Atlas-CSRF':state.session.csrf}});const data=await response.json();if(!response.ok)throw new Error(data.error);updateConnectionState(data);disconnected();renderConnections('');notify(data.warning||'Disconnected. Saved profiles are still available in the dropdown.');}
  catch(error){$('error').textContent=error.message;$('error').hidden=false;}
  finally{state.busy=false;}
});
$('schema-filter').addEventListener('change',filterDiagram);

function showScreen(screen){
  if(state.screen===screen)return;
  if(state.fullscreen)setFullscreen(false);
  sqlWorkspace.setFullscreen(false);profilingWorkspace.hide();state.screen=screen;
  const sql=screen==='sql',profiling=screen==='profiling',schema=screen==='schema';
  $('workspace').hidden=!schema;$('query-workspace').hidden=!sql;$('profiling-workspace').hidden=!profiling;document.querySelector('.stats').hidden=!schema||state.view==='relations';
  document.body.classList.toggle('profiling-screen',profiling);
  $('diagram-nav').classList.toggle('active',schema);$('query-nav').classList.toggle('active',sql);$('profiling-nav').classList.toggle('active',profiling);
  $('refresh').hidden=profiling;$('export').hidden=profiling;
  document.querySelector('.heading .eyebrow').textContent=profiling?'QUERY PROFILING':sql?'SQL WORKSPACE':'SCHEMA EXPLORER';
  document.querySelector('.heading h1').textContent=profiling?'Understand the work behind your query.':sql?'A closer look at your data.':'Your database, clearly.';
  document.querySelector('.heading p').textContent=profiling?'Measure a workflow, inspect index usage, and compare changes.':sql?'Write SQL, explore results, and follow your questions.':'Explore relationships. Inspect the details. Stay in sync with your database.';
  if(profiling)profilingWorkspace.open();else if(schema)requestAnimationFrame(transform);
}
function queryBusy(busy){
  state.sqlBusy=busy;
  $('repository').disabled=busy||!connectionInventory().length;$('disconnect').disabled=busy;
  $('refresh').disabled=busy||!state.model;$('connect-sidebar').disabled=busy;$('manage-connections').disabled=busy;$('save-connection').disabled=busy||!state.session?.storage?.available;
}
const profilingWorkspace=createProfilingWorkspace({el,getSession:()=>state.session,canRun:()=>!state.busy&&!state.sqlBusy,notify,onBusy:queryBusy,onConnect:openConnection,onInspect:id=>{showScreen('schema');selectTable(id,true);}});
$('profiling-nav').addEventListener('click',()=>showScreen('profiling'));
const sqlWorkspace=createQueryWorkspace({el,getSession:()=>state.session,canRun:()=>!state.busy&&!state.sqlBusy,notify,onOpen:()=>showScreen('sql'),onBusy:queryBusy});
$('query-nav').addEventListener('click',()=>showScreen('sql'));
$('query-connect').addEventListener('click',()=>{sqlWorkspace.setFullscreen(false);openConnection();});

async function boot(){
  try{
    const res=await fetch('/api/session');if(!res.ok)throw new Error('The local server is unavailable.');state.session=await res.json();
    const selected=state.session.selectedProfileId||state.session.connections[0]?.id||'';
    renderConnections(selected);if(selected)await refresh();else disconnected();
    if(state.session.storage&&!state.session.storage.available){$('error').textContent=state.session.storage.message;$('error').hidden=false;}
  }catch(error){$('error').textContent=error.message;$('error').hidden=false;}
}
boot();
