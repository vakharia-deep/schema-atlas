export const LOG_LIMITS=Object.freeze({bytes:2*1024*1024,lines:20000,records:500,sqlBytes:30000,outputBytes:1024*1024});
const encoder=new TextEncoder();
function shallowJSON(line){
  let depth=0,quoted=false,escaped=false;
  for(const c of line){
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
    else if(c==='"')quoted=true;
    else if(c==='{'||c==='['){if(++depth>16)throw new Error('Log record is too deeply nested.');}
    else if(c==='}'||c===']')depth--;
  }
  const value=JSON.parse(line);
  if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('Expected a log object.');
  return value;
}
const field=value=>typeof value==='string'?value.slice(0,256):'';

export function parseSlowLogs(input,database){
  if(typeof input!=='string'||input.length>LOG_LIMITS.bytes||encoder.encode(input).length>LOG_LIMITS.bytes||input.includes('\0'))throw new Error('Use a UTF-8 log file no larger than 2 MB.');
  if(typeof database!=='string'||!database||database.length>256)throw new Error('Select a database before importing logs.');
  const rows=[],warnings=[],counts={otherDatabase:0,invalid:0,unsupported:0,unscoped:0};
  let outputBytes=0,limited=false,pending=null;
  function add(message,metadata={}){
    if(typeof message!=='string')return;
    const match=message.match(/^duration:\s+([0-9]{1,12}(?:\.[0-9]{1,9})?)\s+ms\s+(?:statement:|execute [^:\r\n]{1,256}:)\s*([\s\S]*)$/);
    if(!match){if(/^duration:/.test(message))counts.unsupported++;return;}
    const sql=match[2].trim(),durationMs=Number(match[1]);
    if(!sql||encoder.encode(sql).length>LOG_LIMITS.sqlBytes||!Number.isFinite(durationMs)){counts.invalid++;return;}
    if(metadata.database&&metadata.database!==database){counts.otherDatabase++;return;}
    const row={sql,durationMs,timestamp:metadata.timestamp||'',database:metadata.database||'',user:metadata.user||'',application:metadata.application||'',format:metadata.format||'text'};
    const bytes=encoder.encode(JSON.stringify(row)).length;
    // Leave room for array separators, counters and limit messages in the worker response.
    if(rows.length>=LOG_LIMITS.records||outputBytes+bytes+1>LOG_LIMITS.outputBytes-4096){limited=true;return;}
    outputBytes+=bytes+1;rows.push(row);if(!row.database)counts.unscoped++;
  }
  function flush(){if(pending){add(pending.message,pending.metadata);pending=null;}}
  const lines=input.replace(/^\uFEFF/,'').split(/\r?\n/);
  if(lines.length>LOG_LIMITS.lines)limited=true;
  for(const line of lines.slice(0,LOG_LIMITS.lines)){
    if(!line.trim())continue;
    if(line.length>65536){flush();counts.invalid++;continue;}
    // PostgreSQL stderr continuation lines start with a tab. Never treat SQL inside one as a log header.
    if(line.startsWith('\t')){
      if(pending){if(pending.message.length+line.length>LOG_LIMITS.sqlBytes){pending=null;counts.invalid++;}else pending.message+='\n'+line.slice(1);}
      continue;
    }
    flush();
    if(line.trimStart().startsWith('{')){
      try{
        const log=shallowJSON(line);
        if(typeof log.message!=='string'){counts.invalid++;continue;}
        if(log.dbname!=null&&typeof log.dbname!=='string'){counts.invalid++;continue;}
        add(log.message,{database:field(log.dbname),timestamp:field(log.timestamp),user:field(log.user),application:field(log.application_name),format:'json'});
      }catch{counts.invalid++;}
    }else{
      const marker=line.indexOf('LOG:');
      const message=(marker>=0?line.slice(marker+4):line).trimStart();
      if(message.startsWith('duration:'))pending={message,metadata:{format:'text'}};
    }
  }
  flush();
  if(limited)warnings.push('Import limit reached: up to 20,000 lines, 500 executions and 1 MB of results. Export a smaller time window; this list is incomplete.');
  if(counts.invalid)warnings.push(`${counts.invalid} malformed, oversized or incomplete ${counts.invalid===1?'record was':'records were'} skipped.`);
  if(counts.unsupported)warnings.push(`${counts.unsupported} duration ${counts.unsupported===1?'record':'records'} lacked supported statement/execute SQL. Parse, bind, duration-only and auto_explain records are not imported.`);
  if(counts.otherDatabase)warnings.push(`${counts.otherDatabase} ${counts.otherDatabase===1?'execution from another database was':'executions from other databases were'} excluded.`);
  if(counts.unscoped)warnings.push(`${counts.unscoped} ${counts.unscoped===1?'execution has':'executions have'} no verifiable database field. Confirm they belong to the selected database before profiling.`);
  return {rows:rows.sort((a,b)=>b.durationMs-a.durationMs),warnings,counts};
}

export function importSlowLogFile(file,database){
  if(!file||!Number.isInteger(file.size)||file.size<=0||file.size>LOG_LIMITS.bytes)return Promise.reject(new Error('Choose a non-empty log file up to 2 MB.'));
  if(!/\.(json|jsonl|ndjson|log|txt)$/i.test(file.name)||!['','application/octet-stream','application/json','application/x-ndjson','application/jsonl','text/plain'].includes(file.type))return Promise.reject(new Error('Choose a PostgreSQL JSON-lines or plain-text log (.json, .jsonl, .ndjson, .log or .txt).'));
  return new Promise((resolve,reject)=>{
    // File bytes stay in this browser. A disposable worker keeps parsing off the UI thread.
    const worker=new Worker(new URL('./slow-logs-worker.js',import.meta.url),{type:'module'});
    const finish=(error,result)=>{clearTimeout(timer);worker.terminate();error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(new Error('Log import took too long. Choose a smaller file.')),3000);
    worker.onmessage=event=>event.data.error?finish(new Error(event.data.error)):finish(null,event.data.result);
    worker.onerror=()=>finish(new Error('Could not read this log. Use a UTF-8 PostgreSQL JSON-lines or plain-text file.'));
    worker.postMessage({file,database});
  });
}
