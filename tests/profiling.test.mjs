import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ProfilingJob, validateProfile, workloadDiff, parseCapturedLogs } from '../lib/profiling.mjs';
import { normalizePlan, comparePlans } from '../web/plan.js';
import { fixture } from './helpers/postgres.mjs';
import { createApp } from '../server.mjs';
import { randomBytes } from 'node:crypto';

const raw=()=>({Plan:{'Node Type':'Index Scan','Schema':'public','Relation Name':'devices','Index Name':'devices_pkey','Plan Rows':1,'Actual Rows':2,'Actual Loops':1,'Shared Hit Blocks':4},'Execution Time':1.2});
test('profiling validates scalar parameters, explicit execution mode and SQL boundaries',()=>{
  assert.deepEqual(validateProfile({sql:'SELECT $1',parameters:['hello'],analyze:false}).parameters,['hello']);
  for(const input of [null,[],{sql:'SELECT 1',parameters:{}},{sql:'SELECT 1',parameters:[{}]},{sql:'SELECT 1',parameters:Array(65).fill(1)},{sql:'SELECT 1',analyze:'true'},{sql:'DELETE FROM t'},{sql:'SELECT 1',parameters:['a'.repeat(4001)]},{sql:'SELECT 1',timeout:90000},{sql:'SELECT 1',extra:true}])assert.throws(()=>validateProfile(input));
});
test('plan projection preserves evidence, excludes unexecuted indexes, bounds trees and escapes no data prematurely',()=>{
  const r=raw();r.Plan.Filter='<img onerror=x>';r.Plan.Plans=[{'Node Type':'Index Scan','Index Name':'never_used','Actual Rows':0,'Actual Loops':0}];
  const p=normalizePlan([r]);assert.equal(p.measured,true);assert.deepEqual(p.indexes,['devices_pkey']);assert.equal(p.plan.conditions[0].text,'<img onerror=x>');assert.equal(p.plan.totalTime,null);
  let node=r.Plan;for(let i=0;i<42;i++){node.Plans=[{'Node Type':'Result'}];node=node.Plans[0];}assert.throws(()=>normalizePlan(r));
  assert.throws(()=>normalizePlan({Plan:{'Node Type':'Result',Plans:'bad'}}));
  assert.throws(()=>normalizePlan({Plan:{'Node Type':'Result',Plans:Array.from({length:1001},()=>({'Node Type':'Result'}))}}));
});
test('plan comparisons distinguish missing metrics from zero and identify estimate/skipped-row/spill clues',()=>{
  const a=normalizePlan(raw()),r=raw();r['Execution Time']=.6;r.Plan['Actual Rows']=1000;r.Plan['Rows Removed by Filter']=100000;r.Plan['Temp Written Blocks']=10;
  const b=normalizePlan(r),comparison=comparePlans(a,b);assert.equal(comparison[0].percent,-50);assert.equal(comparison[3].delta,null);assert.equal(b.findings.length,3);
});
const row=(calls,totalMs)=>({key:'a',sql:'SELECT $1',calls:String(calls),totalMs:String(totalMs),hits:'8',reads:'1',rows:'2',tempWritten:'0'});
test('capture deltas handle new patterns, changing counts, resets and evictions without false precise history',()=>{
  const before={reset:'x',dealloc:'0',rows:[row(2,10)]},after={reset:'x',dealloc:'0',rows:[row(5,25),{...row(2,6),key:'new'}]};
  const d=workloadDiff(before,after);assert.equal(d.rows[0].calls,3);assert.equal(d.rows[0].meanMs,5);assert.equal(d.rows[1].calls,2);
  assert.equal(workloadDiff(before,{...after,reset:'y'}).rows.length,0);
  assert.match(workloadDiff(before,{...after,dealloc:'1'}).warnings[0],/evicted/);
  assert.equal(workloadDiff(before,{...after,rows:[row(1,3)]}).rows.length,0);
});
test('captured JSON logs are database/role scoped and unrelated records never enter plan output',()=>{
  const log=(dbname,user,application_name='app')=>JSON.stringify({dbname,user,application_name,message:'duration: 1.2 ms  plan:\n'+JSON.stringify({...raw(),'Query Text':'SELECT $1'})});
  const logs=[log('one','alice'),log('two','alice'),log('one','bob'),log('one','alice','schema-atlas-profiler'),'{partial'].join('\n');
  assert.equal(parseCapturedLogs(logs,'one','alice',false).plans.length,1);
  assert.equal(parseCapturedLogs(logs,'one','alice',true).plans.length,2);
  assert.equal(parseCapturedLogs(logs,'one','alice',false).warnings.length,1);
  const durationOnly=JSON.stringify({dbname:'one',user:'alice',message:'duration: 4.321 ms  plan:\n'+JSON.stringify({Plan:raw().Plan})});
  assert.equal(parseCapturedLogs(durationOnly,'one','alice',false).plans[0].executionMs,4.321);
  assert.match(parseCapturedLogs(Array(2502).fill('{}').join('\n'),'one','alice',false).warnings[0],/record limit/);
  const capped=parseCapturedLogs(Array(101).fill(log('one','alice')).join('\n'),'one','alice',false);assert.equal(capped.plans.length,100);assert.match(capped.warnings[0],/limit/);
});

