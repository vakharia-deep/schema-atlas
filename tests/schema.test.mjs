import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildModel, splitSQL } from '../lib/schema.mjs';
import { parseFiles, collectFiles, diffModels, EctoRepositoryProvider } from '../lib/repository.mjs';

const migration=(code,version='20260101000000')=>({path:`priv/repo/migrations/${version}_test.exs`,kind:'migration',content:`defmodule Test.Migration do\n use Ecto.Migration\n def change do\n${code}\nend\nend`});
const schema=code=>({path:'lib/app/models.ex',kind:'schema',content:code});
const model=async files=>buildModel(await parseFiles(files));
const table=(m,name)=>m.tables.find(t=>t.name===name);

test('migration replay changes columns, renames references, drops indexes and tables',async()=>{
  const m=await model([migration(`
    create table(:users) do
      add :email, :string, null: false
      add :temp, :integer
    end
    create unique_index(:users, [:email])
    create table(:posts) do
      add :user_id, references(:users, on_delete: :delete_all), null: false
    end
    create table(:obsolete)
  `),migration(`
    alter table(:users) do
      remove :temp
      modify :email, :text
      add :active, :boolean, default: false, null: false
    end
    rename table(:users), :email, to: :address
    rename table(:users), to: table(:people)
    drop index(:people, [:address], name: :users_email_index)
    drop table(:obsolete)
  `,'20260201000000')]);
  assert.equal(m.tables.length,2);const people=table(m,'people');
  assert.deepEqual(people.columns.map(c=>c.name),['id','address','active']);
  assert.equal(people.columns[1].type,'text');assert.equal(people.columns[1].nullable,false);
  assert.equal(people.columns[2].default,false);assert.equal(people.indexes.length,0);
  assert.equal(m.relationships[0].to,'public.people');assert.equal(m.relationships[0].onDelete,'delete_all');
  assert.equal(m.warnings.length,0);
});

test('up is applied and down ignored, with source lines and explicit prefix',async()=>{
  const m=await model([{path:'priv/repo/migrations/1_create.exs',kind:'migration',content:'defmodule A do\n def up do\n create table(:users, prefix: "tenant", primary_key: false) do\n add :uuid, :uuid, primary_key: true\n end\n end\n def down do\n drop table(:users, prefix: "tenant")\n end\nend'}]);
  assert.equal(m.tables[0].id,'tenant.users');assert.deepEqual(m.tables[0].primaryKey,['uuid']);assert.equal(m.tables[0].sources[0].line,3);
});

test('compound, partial, covering, expression and gin indexes retain metadata',async()=>{
  const m=await model([migration(`create table(:events) do
    add :account_id, :integer
    add :email, :string
    add :payload, :map
    end
    create unique_index(:events, [:account_id, "lower(email)"], name: :compound, where: "email IS NOT NULL", include: [:payload], concurrently: true)
    create index(:events, [:payload], using: :gin)
    create constraint(:events, :positive_account, check: "account_id > 0")`)]);
  const t=m.tables[0],i=t.indexes[0];assert.equal(i.unique,true);assert.deepEqual(i.columns,['account_id','lower(email)']);assert.equal(i.where,'email IS NOT NULL');assert.deepEqual(i.include,['payload']);assert.equal(i.concurrently,true);assert.equal(t.indexes[1].using,'gin');assert.equal(t.constraints[0].definition,'account_id > 0');
});

test('literal partition declarations and child tables retain bounds',async()=>{
  const m=await model([migration(`create table(:events, primary_key: false, options: "PARTITION BY RANGE (at)") do
    add :id, :uuid, primary_key: true
    add :at, :utc_datetime, primary_key: true
    end
    execute "CREATE TABLE events_oct PARTITION OF events FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')"`)]);
  const t=table(m,'events');assert.equal(t.partitions[0].strategy,'range');assert.equal(t.partitions[0].key,'at');assert.match(t.partitions[1].bound,/2026-11-01/);assert.equal(table(m,'events_oct').partitionOf,'public.events');assert.deepEqual(table(m,'events_oct').primaryKey,['id','at']);
});

