import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryJob, validateQuery } from '../lib/query.mjs';
import { fixture, postgresTools } from './helpers/postgres.mjs';
let available=true;try{await postgresTools();}catch{available=false;}

test('query input and command gate reject unsupported, unbounded and malformed payloads',()=>{
  for(const value of [null,[],{sql:''},{sql:'SELECT 1',limit:1001},{sql:'SELECT 1',timeout:0},{sql:'SELECT 1',mode:'write'},{sql:'SELECT \0'},{sql:'a'.repeat(32001)},{sql:'COMMIT'},{sql:'SET transaction_read_only=off'},{sql:'DELETE FROM t'}])assert.throws(()=>validateQuery(value));
  assert.equal(validateQuery({sql:'/* outer /* nested */ ok */ -- comment\nSELECT 1'}).limit,500);
});

test('real PostgreSQL queries preserve values, enforce read-only/single statement, cap output and cancel',{skip:!available,timeout:60000},async t=>{
  const f=await fixture();t.after(f.cleanup);
  await f.admin.query("CREATE TABLE core.query_test(id integer PRIMARY KEY, label text); INSERT INTO core.query_test VALUES (1,'Atlas'),(2,'Database'); GRANT SELECT,INSERT,UPDATE,DELETE ON core.query_test TO atlas_reader;");
  const run=input=>new QueryJob(f.config,typeof input==='string'?{sql:input}:input).run();
  const result=await run("SELECT id, label, NULL AS absent, 9007199254740993::bigint AS exact, '{}'::jsonb AS data, id AS id FROM core.query_test ORDER BY id");
  assert.equal(result.rows.length,2);assert.deepEqual(result.columns.map(c=>c.name),['id','label','absent','exact','data','id']);
  assert.deepEqual(result.rows[0],['1','Atlas',null,'9007199254740993','{}','1']);assert.equal(result.readOnly,true);assert.equal(result.truncated,false);
  const empty=await run('SELECT * FROM core.query_test WHERE false');assert.equal(empty.rows.length,0);assert.equal(empty.columns.length,2);
  assert.equal((await run('SHOW transaction_read_only')).rows[0][0],'on');
  assert.equal((await run("SELECT ';' AS semicolon /* ; */;")).rows[0][0],';');
  await assert.rejects(run('SELECT 1; SELECT 2'),e=>e.code==='SYNTAX'&&e.sqlState==='42601');
  await assert.rejects(run("WITH modified AS (DELETE FROM core.query_test RETURNING *) SELECT * FROM modified"),{code:'READ_ONLY'});
  await assert.rejects(run('EXPLAIN ANALYZE DELETE FROM core.query_test'),{code:'READ_ONLY'});
  assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM core.query_test')).rows[0].n,2);
  await assert.rejects(run('SELECT * FROM core.accounts'),{code:'PERMISSION'});
  await assert.rejects(run('SELECT private_unavailable_column FROM core.query_test'),e=>e.code==='COLUMN'&&e.position>0&&!e.message.includes('private_unavailable'));
  await assert.rejects(run({sql:'SELECT pg_sleep(2)',timeout:100}),{code:'TIMEOUT'});
  const capped=await run({sql:'SELECT generate_series(1,10000)',limit:100});
  assert.equal(capped.rows.length,100);assert.equal(capped.truncated,true);assert.equal(capped.reason,'row limit');
  const exact=await run({sql:'SELECT generate_series(1,100)',limit:100});assert.equal(exact.truncated,false);
  const sized=await run("SELECT repeat('x',1000000) FROM generate_series(1,10)");
  assert.equal(sized.truncated,true);assert.equal(sized.reason,'2 MB result limit');assert.equal(sized.rows.length,2);
  await assert.rejects(run("SELECT repeat('x',12000000)"),{code:'RESULT_LIMIT'});
  const job=new QueryJob(f.config,{sql:'SELECT pg_sleep(10)',timeout:15000});
  const pending=job.run();const rejected=assert.rejects(pending,{code:'CANCELLED'});
  let seen=false;
  for(let i=0;i<50;i++){
    const active=await f.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='schema-atlas-query' AND state='active' AND query='SELECT pg_sleep(10)'");
    if(active.rows[0].n===1){seen=true;break;}await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(seen,true,'positive control: long query reached PostgreSQL');assert.equal(job.stop(),true);await rejected;
  const fresh=await run('SELECT 42');assert.equal(fresh.rows[0][0],'42');
  await f.admin.query("ALTER TABLE core.query_test ENABLE ROW LEVEL SECURITY; CREATE POLICY query_visibility ON core.query_test FOR SELECT TO atlas_reader USING (id=1)");
  const scoped=await run('SELECT id FROM core.query_test');assert.deepEqual(scoped.rows,[['1']],'database RLS stays effective');
  const active=await f.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name IN ('schema-atlas-query','schema-atlas-cancel')");
  assert.equal(active.rows[0].n,0,'no active or idle query connections remain');
});