test('capture reports log rotation and byte truncation instead of claiming complete plans',async()=>{
  const diagnostic=path=>({database:'one',user:'alice',allUsers:false,statistics:{available:false},applicationPlans:{available:true},internal:{log:{path,offset:600000}}});
  const capture={startedAt:new Date().toISOString(),snapshot:null,diagnostics:{...diagnostic('initial'),internal:{log:{path:'initial',offset:0}}}};
  const job=new ProfilingJob({});job.diagnostics=async()=>diagnostic('rotated');job.query=async()=>{throw new Error('Rotated log must not be read');};
  assert.match((await job.finish(capture)).warnings.join(' '),/rotated/);
  job.diagnostics=async()=>diagnostic('initial');job.query=async(sql,values)=>{assert.equal(values[2],512*1024);return [{content:Buffer.from('{partial').toString('base64')}];};
  const capped=await job.finish(capture);assert.equal(capped.plans.length,0);assert.match(capped.warnings.join(' '),/512 KB/);assert.match(capped.warnings.join(' '),/incomplete/);
});

test('real PostgreSQL captures application workload and actual index plans; compares before/after index creation',{timeout:60000},async t=>{
  const f=await fixture({profiling:true});t.after(f.cleanup);
  await f.admin.query('CREATE TABLE core.profile_items(id integer, label text); INSERT INTO core.profile_items SELECT i, md5(i::text) FROM generate_series(1,20000) i; ANALYZE core.profile_items; GRANT SELECT ON core.profile_items TO atlas_reader');
  const profiler=()=>new ProfilingJob(f.adminConfig),input={sql:'SELECT label FROM core.profile_items WHERE id=$1',parameters:[19000],analyze:true};
  const d=await profiler().diagnostics();assert.equal(d.statistics.available,true);assert.equal(d.applicationPlans.available,true);
  const before=await profiler().explain(input);assert.equal(before.measured,true);assert.deepEqual(before.indexes,[]);assert.equal(before.plan.type,'Seq Scan');
  await f.admin.query('CREATE INDEX profile_items_id_idx ON core.profile_items(id); ANALYZE core.profile_items');
  const after=await profiler().explain(input);assert.deepEqual(after.indexes,['profile_items_id_idx']);assert.ok(before.plan.hits+before.plan.reads>after.plan.hits+after.plan.reads,'index performs fewer buffer accesses');
  const planned=await profiler().explain({...input,analyze:false});assert.equal(planned.measured,false);assert.equal(planned.executionMs,null);
  const capture=await profiler().start();
  const app=new pg.Client({host:f.config.host,port:f.config.port,user:f.config.user,password:f.config.password,database:f.config.database,application_name:'profiling-integration-app'});await app.connect();
  try{for(let i=0;i<3;i++)await app.query(input.sql,input.parameters);}finally{await app.end();}
  // Wait for the real logging collector to flush; do not infer logging from configuration alone.
  let ready=false;
  for(let i=0;i<60;i++){const [s]=await profiler().query('SELECT size::text FROM pg_catalog.pg_stat_file($1)',[capture.diagnostics.internal.log.path]);if(Number(s.size)>capture.diagnostics.internal.log.offset){ready=true;break;}await new Promise(r=>setTimeout(r,25));}
  assert.equal(ready,true);
  const result=await profiler().finish(capture),pattern=result.rows.find(r=>r.sql.includes('core.profile_items')&&r.user==='atlas_reader');
  assert.equal(pattern.calls,3);assert.equal(result.plans.length,3);assert.ok(result.plans.every(p=>p.indexes.includes('profile_items_id_idx')));assert.ok(result.plans.every(p=>p.measured));
  assert.ok(result.rows.every(r=>!r.sql.includes('schema_atlas_profiler_marker')),'tool queries are excluded');
  const restricted=await new ProfilingJob(f.config).diagnostics();assert.equal(restricted.applicationPlans.available,false);assert.equal(restricted.allUsers,false);
  await assert.rejects(profiler().explain({...input,sql:'SELECT 1; SELECT 2'}),{code:'SYNTAX'});
  await assert.rejects(profiler().explain({sql:'WITH changed AS (DELETE FROM core.profile_items RETURNING *) SELECT * FROM changed',analyze:true}),{code:'READ_ONLY'});
  await assert.rejects(profiler().explain({sql:'SELECT pg_sleep(2)',analyze:true,timeout:100}),{code:'TIMEOUT'});
  const cancel=profiler(),pending=cancel.explain({sql:'SELECT pg_sleep(10)',analyze:true,timeout:15000});
  const rejection=assert.rejects(pending,{code:'CANCELLED'});
  await new Promise(r=>setTimeout(r,150));await cancel.stop();await rejection;
  const injection=await profiler().explain({sql:'SELECT $1::text',parameters:["'; DELETE FROM core.profile_items; --"],analyze:true});assert.equal(injection.measured,true);
  const count=await f.admin.query('SELECT count(*)::integer AS n FROM core.profile_items');assert.equal(count.rows[0].n,20000);
  const expired={...capture,startedAt:new Date(Date.now()-31*60_000).toISOString()};await assert.rejects(profiler().finish(expired),{code:'EXPIRED'});
});