test('SQL expression indexes do not split commas inside functions or predicates',async()=>{
  const m=await model([migration(`create table(:users)
    execute "CREATE UNIQUE INDEX user_expr ON users USING btree (lower(email), coalesce(name, 'none')) INCLUDE (id) WHERE email IS NOT NULL"`)]);
  const i=m.tables[0].indexes[0];assert.deepEqual(i.columns,['lower(email)',"coalesce(name, 'none')"]);assert.equal(i.where,'email IS NOT NULL');assert.deepEqual(i.include,['id']);assert.equal(i.unique,true);
});

test('schema fields supplement migrations, virtual fields stay out, associations stay distinct',async()=>{
  const m=await model([schema(`defmodule App.User do
  use Ecto.Schema
  @primary_key {:uuid, :binary_id, autogenerate: true}
  schema "users" do
    field :email, :string
    field :scratch, :string, virtual: true
  end
end
defmodule App.Post do
  use Ecto.Schema
  @foreign_key_type :binary_id
  schema "posts" do
    belongs_to :user, App.User, references: :uuid
    field :headline, :string, source: :title
  end
end`)]);
  assert.deepEqual(table(m,'users').primaryKey,['uuid']);assert.equal(table(m,'users').columns[0].type,'uuid');assert.equal(table(m,'users').columns.some(c=>c.name==='scratch'),false);assert.equal(table(m,'posts').columns.find(c=>c.name==='user_id').type,'uuid');assert.ok(table(m,'posts').columns.some(c=>c.name==='title'));assert.equal(m.relationships[0].kind,'association');assert.equal(m.relationships[0].targetColumn,'uuid');
});

test('unsupported dynamic code is flagged and never executed',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'atlas-execution-'));
  try {
    const marker=path.join(dir,'must-not-exist');
    const m=await model([migration(`File.write!("${marker}", "executed")\nfor name <- [:dynamic] do\ncreate table(name)\nend\nexecute "CREATE TABLE #{System.get_env("ATLAS_TEST_TABLE")} (id bigint)"`)]);
    const { access }=await import('node:fs/promises');await assert.rejects(access(marker));assert.equal(m.tables.length,0);assert.equal(m.warnings.length,3);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Unicode source and metadata survive the process boundary',async()=>{
  const m=await model([migration('create table(:notes, comment: "नमस्ते 🌿 café") do\nadd :title, :string, default: "こんにちは"\nend')]);
  assert.equal(m.tables[0].comment,'नमस्ते 🌿 café');assert.equal(m.tables[0].columns[1].default,'こんにちは');
});

test('literal module attributes and maps resolve without evaluation',async()=>{
  const input=migration('@name :notes\ncreate table(@name) do\nadd :payload, :map, default: %{}\nend');
  input.content=input.content.replace(' def change do\n@name :notes',' @name :notes\n def change do');
  const m=await model([input]);assert.equal(m.tables[0].name,'notes');assert.deepEqual(m.tables[0].columns[1].default,{});
});

test('syntax errors are visible, and valid neighboring migrations still render',async()=>{
  const m=await model([migration('create table(:valid)'),{path:'priv/repo/migrations/2_bad.exs',kind:'migration',content:'defmodule Bad do ???'}]);
  assert.equal(m.tables.length,1);assert.ok(m.warnings.some(w=>w.message.includes('syntax')));
});

test('snapshot diff finds additions, removals, index and partition edits',()=>{
  const a={tables:[{id:'public.a',columns:[{name:'id'}],indexes:[],partitions:[]},{id:'public.removed',columns:[]}]};
  const b={tables:[{id:'public.a',columns:[{name:'id'},{name:'new'}],indexes:[{name:'idx'}],partitions:[{name:'p'}]},{id:'public.added',columns:[]}]};
  const d=diffModels(a,b);assert.equal(d.total,3);assert.deepEqual(d.added,['public.added']);assert.deepEqual(d.removed,['public.removed']);assert.deepEqual(d.changed[0].details,['columns','indexes','partitions']);assert.deepEqual(d.changed[0].addedColumns,['new']);
});

