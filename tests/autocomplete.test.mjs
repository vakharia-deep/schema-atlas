import test from 'node:test';
import assert from 'node:assert/strict';
import { tableCompletions } from '../web/query.js';

const tables=[
  {prefix:'core',name:'accounts',kind:'table'},
  {prefix:'audit',name:'accounts',kind:'partitioned table'},
  {prefix:'core',name:'projects',kind:'table'},
  {prefix:'core',name:'odd.table',kind:'table'},
  {prefix:'Mixed Schema',name:'a"b',kind:'view'}
];
const complete=(sql,catalog=tables,force=false)=>tableCompletions(sql,sql.length,sql.length,catalog,force);
test('table suggestions appear in relation clauses, including comma joins and nested queries',()=>{
  for(const sql of ['SELECT * FROM ','SELECT * FROM core.projects p JOIN ','TABLE ','SELECT * FROM core.projects, ','SELECT * FROM (SELECT 1) q, ']){
    assert.equal(complete(sql).total,5,sql);
  }
  for(const sql of ['SELECT ','SELECT id, ','SELECT * FROM core.projects WHERE ','SELECT * FROM core.projects p JOIN core.accounts a ON p.id = a.id, ']){
    assert.equal(complete(sql),null,sql);
  }
  assert.equal(complete('SELECT ',tables,true).total,5);
});
test('schema-qualified filtering and correctly quoted insertion handle duplicate and unusual identifiers',()=>{
  assert.deepEqual(complete('SELECT * FROM acc').items.map(t=>t.label),['audit.accounts','core.accounts']);
  assert.equal(complete('SELECT * FROM core.acc').items[0].insert,'"core"."accounts"');
  assert.equal(complete('SELECT * FROM "Mixed Schema"."a').items[0].insert,'"Mixed Schema"."a""b"');
  assert.equal(complete('SELECT * FROM core.odd').items[0].insert,'"core"."odd.table"');
  assert.equal(complete('SELECT * FROM audit.').total,1);
});
test('completion replaces the full identifier at the caret while preserving aliases and following SQL',()=>{
  const sql='SELECT * FROM core.accounts a WHERE a.id=1',caret=sql.indexOf('accounts')+3;
  const match=tableCompletions(sql,caret,caret,tables);
  assert.equal(sql.slice(0,match.from)+match.items[0].insert+sql.slice(match.to),'SELECT * FROM "core"."accounts" a WHERE a.id=1');
  const atDot=sql.indexOf('accounts'),fromDot=tableCompletions(sql,atDot,atDot,tables);
  assert.equal(sql.slice(fromDot.from,fromDot.to),'core.accounts');
  assert.equal(tableCompletions(sql,caret,caret+1,tables),null);
});
test('strings, dollar quotes and comments never trigger table suggestions',()=>{
  for(const sql of ["SELECT 'FROM acc","SELECT E'escaped\\' FROM acc",'SELECT $$FROM acc','SELECT $body$FROM acc','SELECT 1 -- FROM acc','SELECT /* outer /* nested */ FROM acc']){
    assert.equal(complete(sql,tables,true),null,sql);
  }
  assert.equal(complete('SELECT * FROM /* a /* nested */ comment */ acc').total,2);
  assert.equal(complete("SELECT 'literal' FROM acc").total,2);
});
test('suggestions derive from the current catalog, so switching databases or refreshing cannot use stale tables',()=>{
  const sql='SELECT * FROM ';
  assert.equal(complete(sql,[{prefix:'first',name:'only_here'}]).items[0].label,'first.only_here');
  assert.deepEqual(complete(sql,[{prefix:'second',name:'fresh_table'}]).items.map(t=>t.label),['second.fresh_table']);
  assert.equal(complete(sql,[]).total,0);
  assert.equal(complete('SELECT * FROM fresh',[{prefix:'second',name:'fresh_table'}]).total,1);
});
test('large catalogs return a bounded list and a total match count',()=>{
  const catalog=Array.from({length:2000},(_,i)=>({prefix:'public',name:'table_'+i}));
  const result=complete('SELECT * FROM ',catalog);
  assert.equal(result.total,2000);assert.equal(result.items.length,12);
  assert.equal(complete('x'.repeat(32001)),null);
});
