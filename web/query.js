const $=id=>document.getElementById(id);
const commonTypes={19:'name',16:'boolean',17:'bytea',20:'bigint',21:'smallint',23:'integer',25:'text',26:'oid',114:'json',700:'real',701:'double precision',1042:'char',1043:'varchar',1082:'date',1083:'time',1114:'timestamp',1184:'timestamptz',1186:'interval',1700:'numeric',2950:'uuid',3802:'jsonb'};
const PAGE_SIZE=100;
const quoteIdentifier=value=>'"'+value.replaceAll('"','""')+'"';

// Lightweight lexical context for suggestions only; PostgreSQL still parses SQL.
// Comments and values never become identifier candidates.
function completionTokens(sql){
  const tokens=[];let i=0;
  const word=/[a-zA-Z_0-9$\u0080-\uffff]/;
  while(i<sql.length){
    if(/\s/.test(sql[i])){i++;continue;}
    const start=i;
    if(sql.startsWith('--',i)){const end=sql.indexOf('\n',i);i=end<0?sql.length:end;tokens.push({kind:'comment',start,end:i,open:end<0});continue;}
    if(sql.startsWith('/*',i)){
      i+=2;let depth=1;
      while(i<sql.length&&depth){if(sql.startsWith('/*',i)){depth++;i+=2;}else if(sql.startsWith('*/',i)){depth--;i+=2;}else i++;}
      tokens.push({kind:'comment',start,end:i,open:depth>0});continue;
    }
    const dollar=sql[i]==='$'?sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/)?.[0]:null;
    if(dollar){const end=sql.indexOf(dollar,i+dollar.length);i=end<0?sql.length:end+dollar.length;tokens.push({kind:'literal',start,end:i,open:end<0});continue;}
    if(sql[i]==="'"||sql[i]==='"'){
      const quote=sql[i++],kind=quote==='"'?'identifier':'literal';let open=true;
      const escaped=quote==="'"&&/[eE]/.test(sql[start-1]||'')&&(start<2||!word.test(sql[start-2]));
      while(i<sql.length){
        if(escaped&&sql[i]==='\\'){i+=Math.min(2,sql.length-i);continue;}
        if(sql[i]===quote){if(sql[i+1]===quote){i+=2;continue;}i++;open=false;break;}i++;
      }
      tokens.push({kind,start,end:i,open});continue;
    }
    if(word.test(sql[i])){while(i<sql.length&&word.test(sql[i]))i++;tokens.push({kind:'word',start,end:i});continue;}
    i++;tokens.push({kind:sql[start],start,end:i});
  }
  return tokens;
}
const identifierPart=text=>text.startsWith('"')?text.slice(1).replace(/"$/,'').replaceAll('""','"'):text;
export function tableCompletions(sql,caret,selectionEnd,tables,force=false){
  if(typeof sql!=='string'||sql.length>32000||caret!==selectionEnd||caret<0||caret>sql.length)return null;
  const tokens=completionTokens(sql);
  if(tokens.some(t=>['comment','literal'].includes(t.kind)&&caret>t.start&&(caret<t.end||caret===t.end&&t.open)))return null;
  const before=tokens.filter(t=>t.start<caret&&t.kind!=='comment');
  let last=before.at(-1),from=caret,to=caret,parts=[];
  if(last&&['word','identifier'].includes(last.kind)&&last.end>=caret){
    from=last.start;to=last.end;parts.unshift(identifierPart(sql.slice(last.start,caret)));before.pop();
  }else parts.push('');
  // Include the schema and replace a suffix after the caret, not only typed text.
  if(before.at(-1)?.kind==='.'){
    const dot=before.pop(),schema=before.pop();
    if(!schema||!['word','identifier'].includes(schema.kind))return null;
    parts.unshift(identifierPart(sql.slice(schema.start,schema.end)));from=schema.start;
    if(to===caret){const suffix=tokens.find(t=>t.start===caret&&['word','identifier'].includes(t.kind));if(suffix)to=suffix.end;}
    if(before.at(-1)?.kind==='.'||dot.end>caret)return null;
  }
  const previous=before.at(-1),previousWord=previous?.kind==='word'?sql.slice(previous.start,previous.end).toUpperCase():'';
  let context=['FROM','JOIN','TABLE'].includes(previousWord);
  if(['ONLY','LATERAL'].includes(previousWord)){const parent=before.at(-2);context=parent?.kind==='word'&&/^(FROM|JOIN)$/i.test(sql.slice(parent.start,parent.end));}
  if(previous?.kind===','){
    const scopes=[false];
    for(const token of before){
      if(token.kind==='(')scopes.push(false);else if(token.kind===')'){if(scopes.length>1)scopes.pop();}
      else if(token.kind===';')scopes[scopes.length-1]=false;
      else if(token.kind==='word'){
        const keyword=sql.slice(token.start,token.end).toUpperCase();
        if(['FROM','JOIN'].includes(keyword))scopes[scopes.length-1]=true;
        else if(['SELECT','WHERE','ON','GROUP','ORDER','HAVING','LIMIT','OFFSET','UNION','EXCEPT','INTERSECT','RETURNING'].includes(keyword))scopes[scopes.length-1]=false;
      }
    }
    context=scopes.at(-1);
  }
  if(!force&&!context)return null;
  const needle=parts.at(-1).toLowerCase(),schema=parts.length===2?parts[0].toLowerCase():null;
  const matches=tables.filter(t=>typeof t.name==='string'&&typeof t.prefix==='string'&&(!schema||t.prefix.toLowerCase()===schema)).map(t=>{
    const name=t.name.toLowerCase(),qualified=(t.prefix+'.'+t.name).toLowerCase();
    const rank=name.startsWith(needle)?0:!schema&&qualified.startsWith(needle)?1:name.includes(needle)?2:!schema&&qualified.includes(needle)?3:4;
    return {table:t,rank,label:t.prefix+'.'+t.name,insert:quoteIdentifier(t.prefix)+'.'+quoteIdentifier(t.name)};
  }).filter(t=>t.rank<4).sort((a,b)=>a.rank-b.rank||a.label.localeCompare(b.label));
  return {from,to,total:matches.length,items:matches.slice(0,12)};
}

export function createQueryWorkspace({el,getSession,canRun,onBusy,onOpen,notify}){
  let connection=null,busy=false,active=null,page=0,result=null,fullscreen=false,runStarted=0,tables=[];
  let completion=null,completionIndex=0,completionForced=false,composing=false;
  const drafts=new Map(),history=new Map();
  const editor=$('sql-editor'),popup=el('div',{id:'sql-completions',class:'sql-completions',hidden:true}),
    options=el('div',{id:'sql-completion-list',role:'listbox','aria-label':'Database tables'}),
    completionStatus=el('div',{class:'sr-only',role:'status','aria-live':'polite'});
  popup.append(options);$('query-workspace').append(popup,completionStatus);
  editor.setAttribute('aria-autocomplete','list');editor.setAttribute('aria-controls','sql-completion-list');
  editor.setAttribute('aria-expanded','false');
  function hideCompletions(){
    popup.hidden=true;completion=null;completionForced=false;editor.setAttribute('aria-expanded','false');editor.removeAttribute('aria-activedescendant');completionStatus.textContent='';
  }
  function positionCompletions(){
    if(popup.hidden)return;
    const area=$('query-workspace').getBoundingClientRect(),rect=editor.getBoundingClientRect(),style=getComputedStyle(editor);
    const prefix=editor.value.slice(0,editor.selectionStart).split('\n'),line=prefix.at(-1);
    const measure=document.createElement('canvas').getContext('2d');measure.font=style.font;
    const x=rect.left-area.left+measure.measureText(line.replaceAll('\t','  ')).width-editor.scrollLeft;
    const y=rect.top-area.top+prefix.length*parseFloat(style.lineHeight)-editor.scrollTop;
    popup.style.left=Math.max(8,Math.min(x,area.width-popup.offsetWidth-8))+'px';
    popup.style.top=Math.max(8,Math.min(y+4,area.height-popup.offsetHeight-8))+'px';
  }
  function highlightCompletion(){
    [...options.children].forEach((option,i)=>option.setAttribute('aria-selected',String(i===completionIndex)));
    const selected=options.children[completionIndex];
    if(selected){editor.setAttribute('aria-activedescendant',selected.id);selected.scrollIntoView({block:'nearest'});}
  }
  function updateCompletions(force=false){
    if(!connection||busy||composing||document.activeElement!==editor){hideCompletions();return;}
    const next=tableCompletions(editor.value,editor.selectionStart,editor.selectionEnd,tables,force);
    if(!next||(!next.items.length&&!force)){hideCompletions();return;}
    completion=next;completionIndex=0;completionForced=force;options.replaceChildren();editor.removeAttribute('aria-activedescendant');
    for(const [i,item]of next.items.entries()){
      const option=el('div',{id:'sql-completion-'+i,role:'option','aria-selected':String(i===0),class:'sql-completion-option',onpointerdown:e=>e.preventDefault(),onclick:()=>acceptCompletion(i)},
        el('span',{class:'completion-icon','aria-hidden':'true'},'▦'),el('code',{},item.label),el('small',{},item.table.kind||'table'));
      options.append(option);
    }
    popup.querySelector('.completion-footer')?.remove();
    popup.append(el('div',{class:'completion-footer'},next.total?next.total+' matches · ↑↓ navigate · Tab / Enter insert':'No matching tables in this database'));
    popup.hidden=false;editor.setAttribute('aria-expanded','true');highlightCompletion();positionCompletions();
    completionStatus.textContent=next.total?next.total+' table suggestions. Use arrow keys, then Tab or Enter.':'No matching tables.';
  }
  function acceptCompletion(index=completionIndex){
    const item=completion?.items[index];if(!item)return;
    if(editor.value.length-(completion.to-completion.from)+item.insert.length>editor.maxLength){hideCompletions();notify('The editor has reached its size limit.');return;}
    editor.setRangeText(item.insert,completion.from,completion.to,'end');hideCompletions();lines();controls();editor.focus();
  }
  const initialSQL='SELECT\n  current_database() AS database,\n  current_user AS connected_as,\n  now() AS server_time;';
  function lines(){$('sql-lines').textContent=Array.from({length:$('sql-editor').value.split('\n').length},(_,i)=>i+1).join('\n');$('sql-lines').scrollTop=$('sql-editor').scrollTop;}
  function controls(){
    $('query-run').disabled=busy||!connection||!$('sql-editor').value.trim();
    $('query-run').textContent=busy?'Running…':'▶ Run query';$('query-cancel').hidden=!busy;
    for(const id of ['query-limit','query-timeout','query-clear-history','query-history-toggle'])$(id).disabled=busy||!connection;
    editor.disabled=!connection;editor.readOnly=busy||!connection;
    editor.placeholder=connection?'SELECT current_database(), current_user, now();':'Connect a database to write SQL.';
    $('query-connect-prompt').hidden=!!connection;
    $('query-editor-shortcuts').hidden=!connection;
    if(!connection){$('query-history').hidden=true;$('query-history-toggle').setAttribute('aria-expanded','false');}
    if(busy||!connection)hideCompletions();
  }
  function setConnection(model){
    const next=model?.capabilities.provider==='postgres'?model.repository.id:null;
    // Refresh the catalog even when the connection ID stays the same.
    tables=next?model.tables:[];hideCompletions();
    if(connection?.id===next)return;
    if(connection)drafts.set(connection.id,$('sql-editor').value);
    connection=next?{id:next,name:model.repository.name,database:model.database.name,user:model.database.username}:null;
    const liveIDs=new Set((getSession()?.connections||[]).map(c=>c.id));
    for(const id of drafts.keys())if(!liveIDs.has(id))drafts.delete(id);
    for(const id of history.keys())if(!liveIDs.has(id))history.delete(id);
    $('query-connection').textContent=connection?connection.name+' / '+connection.database+' · '+connection.user:'Connect PostgreSQL to run queries';
    $('sql-editor').value=connection?(drafts.get(next)||initialSQL):'';
    clearResult(connection?'Write SQL, or use “Query table” in the schema inspector.':'Connect a PostgreSQL database to run SQL queries.');
    $('query-execution').textContent=connection?'Ready when you are':'No database connected';lines();renderHistory();controls();
  }
  function message(text,kind=''){
    $('query-message').textContent=text;$('query-message').className='query-message'+(kind?' is-'+kind:'');$('query-message').hidden=!text;
  }
  function clearResult(text){
    result=null;page=0;$('query-row-dialog').close();$('query-row-values').replaceChildren();$('query-results').replaceChildren();$('query-results').hidden=true;$('query-row-count').textContent='';
    $('query-export').disabled=true;$('query-prev').disabled=true;$('query-next').disabled=true;$('query-page').textContent='0 rows';
    $('query-result-info').textContent='Results and query history stay in this browser tab.';message(text);
  }
  function showRow(row,number){
    $('query-row-title').textContent='Row '+number;
    $('query-row-summary').textContent=result.columns.length+' columns · '+connection.database;
    const fields=$('query-row-values');fields.replaceChildren();
    result.columns.forEach((column,i)=>{
      fields.append(el('section',{class:'row-field'},
        el('div',{class:'row-field-heading'},el('h3',{},column.name),el('span',{},commonTypes[column.typeOID]||'type OID '+column.typeOID)),
        el('pre',{class:row[i]===null?'null-value':''},row[i]===null?'NULL':row[i]===''?'(empty string)':row[i])));
    });
    $('query-row-dialog').showModal();
  }
  function renderRows(){
    const table=el('table',{class:'result-table'}),head=el('tr',{},el('th',{class:'row-number',scope:'col'},'#'));
    for(const col of result.columns)head.append(el('th',{scope:'col'},col.name,el('small',{},commonTypes[col.typeOID]||'type OID '+col.typeOID)));
    table.append(el('thead',{},head));const body=el('tbody');
    for(const [offset,row]of result.rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).entries()){
      const rowNumber=page*PAGE_SIZE+offset+1;
      const tr=el('tr',{onclick:()=>showRow(row,rowNumber)},el('td',{class:'row-number'},String(rowNumber)));
      row.forEach(value=>{
        const cell=el('button',{class:'result-cell'+(value===null?' null-value':''),title:'Open entire row · Row '+rowNumber},
          value===null?'NULL':value===''?'(empty string)':value.length>250?value.slice(0,250)+'…':value);
        tr.append(el('td',{},cell));
      });body.append(tr);
    }
    table.append(body);$('query-results').replaceChildren(table);$('query-results').hidden=!result.columns.length;$('query-results').scrollTop=0;
    $('query-page').textContent=result.rows.length?(page*PAGE_SIZE+1)+'–'+Math.min((page+1)*PAGE_SIZE,result.rows.length)+' of '+result.rows.length:'0 rows';
    $('query-prev').disabled=page===0;$('query-next').disabled=(page+1)*PAGE_SIZE>=result.rows.length;
  }
  function renderHistory(){
    const list=$('query-history-list');list.replaceChildren();const entries=history.get(connection?.id)||[];
    if(!entries.length)list.append(el('p',{class:'muted-note'},'No queries run for this connection in this tab.'));
    for(const entry of entries){
      const b=el('button',{class:'history-entry',onclick:()=>{if(busy)return;$('sql-editor').value=entry.sql;lines();controls();$('sql-editor').focus();}},el('code',{},entry.sql),el('span',{},entry.time+' · '+entry.status+' · '+entry.ms+' ms'));
      b.disabled=busy;list.append(b);
    }
  }
  async function run(){
    if(busy||!connection)return;if(!canRun()){notify('Wait for the connection or schema refresh to finish.');return;}const editor=$('sql-editor'),selected=editor.selectionEnd>editor.selectionStart;
    const sql=(selected?editor.value.slice(editor.selectionStart,editor.selectionEnd):editor.value).trim();if(!sql)return;
    const owner=connection,queryID=crypto.randomUUID().replaceAll('-',''),endpoint='/api/connections/'+owner.id+'/queries/'+queryID;
    busy=true;active={endpoint,owner};onBusy(true);controls();renderHistory();clearResult('');
    runStarted=performance.now();$('query-execution').textContent=selected?'Running selection…':'Running query…';
    const tick=setInterval(()=>{$('query-execution').textContent='Running · '+((performance.now()-runStarted)/1000).toFixed(1)+' s';},250);
    let status='Error';
    try{
      const response=await fetch(endpoint+'/run',{method:'POST',headers:{'Content-Type':'application/json','X-Atlas-CSRF':getSession().csrf},body:JSON.stringify({sql,limit:Number($('query-limit').value),timeout:Number($('query-timeout').value)})});
      const data=await response.json();
      if(!response.ok){
        let detail=data.error||'Could not execute the query.';
        if(data.sqlState)detail+=' · SQLSTATE '+data.sqlState;if(data.position)detail+=' · Character '+data.position;
        throw Object.assign(new Error(detail),{code:data.code});
      }
      result=data;page=0;status='Success';renderRows();$('query-export').disabled=false;$('query-row-count').textContent=data.rows.length+(data.rows.length===1?' row':' rows');
      $('query-result-info').textContent=owner.database+' · '+data.milliseconds+' ms · Read-only · Click a row for all its values';
      if(data.truncated)message('Showing the first '+data.rows.length+' rows ('+data.reason+'). Refine the query or increase the row limit to see more.','warning');
      else if(!data.rows.length)message(data.columns.length?'Query completed. No rows matched.':'Statement completed successfully.');
      $('query-execution').textContent='Completed in '+data.milliseconds+' ms';
    }catch(error){
      status=error.code==='CANCELLED'?'Cancelled':'Error';message(error.message||'The local server could not be reached.','error');$('query-execution').textContent=status;
    }finally{
      clearInterval(tick);const entries=history.get(owner.id)||[];
      entries.unshift({sql,status,time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),ms:Math.round(performance.now()-runStarted)});history.set(owner.id,entries.slice(0,20));
      busy=false;active=null;onBusy(false);controls();renderHistory();$('query-cancel').disabled=false;
    }
  }
  async function cancel(){
    if(!active)return;const target=active;$('query-cancel').disabled=true;
    try{
      const response=await fetch(target.endpoint+'/cancel',{method:'POST',headers:{'X-Atlas-CSRF':getSession().csrf}});
      if(!response.ok&&response.status!==404)throw new Error('Could not cancel. The timeout will still apply.');
      if(response.status===404&&active===target)notify('The query has not started or has already completed. Try Cancel again if it is still running.');
    }catch(error){notify(error.message);}finally{$('query-cancel').disabled=false;}
  }
  function setFullscreen(enabled){
    fullscreen=enabled;$('query-workspace').classList.toggle('is-fullscreen',enabled);
    $('query-fullscreen').textContent=enabled?'⛶ Exit full screen':'⛶ Full screen';$('query-fullscreen').setAttribute('aria-pressed',String(enabled));
    for(const selector of ['.sidebar','.topbar','.heading','.stats','#error'])document.querySelector(selector).inert=enabled;
    document.body.classList.toggle('diagram-fullscreen',enabled);
  }
  $('sql-editor').addEventListener('input',()=>{lines();controls();});
  editor.addEventListener('input',()=>updateCompletions(completionForced));
  editor.addEventListener('click',()=>updateCompletions());
  editor.addEventListener('blur',hideCompletions);
  editor.addEventListener('compositionstart',()=>{composing=true;hideCompletions();});
  editor.addEventListener('compositionend',()=>{composing=false;updateCompletions();});
  editor.addEventListener('scroll',hideCompletions);
  new ResizeObserver(hideCompletions).observe(editor);
  document.addEventListener('pointerdown',e=>{if(e.target!==editor&&!popup.contains(e.target))hideCompletions();});
  $('sql-editor').addEventListener('scroll',()=>{$('sql-lines').scrollTop=$('sql-editor').scrollTop;});
  $('sql-editor').addEventListener('keydown',e=>{
    if(e.isComposing||editor.disabled||editor.readOnly)return;
    if(e.ctrlKey&&e.code==='Space'){e.preventDefault();updateCompletions(true);return;}
    if(!popup.hidden){
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();hideCompletions();return;}
      if(['ArrowDown','ArrowUp'].includes(e.key)&&completion.items.length){e.preventDefault();completionIndex=(completionIndex+(e.key==='ArrowDown'?1:-1)+completion.items.length)%completion.items.length;highlightCompletion();return;}
      if(['Enter','Tab'].includes(e.key)&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&completion.items.length){e.preventDefault();acceptCompletion();return;}
      if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(e.key))hideCompletions();
    }
    if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();void run();}
    if(e.key==='Tab'&&!busy){e.preventDefault();const editor=$('sql-editor');editor.setRangeText('  ',editor.selectionStart,editor.selectionEnd,'end');lines();controls();}
  });
  $('query-run').addEventListener('click',run);$('query-cancel').addEventListener('click',cancel);
  $('query-prev').addEventListener('click',()=>{if(page>0){page--;renderRows();}});
  $('query-next').addEventListener('click',()=>{if(result&&(page+1)*PAGE_SIZE<result.rows.length){page++;renderRows();}});
  $('query-history-toggle').addEventListener('click',()=>{$('query-history').hidden=!$('query-history').hidden;$('query-history-toggle').setAttribute('aria-expanded',String(!$('query-history').hidden));renderHistory();});
  $('query-clear-history').addEventListener('click',()=>{history.delete(connection?.id);renderHistory();});
  $('query-row-close').addEventListener('click',()=>$('query-row-dialog').close());
  $('query-fullscreen').addEventListener('click',()=>setFullscreen(!fullscreen));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&fullscreen&&!document.querySelector('dialog[open]')){setFullscreen(false);$('query-fullscreen').focus();}});
  $('query-export').addEventListener('click',()=>{
    if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
    el('a',{href:url,download:'schema-atlas-query.json'}).click();setTimeout(()=>URL.revokeObjectURL(url),5000);
  });
  return {setConnection,setFullscreen,isBusy:()=>busy,table(t){
    if(busy){notify('Wait for the current query or cancel it first.');return;}if(!connection)return;
    $('sql-editor').value='SELECT *\nFROM '+quoteIdentifier(t.prefix)+'.'+quoteIdentifier(t.name)+'\nLIMIT 100;';
    lines();controls();onOpen();$('sql-editor').focus();
  }};
}