test('source line shifts do not count as schema changes',()=>{
  const a={tables:[{id:'public.a',columns:[{name:'id',source:{file:'a.exs',line:4}}]}]};
  const b=structuredClone(a);b.tables[0].columns[0].source.line=8;assert.equal(diffModels(a,b).total,0);
});

test('stale schema declarations cannot resurrect dropped tables or removed columns',async()=>{
  const m=await model([migration('create table(:users) do\nadd :old, :string\nend\ncreate table(:retired)\nalter table(:users) do\nremove :old\nend\ndrop table(:retired)'),schema('defmodule User do\nschema "users" do\nfield :old, :string\nend\nend\ndefmodule Retired do\nschema "retired" do\nend\nend')]);
  assert.equal(m.tables.length,1);assert.equal(m.tables[0].columns.some(c=>c.name==='old'),false);assert.equal(m.warnings.length,2);
});

test('aliases resolve associations to their complete schema modules',async()=>{
  const m=await model([schema('defmodule App.User do\nschema "users" do\nend\nend\ndefmodule App.Post do\nalias App.User, as: Author\nschema "posts" do\nbelongs_to :author, Author\nend\nend')]);
  assert.equal(m.relationships[0].to,'public.users');
});

test('refresh reads changed files and removal with an unchanged-snapshot fast path',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'atlas-refresh-'));
  try {
    await mkdir(path.join(dir,'priv/repo/migrations'),{recursive:true});
    const p=path.join(dir,'priv/repo/migrations/1_test.exs');await writeFile(p,migration('create table(:alpha)').content);
    const provider=new EctoRepositoryProvider(dir,'test','Test');const first=await provider.inspect();assert.equal(first.changes.baseline,true);
    const unchanged=await provider.inspect();assert.equal(unchanged.revision,first.revision);assert.equal(unchanged.changes.total,0);
    await writeFile(p,'defmodule Broken do ???');await assert.rejects(provider.inspect(),{code:'SOURCE_SYNTAX'});assert.equal(provider.snapshot.revision,first.revision);
    await writeFile(p,migration('create table(:beta)').content);const next=await provider.inspect();assert.deepEqual(next.changes.added,['public.beta']);assert.deepEqual(next.changes.removed,['public.alpha']);assert.notEqual(next.revision,first.revision);
    await rm(p);const empty=await provider.inspect();assert.equal(empty.tables.length,0);assert.deepEqual(empty.changes.removed,['public.beta']);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('filesystem scan ignores config, dependencies and symlinks outside the repository',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'atlas-files-'));
  try {
    await mkdir(path.join(dir,'lib'));await mkdir(path.join(dir,'config'));await writeFile(path.join(dir,'lib/user.ex'),'schema "users" do\nend');await writeFile(path.join(dir,'config/runtime.exs'),'secret = "never exported"');await symlink(path.join(dir,'config/runtime.exs'),path.join(dir,'lib/leak.ex'));
    const result=await collectFiles(dir);assert.equal(result.files.length,1);assert.equal(result.files[0].path,'lib/user.ex');assert.ok(result.warnings.some(w=>w.message.includes('Symbolic')));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('oversized source files are refused',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'atlas-size-'));
  try{await mkdir(path.join(dir,'lib'));await writeFile(path.join(dir,'lib/huge.ex'),'x'.repeat(1_000_001));await assert.rejects(collectFiles(dir),/limit/);}finally{await rm(dir,{recursive:true,force:true});}
});

test('SQL splitting respects quoted delimiters and nested expressions',()=>{
  assert.deepEqual(splitSQL("lower(name), coalesce(a, 'x,y'), id",','),['lower(name)'," coalesce(a, 'x,y')",' id']);assert.equal(splitSQL("SELECT ';'; SELECT $$a;b$$",';').length,2);
});