test('profiling works without extensions for manual plans and reports missing capture setup',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.cleanup);const j=new ProfilingJob(f.config),d=await j.diagnostics();
  assert.equal(d.statistics.available,false);assert.equal(d.applicationPlans.available,false);
  const plan=await j.explain({sql:'SELECT $1::integer',parameters:[42],analyze:true});assert.equal(plan.measured,true);
  await assert.rejects(new ProfilingJob(f.config).start(),{code:'SETUP'});
});

test('profiling endpoints enforce ownership, CSRF, capture lifecycle, cancellation and busy limits',{timeout:30000},async t=>{
  let resolveJob,rejectJob,stops=0,working=false;
  const server=createApp({
    providerFactory:(config,id)=>({id,config,publicInfo:()=>({id,name:'test'}),inspect:async()=>({tables:[],capabilities:{query:true}}),close:async()=>{}}),
    profilingFactory:()=>({stop(){stops++;rejectJob?.(Object.assign(new Error('cancelled'),{name:'AbortError'}));return true;},diagnostics:async()=>({statistics:{available:true},internal:{path:'private-server-path'}}),start:async()=>({startedAt:new Date().toISOString()}),finish:async()=>({rows:[],plans:[]}),explain:async()=>{working=true;return new Promise((r,j)=>{resolveJob=r;rejectJob=j;});}})
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const url=`http://127.0.0.1:${server.address().port}`;
  const browser=async()=>{const r=await fetch(url+'/api/session'),cookie=r.headers.get('set-cookie').split(';')[0],s=await r.json();return {cookie,csrf:s.csrf};};
  const one=await browser(),two=await browser(),post=(who,route,input)=>fetch(url+route,{method:'POST',headers:{Cookie:who.cookie,'X-Atlas-CSRF':who.csrf,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});
  const connected=await (await post(one,'/api/connections',{host:'localhost',database:'test',user:'reader',password:'',tls:'local'})).json(),id=connected.connection.id;
  const route=action=>`/api/connections/${id}/profiling/${randomBytes(16).toString('hex')}/${action}`;
  assert.equal((await post(two,route('diagnostics'))).status,404);assert.equal((await post({...one,csrf:two.csrf},route('start'))).status,403);
  assert.equal((await post(one,route('diagnostics'),{unexpected:true})).status,413);
  const diagnostic=await (await post(one,route('diagnostics'))).json();assert.equal(JSON.stringify(diagnostic).includes('private-server-path'),false);
  assert.equal((await post(one,route('stop'))).status,404);assert.equal((await post(one,route('start'))).status,200);assert.equal((await post(one,route('start'))).status,409);
  assert.ok((await (await post(one,route('diagnostics'))).json()).activeCapture.startedAt);
  assert.equal((await post(one,route('stop'))).status,200);assert.equal((await post(one,route('stop'))).status,404);
  const jobID=randomBytes(16).toString('hex'),running=post(one,`/api/connections/${id}/profiling/${jobID}/explain`,{sql:'SELECT 1'});
  while(!working)await new Promise(r=>setTimeout(r,5));assert.equal((await post(one,route('diagnostics'))).status,429);
  assert.equal((await post(two,`/api/connections/${id}/queries/${jobID}/cancel`)).status,404);
  assert.equal((await post(one,`/api/connections/${id}/queries/${jobID}/cancel`)).status,200);await running;assert.equal(stops,1);
});
