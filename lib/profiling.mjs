import { randomBytes } from 'node:crypto';
import { AtlasError } from './postgres.mjs';
import { QueryJob, validateQuery } from './query.mjs';
import { normalizePlan } from '../web/plan.js';

export const PROFILING_LIMITS=Object.freeze({statements:500,logBytes:512*1024,captures:100,windowMs:30*60_000});
const ident=s=>'"'+s.replaceAll('"','""')+'"';
const number=x=>Number.isFinite(Number(x))?Number(x):0;
export function validateProfile(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['sql','parameters','analyze','timeout'].includes(k)))throw new AtlasError('INPUT','Provide SQL, parameters, analyze and timeout.');
  const {sql,timeout=15000}=validateQuery({sql:input.sql,timeout:input.timeout,limit:1});
  const parameters=input.parameters??[],analyze=input.analyze??false;
  if(typeof analyze!=='boolean'||!Array.isArray(parameters)||parameters.length>64||Buffer.byteLength(JSON.stringify(parameters))>16000||parameters.some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)||typeof v==='string'&&(v.length>4000||v.includes('\0'))))throw new AtlasError('INPUT','Parameters must be a JSON array of up to 64 scalar values (16 KB total).');
  return {sql,timeout,parameters,analyze};
}
export function workloadDiff(before,after){
  const warnings=[];
  if(before.reset!==after.reset){return {rows:[],warnings:['Query statistics were reset during this session. Start a new capture for a valid comparison.']};}
  if(before.dealloc!==after.dealloc)warnings.push('Statement entries were evicted during capture. Some query activity may be missing.');
  if(before.truncated||after.truncated)warnings.push('Only the first 500 statement patterns were captured. Results are incomplete.');
  const old=new Map(before.rows.map(r=>[r.key,r])),rows=[];
  for(const r of after.rows){
    const prev=old.get(r.key),calls=number(r.calls)-number(prev?.calls);
    if(calls<0||prev&&number(r.totalMs)<number(prev.totalMs)){warnings.push('A statement counter decreased; that statement was excluded.');continue;}
    if(!calls)continue;
    const delta=k=>Math.max(0,number(r[k])-number(prev?.[k]));
    rows.push({...r,calls,totalMs:delta('totalMs'),meanMs:delta('totalMs')/calls,rows:delta('rows'),hits:delta('hits'),reads:delta('reads'),tempWritten:delta('tempWritten')});
  }
  return {rows:rows.sort((a,b)=>b.totalMs-a.totalMs),warnings:[...new Set(warnings)]};
}
export function parseCapturedLogs(text,database,user,allUsers){
  const plans=[],warnings=[];let rejected=0;
  const lines=text.split('\n');
  if(lines.length>2500)warnings.push('Log record limit reached (2,500). Use a shorter session.');
  for(const line of lines.slice(0,2500)){
    if(!line.trim())continue;
    let log;try{log=JSON.parse(line);}catch{rejected++;continue;}
    if(log.dbname!==database||!allUsers&&log.user!==user||typeof log.application_name==='string'&&log.application_name.startsWith('schema-atlas'))continue;
    const duration=typeof log.message==='string'&&log.message.match(/^duration: ([\d.]+) ms\s+plan:\s*\{/);
    if(!duration)continue;
    try{
      const raw=JSON.parse(log.message.slice(log.message.indexOf('{'))),result=normalizePlan(raw);
      plans.push({...result,executionMs:result.executionMs??(Number.isFinite(Number(duration[1]))?Number(duration[1]):null),id:randomBytes(12).toString('hex'),source:'application',sql:result.query||'',capturedAt:String(log.timestamp||'').slice(0,100),application:String(log.application_name||'Unknown application').slice(0,200),user:String(log.user||'').slice(0,128)});
      if(plans.length>=PROFILING_LIMITS.captures){warnings.push('Captured plan limit reached (100). Use a shorter session.');break;}
    }catch{rejected++;}
  }
  if(rejected)warnings.push('Some log records were incomplete or unsupported and were skipped.');
  return {plans,warnings};
}

export class ProfilingJob {
  constructor(config){this.config=config;this.current=null;this.stopped=false;}
  stop(){this.stopped=true;return this.current?.stop()??true;}
  async query(sql,parameters=[],limit=1000){
    if(this.stopped)throw new AtlasError('CANCELLED','Profiling cancelled.',409);
    this.current=new QueryJob(this.config,{sql:'/* schema_atlas_profiler_marker */ '+sql,limit,timeout:10000},{parameters,applicationName:'schema-atlas-profiler'});
    const result=await this.current.run();
    if(result.truncated)throw new AtlasError('RESULT_LIMIT','Profiling response exceeded its size limit. Use a shorter capture.',413);
    return result.rows.map(r=>Object.fromEntries(result.columns.map((c,i)=>[c.name,r[i]])));
  }
  async diagnostics(){
    const [r]=await this.query(`SELECT current_database() AS database,current_user AS username,
      (SELECT setting FROM pg_catalog.pg_settings WHERE name='server_version') AS version,(SELECT setting FROM pg_catalog.pg_settings WHERE name='server_version_num') AS version_num,
      (SELECT setting FROM pg_catalog.pg_settings WHERE name='shared_preload_libraries') AS preload,(SELECT setting FROM pg_catalog.pg_settings WHERE name='session_preload_libraries') AS session_preload,
      (SELECT setting FROM pg_catalog.pg_settings WHERE name='logging_collector') AS collector,(SELECT setting FROM pg_catalog.pg_settings WHERE name='log_destination') AS destination,
      (SELECT setting FROM pg_catalog.pg_settings WHERE name='auto_explain.log_min_duration') AS log_min_duration,(SELECT setting FROM pg_catalog.pg_settings WHERE name='auto_explain.log_format') AS log_format,
      (SELECT setting FROM pg_catalog.pg_settings WHERE name='auto_explain.log_analyze') AS log_analyze,
      (SELECT n.nspname FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_stat_statements') AS extension_schema,
      pg_catalog.pg_has_role(current_user,'pg_read_all_stats','MEMBER') AS all_stats,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser,
      pg_catalog.pg_has_role(current_user,'pg_read_server_files','MEMBER') AS read_files,
      (SELECT stats_reset::text FROM pg_catalog.pg_stat_database WHERE datname=current_database()) AS database_reset`);
    const statistics={available:false,message:'Enable pg_stat_statements and restart PostgreSQL, then install the extension in this database.'};
    if(r.extension_schema){try{await this.query(`SELECT 1 FROM ${ident(r.extension_schema)}.pg_stat_statements LIMIT 1`);statistics.available=true;statistics.message='Query pattern statistics are available.';}catch{statistics.message='The extension exists, but statistics are unavailable. Check preload configuration and permissions.';}}
    const allUsers=r.superuser==='t'||r.all_stats==='t',canRead=r.superuser==='t'||r.read_files==='t';
    let log=null;
    if(number(r.version_num)>=150000&&r.collector==='on'&&(r.destination||'').split(',').map(s=>s.trim()).includes('jsonlog')&&canRead){
      try{const [f]=await this.query("SELECT pg_catalog.pg_current_logfile('jsonlog') AS path");if(f.path){const [s]=await this.query('SELECT size::text FROM pg_catalog.pg_stat_file($1)',[f.path]);log={path:f.path,offset:Number(s.size)};}}catch{/* A capability diagnostic must not expose server paths or raw errors. */}
    }
    const autoEnabled=r.log_min_duration!==null&&!r.log_min_duration.startsWith('-')&&r.log_format==='json'&&((r.preload||'')+','+(r.session_preload||'')).includes('auto_explain');
    return {database:r.database,user:r.username,version:r.version,allUsers,statistics,
      applicationPlans:{available:!!log&&autoEnabled,logReadable:!!log,message:!!log&&autoEnabled?'Application plan capture is ready for newly connected application sessions.':"Application plans need PostgreSQL 15+ JSON logs, auto_explain JSON output, and permission to read the active log. Reconnect the application after setup.",analyze:r.log_analyze==='on',minimumDuration:r.log_min_duration},
      internal:{schema:r.extension_schema,log,databaseReset:r.database_reset}};
  }
  async snapshot(d){
    if(!d.statistics.available)return null;
    const schema=ident(d.internal.schema);
    const data=await this.query(`SELECT (s.dbid::text||':'||s.userid::text||':'||s.queryid::text||':'||COALESCE(to_jsonb(s)->>'toplevel','true')) AS key,
      s.queryid::text AS query_id,pg_catalog.pg_get_userbyid(s.userid) AS username,pg_catalog.left(s.query,2000) AS sql,(pg_catalog.length(s.query)>2000) AS sql_truncated,s.calls::text,
      COALESCE(to_jsonb(s)->>'total_exec_time',to_jsonb(s)->>'total_time') AS total_ms,s.rows::text,
      s.shared_blks_hit::text AS hits,s.shared_blks_read::text AS reads,s.temp_blks_written::text AS temp_written
      FROM ${schema}.pg_stat_statements s WHERE s.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
      AND ($1::boolean OR s.userid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) AND s.query IS NOT NULL
      AND s.query NOT LIKE '%schema_atlas_profiler_marker%' ORDER BY s.queryid,s.userid LIMIT 501`,[d.allUsers]);
    let reset=d.internal.databaseReset,dealloc='0';
    try{const [info]=await this.query(`SELECT stats_reset::text,dealloc::text FROM ${schema}.pg_stat_statements_info`);reset=info.stats_reset;dealloc=info.dealloc;}catch{/* Older versions use database reset and per-statement counter checks. */}
    return {reset,dealloc,truncated:data.length>500,rows:data.slice(0,500).filter(r=>!r.sql.includes('schema-atlas-profiler')&&!/^(BEGIN|ROLLBACK|COMMIT)\b/i.test(r.sql)).map(r=>({key:r.key,queryID:r.query_id,user:r.username,sql:r.sql,sqlTruncated:r.sql_truncated==='t',calls:r.calls,totalMs:r.total_ms,rows:r.rows,hits:r.hits,reads:r.reads,tempWritten:r.temp_written}))};
  }
  async start(){
    const diagnostics=await this.diagnostics();
    if(!diagnostics.statistics.available&&!diagnostics.applicationPlans.available)throw new AtlasError('SETUP','Enable query statistics or application plan capture in Setup before starting a session.',409);
    const snapshot=await this.snapshot(diagnostics);
    // Log offset comes after statistics collection so our own setup queries are excluded.
    if(diagnostics.internal.log){const [f]=await this.query('SELECT size::text FROM pg_catalog.pg_stat_file($1)',[diagnostics.internal.log.path]);diagnostics.internal.log.offset=Number(f.size);}
    return {startedAt:new Date().toISOString(),snapshot,diagnostics};
  }
  async finish(capture){
    if(Date.now()-Date.parse(capture.startedAt)>PROFILING_LIMITS.windowMs)throw new AtlasError('EXPIRED','Capture exceeded 30 minutes. Start a new session.',409);
    const d=await this.diagnostics(),after=await this.snapshot(d),workload=capture.snapshot&&after?workloadDiff(capture.snapshot,after):{rows:[],warnings:['Query statistics were unavailable for this capture.']};
    const warnings=[...workload.warnings];let plans=[];
    const startLog=capture.diagnostics.internal.log,endLog=d.internal.log;
    if(capture.diagnostics.applicationPlans.available&&startLog&&endLog){
      if(startLog.path!==endLog.path||endLog.offset<startLog.offset)warnings.push('The PostgreSQL log rotated or was truncated. Application plans are incomplete; start a new capture.');
      else{
        const length=endLog.offset-startLog.offset;
        if(length>PROFILING_LIMITS.logBytes)warnings.push('Log capture exceeded 512 KB. Only the beginning of this interval is shown; use a shorter session.');
        if(length){const [raw]=await this.query("SELECT pg_catalog.encode(pg_catalog.pg_read_binary_file($1,$2::bigint,$3::bigint),'base64') AS content",[startLog.path,startLog.offset,Math.min(length,PROFILING_LIMITS.logBytes)]);const parsed=parseCapturedLogs(Buffer.from(raw.content,'base64').toString('utf8'),d.database,d.user,d.allUsers);plans=parsed.plans;warnings.push(...parsed.warnings);}
      }
    }else warnings.push('Application plans were unavailable. The workload list does not prove index usage.');
    return {startedAt:capture.startedAt,endedAt:new Date().toISOString(),rows:workload.rows,plans,warnings,scope:'All matching database activity during this window, including background jobs. Not an HTTP request trace.'};
  }
  async explain(input){
    const v=validateProfile(input),prefix=v.analyze?'EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, VERBOSE TRUE, SETTINGS TRUE, FORMAT JSON) ':'EXPLAIN (VERBOSE TRUE, SETTINGS TRUE, FORMAT JSON) ';
    this.current=new QueryJob(this.config,{sql:'/* schema_atlas_profiler_marker */ '+prefix+v.sql,limit:1,timeout:v.timeout},{parameters:v.parameters,applicationName:'schema-atlas-profiler'});
    if(this.stopped)throw new AtlasError('CANCELLED','Profiling cancelled.',409);
    const r=await this.current.run();if(r.truncated||!r.rows[0]?.[0])throw new AtlasError('PLAN','The execution plan exceeded the response limit.',413);
    let result;try{result=normalizePlan(JSON.parse(r.rows[0][0]));}catch{throw new AtlasError('PLAN','The execution plan is invalid or exceeds supported limits.',422);}
    return {...result,id:randomBytes(12).toString('hex'),source:v.analyze?'measured':'estimated',sql:v.sql,parameters:v.parameters,capturedAt:new Date().toISOString(),database:this.config.database,user:this.config.user};
  }
}
