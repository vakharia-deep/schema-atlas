import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { AtlasError } from '../lib/postgres.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('serves app with CSP, no-store, no version banner, and no external scripts',async t=>{
  const {url}=await connectionApp(t);const r=await fetch(url);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('server'),null);assert.match(await r.text(),/Schema Atlas/);
});
test('cross-origin, invalid host and missing CSRF cannot read or refresh connections',async t=>{
  const a=await connectionApp(t),b=await a.browser();
  const connected=await b.post('/api/connections',details());assert.equal(connected.status,201);
  const id=(await connected.json()).connection.id,route=`/api/connections/${id}/refresh`;
  assert.equal(a.instances[0].scans,1);
  assert.equal((await fetch(a.url+'/api/session',{headers:{Origin:'https://untrusted.example'}})).status,403);
  const badHost=await new Promise((resolve,reject)=>{http.get(a.url+'/api/session',{headers:{Host:'untrusted.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(badHost,403);
  assert.equal((await fetch(a.url+route,{method:'POST',headers:{Cookie:b.cookie}})).status,403);
  assert.equal((await fetch(a.url+route,{method:'POST',headers:{Cookie:b.cookie,'X-Atlas-CSRF':b.session.csrf,Origin:'https://untrusted.example'}})).status,403);
  assert.equal(a.instances[0].scans,1);
  assert.equal((await b.post(route)).status,200);assert.equal(a.instances[0].scans,2);
});
test('arbitrary files, removed repository routes and unknown connection IDs are unavailable',async t=>{
  const a=await connectionApp(t),b=await a.browser();
  for(const route of ['/server.mjs','/.env','/api/query','/api/source','/lib/schema-diff.mjs','/api/session?path=/etc/passwd'])assert.ok((await fetch(a.url+route)).status>=400);
  assert.equal((await b.post('/api/repositories/repo-1/refresh')).status,404);
  assert.equal((await b.post('/api/connections/pg-'+randomBytes(12).toString('hex')+'/refresh')).status,404);assert.equal(a.instances.length,0);
});
test('refresh rate limit rejects work above the budget',async t=>{
  const a=await connectionApp(t,{scanLimit:2}),b=await a.browser();
  const connected=await b.post('/api/connections',details());assert.equal(connected.status,201);
  const id=(await connected.json()).connection.id,statuses=[];
  for(let i=0;i<3;i++){const r=await b.post(`/api/connections/${id}/refresh`);statuses.push(r.status);if(i===2)assert.equal(r.headers.get('retry-after'),'60');}
  assert.deepEqual(statuses,[200,200,429]);assert.equal(a.instances[0].scans,3);
});
test('request bodies are rejected before scanning',async t=>{
  const a=await connectionApp(t),b=await a.browser();
  const connected=await b.post('/api/connections',details());assert.equal(connected.status,201);const id=(await connected.json()).connection.id;
  const r=await b.post(`/api/connections/${id}/refresh`,{unexpected:true});assert.equal(r.status,413);assert.equal(a.instances[0].scans,1);
  assert.equal((await b.post(`/api/connections/${id}/refresh`)).status,200);assert.equal(a.instances[0].scans,2);
});
test('CLI supports PostgreSQL startup and rejects the removed reader flags',async()=>{
  const run=promisify(execFile),server=fileURLToPath(new URL('../server.mjs',import.meta.url));
  const options={timeout:5000,maxBuffer:4096};
  const {stdout}=await run(process.execPath,[server,'--help'],options);
  assert.match(stdout,/Connect PostgreSQL from the browser/);assert.doesNotMatch(stdout,/--repo|--demo/);
  for(const args of [['--repo','/unused'],['--demo']])await assert.rejects(run(process.execPath,[server,...args],options),error=>error.code===1&&/Unknown|Startup failed/.test(error.stderr));
});

async function connectionApp(t,options={}){
  const instances=[];
  const server=createApp({
    providerFactory:(config,id)=>{
      const p={config,id,closed:false,scans:0,publicInfo:()=>({id,name:config.name,provider:'postgres'}),inspect:async()=>{p.scans++;return {tables:[],capabilities:{provider:'postgres',query:false}};},close:async()=>{p.closed=true;config.password='';config.ca='';}};
      instances.push(p);return p;
    },...options
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const url=`http://127.0.0.1:${server.address().port}`;
  const browser=async()=>{const r=await fetch(url+'/api/session'),cookie=r.headers.get('set-cookie').split(';')[0],session=await r.json();return {session,cookie,post:(route,body)=>fetch(url+route,{method:'POST',headers:{Cookie:cookie,'X-Atlas-CSRF':session.csrf,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})};};
  return {url,instances,browser};
}
const details=()=>({host:'localhost',database:'app',user:'reader',password:randomBytes(32).toString('base64url'),tls:'local'});
test('default startup exposes only database connections and credentials never reach responses',async t=>{
  const a=await connectionApp(t),b=await a.browser();assert.deepEqual(b.session.connections,[]);assert.equal(Object.hasOwn(b.session,'repositories'),false);assert.equal(b.session.capabilities.postgres,true);
  const config=details(),r=await b.post('/api/connections',config);assert.equal(r.status,201);const result=await r.json();assert.ok(!JSON.stringify(result).includes(config.password));
  const inventory=await(await fetch(a.url+'/api/session',{headers:{Cookie:b.cookie}})).json();assert.equal(inventory.connections.length,1);assert.ok(!JSON.stringify(inventory).includes(config.password));
  assert.equal((await b.post(`/api/connections/${result.connection.id}/refresh`)).status,200);
  assert.equal((await b.post(`/api/connections/${result.connection.id}/disconnect`)).status,200);assert.equal(a.instances[0].closed,true);assert.equal(a.instances[0].config.password,'');
  assert.equal((await b.post(`/api/connections/${result.connection.id}/refresh`)).status,404);
});
test('connection IDs and CSRF tokens are isolated between browser sessions',async t=>{
  const a=await connectionApp(t),one=await a.browser(),two=await a.browser();const id=(await(await one.post('/api/connections',details())).json()).connection.id;
  assert.equal((await two.post(`/api/connections/${id}/refresh`)).status,404);assert.equal((await two.post(`/api/connections/${id}/disconnect`)).status,404);
  const mismatched=await fetch(a.url+`/api/connections/${id}/refresh`,{method:'POST',headers:{Cookie:two.cookie,'X-Atlas-CSRF':one.session.csrf}});assert.equal(mismatched.status,403);
  assert.equal((await fetch(a.url+'/api/connections',{method:'POST'})).status,401);assert.equal(a.instances[0].closed,false);
});
test('connection validation, per-session cap and attempts budget run before network access',async t=>{
  const a=await connectionApp(t),b=await a.browser();assert.equal((await b.post('/api/connections',{...details(),arbitrary:'field'})).status,400);assert.equal(a.instances.length,0);
  for(let i=0;i<4;i++)assert.equal((await b.post('/api/connections',details())).status,201);
  assert.equal((await b.post('/api/connections',details())).status,409);
  for(let i=0;i<4;i++)await b.post('/api/connections',details());
  assert.equal((await b.post('/api/connections',details())).status,429);assert.equal(a.instances.length,4);
});
test('session expiry disposes credentials and requires a new browser session',async t=>{
  const a=await connectionApp(t,{sessionTTL:80}),b=await a.browser();const id=(await(await b.post('/api/connections',details())).json()).connection.id;
  await new Promise(r=>setTimeout(r,120));assert.equal((await b.post(`/api/connections/${id}/refresh`)).status,401);assert.equal(a.instances[0].config.password,'');assert.equal(a.instances[0].closed,true);
});

test('query API scopes every connection and cancellation ID, requires CSRF and enforces budgets',async t=>{
  let runs=0,stops=0,pendingReject,started;
  const a=await connectionApp(t,{queryLimit:3,queryFactory:(_config,input)=>({
    run:async()=>{runs++;if(input.sql==='SELECT slow')return new Promise((_,reject)=>{pendingReject=reject;started?.();});return {columns:[{name:'n',typeOID:23}],rows:[['1']],readOnly:true};},
    stop:()=>{stops++;pendingReject?.(new AtlasError('CANCELLED','Query cancelled.',409));return true;}
  })});
  const one=await a.browser(),two=await a.browser();
  const id=(await(await one.post('/api/connections',details())).json()).connection.id;
  const other=(await(await one.post('/api/connections',details())).json()).connection.id;
  const queryID=randomBytes(16).toString('hex');
  const route='/api/connections/'+id+'/queries/'+queryID;
  assert.equal((await two.post(route+'/run',{sql:'SELECT 1'})).status,404);
  assert.equal((await two.post(route+'/cancel')).status,404);
  assert.equal((await fetch(a.url+route+'/run',{method:'POST',headers:{Cookie:one.cookie,'Content-Type':'application/json'},body:JSON.stringify({sql:'SELECT 1'})})).status,403);
  assert.equal((await fetch(a.url+route+'/run',{method:'POST'})).status,401);
  assert.equal((await one.post(route+'/run',{sql:'SELECT 1',limit:999999})).status,400);
  assert.equal(runs,0);
  const ok=await one.post(route+'/run',{sql:'SELECT 1'});assert.equal(ok.status,200);assert.deepEqual((await ok.json()).rows,[['1']]);
  const ready=new Promise(resolve=>{started=resolve;});
  const running=one.post(route+'/run',{sql:'SELECT slow'});await ready;
  assert.equal((await one.post(route+'/run',{sql:'SELECT 1'})).status,429);
  assert.equal((await one.post('/api/connections/'+other+'/queries/'+queryID+'/cancel')).status,404);
  assert.equal(stops,0);
  assert.equal((await one.post(route+'/cancel')).status,200);assert.equal((await running).status,409);assert.equal(stops,1);
  assert.equal((await one.post(route+'/run',{sql:'SELECT 1'})).status,429);assert.equal(runs,2);
});

test('disconnect stops the query before discarding its saved credentials',async t=>{
  let started,stopCount=0,rejectQuery;
  const a=await connectionApp(t,{queryFactory:()=>({
    run:()=>new Promise((_,reject)=>{rejectQuery=reject;started();}),
    stop:()=>{stopCount++;rejectQuery(new AtlasError('CANCELLED','Query cancelled.',409));return true;}
  })});
  const b=await a.browser(),id=(await(await b.post('/api/connections',details())).json()).connection.id;
  const ready=new Promise(resolve=>{started=resolve;});
  const running=b.post('/api/connections/'+id+'/queries/'+randomBytes(16).toString('hex')+'/run',{sql:'SELECT 1'});
  await ready;assert.equal((await b.post('/api/connections/'+id+'/disconnect')).status,200);
  assert.equal((await running).status,409);assert.equal(stopCount,1);assert.equal(a.instances[0].config.password,'');
});
