import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresProvider } from '../lib/postgres.mjs';
import { fixture, postgresTools } from './helpers/postgres.mjs';
let available=true;try{await postgresTools();}catch{available=false;}
test('real PostgreSQL catalog, schema refresh, least privileges, TLS and failure retention',{skip:!available,timeout:60000},async t=>{
  const f=await fixture();t.after(f.cleanup);const p=new PostgresProvider({...f.config},'pg-integration');t.after(()=>p.close());
  const permission=await f.admin.query("SELECT has_table_privilege('atlas_reader','core.accounts','SELECT') AS can_read,rolsuper FROM pg_roles WHERE rolname='atlas_reader'");assert.deepEqual(permission.rows[0],{can_read:false,rolsuper:false});
  const model=await p.inspect();assert.equal(model.database.readOnly,true);assert.equal(model.database.isolation,'repeatable read');assert.equal(model.tables.length,11);
  const table=id=>model.tables.find(x=>x.id===id),accounts=table('core.accounts'),projects=table('core.projects');
  assert.deepEqual(accounts.primaryKey,['tenant_id','id']);assert.equal(accounts.comment,'Customer accounts');assert.equal(accounts.columns.find(c=>c.name==='email').options.comment,'Primary contact address');
  assert.deepEqual(accounts.columns.find(c=>c.name==='status').options.enumValues,['active','paused']);assert.equal(accounts.columns.find(c=>c.name==='normalized_email').options.generated,'s');assert.equal(projects.columns[0].options.identity,'always');
  const idx=accounts.indexes.find(i=>i.name==='accounts_active');assert.deepEqual(idx.include,['status']);assert.match(idx.where,/active/);assert.match(idx.columns[0],/lower/);assert.ok(accounts.indexes.some(i=>i.primary));assert.ok(accounts.indexes.some(i=>i.using==='gin'));
  const relation=model.relationships.find(r=>r.from==='core.projects');assert.deepEqual(relation.columns,['tenant_id','account_id']);assert.deepEqual(relation.targetColumns,['tenant_id','id']);assert.equal(relation.onDelete,'RESTRICT');assert.equal(relation.onUpdate,'CASCADE');assert.equal(relation.initiallyDeferred,true);assert.equal(relation.cardinality,'many_to_one');assert.equal(relation.inherited,false);assert.equal(model.relationships.find(r=>r.from==='core.profiles').cardinality,'one_to_one');
  assert.equal(model.relationships.find(r=>r.from==='core.quoted_ref').to,'core."odd.table"');
  const events=table('audit.events');assert.equal(events.partitions[0].strategy,'range');assert.match(events.partitions.find(p=>p.name==='audit.events_2026').bound,/2026-01-01/);assert.equal(table('audit.events_default').partitionOf,'audit.events');
  const sizes=await f.admin.query("SELECT pg_table_size('core.accounts')::text AS data,pg_indexes_size('core.accounts')::text AS indexes,pg_total_relation_size('core.accounts')::text AS total");
  assert.equal(accounts.statistics.dataBytes,sizes.rows[0].data);assert.equal(accounts.statistics.indexBytes,sizes.rows[0].indexes);assert.equal(accounts.statistics.totalBytes,sizes.rows[0].total);
  assert.equal(BigInt(accounts.statistics.dataBytes)+BigInt(accounts.statistics.indexBytes),BigInt(accounts.statistics.totalBytes));
  assert.equal(events.statistics.dataBytes,'0');assert.equal(events.statistics.indexBytes,'0');
  assert.equal(table('core.account_names').statistics.dataBytes,null);assert.equal(table('core.account_names').statistics.indexBytes,null);
  assert.equal(projects.triggers[0].name,'project_touch');assert.equal(projects.policies[0].name,'project_visibility');assert.equal(projects.options.rowSecurity,true);assert.ok(projects.grants.length);assert.match(table('core.account_names').viewDefinition,/SELECT/);assert.equal(table('core.account_summary').kind,'materialized view');assert.ok(table('core.reservations').constraints.some(c=>c.type==='exclusion'));
  const same=await p.inspect();assert.equal(same.revision,model.revision);assert.equal(same.changes.total,0);
  await f.admin.query("ALTER TABLE core.projects ADD COLUMN archived_at timestamptz; CREATE INDEX projects_archived ON core.projects(archived_at); CREATE TABLE core.new_table(id integer PRIMARY KEY); DROP TABLE core.quoted_ref;");
  const changed=await p.inspect();assert.notEqual(changed.revision,model.revision);assert.ok(changed.changes.added.includes('core.new_table'));assert.ok(changed.changes.removed.includes('core.quoted_ref'));assert.ok(changed.changes.changed.some(x=>x.id==='core.projects'));
  const serialized=JSON.stringify(changed);assert.ok(!serialized.includes(f.config.password));assert.ok(!JSON.stringify(p.publicInfo()).includes('password'));
  const oldPassword=p.config.password;p.config.password='';await assert.rejects(p.inspect(),e=>e.code==='CONNECTION'&&!e.message.includes(oldPassword));assert.equal(p.snapshot,changed);p.config.password=oldPassword;
  const secure=new PostgresProvider({...f.config,host:'localhost',tls:'verify',ca:f.ca},'tls');t.after(()=>secure.close());assert.equal((await secure.inspect()).database.tls,true);
  for(const patch of [{host:'localhost',ca:''},{host:'127.0.0.1',ca:f.ca}]){const bad=new PostgresProvider({...f.config,tls:'verify',...patch},'tls-invalid');await assert.rejects(bad.inspect(),{code:'CONNECTION'});await bad.close();}
  const connections=await f.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='schema-atlas'");assert.equal(connections.rows[0].n,0);
  await p.close();assert.equal(p.config.password,'');assert.equal(p.snapshot,null);
});
