import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlowLogs, importSlowLogFile, LOG_LIMITS } from '../web/slow-logs.js';
const log=(message,extra={})=>JSON.stringify({dbname:'app',user:'reader',application_name:'storefront',timestamp:'2026-10-14 12:00:00 UTC',message,...extra});

test('JSON slow logs preserve SQL and durations, filter databases, and never infer parameter values',()=>{
  const sql="SELECT '<img src=x onerror=alert(1)>'::text, $1";
  const result=parseSlowLogs([
    log('duration: 150.25 ms  execute <unnamed>: '+sql,{detail:"parameters: $1 = 'private value'"}),
    log('duration: 2 ms  statement: SELECT 1'),
    log('duration: 999 ms  statement: SELECT 2',{dbname:'other'}),
    log('duration: 12 ms  parse <unnamed>: SELECT 3'),
    log('duration: 1 ms'),log('duration: 0.5 ms  bind <unnamed>: SELECT 4'),
    log('duration: 3 ms  plan: {"Plan":{}}'),
  ].join('\n'),'app');
  assert.deepEqual(result.rows.map(r=>r.durationMs),[150.25,2]);assert.equal(result.rows[0].sql,sql);
  assert.equal(result.rows[0].database,'app');assert.equal(result.rows[0].user,'reader');assert.equal(result.rows[0].application,'storefront');
  assert.equal(result.counts.otherDatabase,1);assert.equal(result.counts.unsupported,4);assert.equal(result.counts.unscoped,0);
  assert.ok(!JSON.stringify(result).includes('private value'));assert.equal(Object.hasOwn(result.rows[0],'parameters'),false);
});

test('stderr logs retain tab-indented multiline SQL and explicitly report unverified database scope',()=>{
  const result=parseSlowLogs("2026-10-14 12:00:00 UTC [12] LOG:  duration: 42.5 ms  statement: SELECT id\n\tFROM shop.products\n\tWHERE sku = 'SKU-42'\n2026-10-14 12:00:01 UTC [12] DETAIL: other record\nduration: 1 ms  execute prepared_query: SELECT $1\n",'app');
  assert.equal(result.rows.length,2);assert.equal(result.rows[0].sql,"SELECT id\nFROM shop.products\nWHERE sku = 'SKU-42'");
  assert.equal(result.rows[1].sql,'SELECT $1');assert.equal(result.counts.unscoped,2);assert.match(result.warnings.join(' '),/Confirm they belong/);
});

test('malformed records, unknown record fields and deep JSON cannot become trusted results',()=>{
  const result=parseSlowLogs([log('duration: 1 ms statement: SELECT 1'),'{broken',log('duration: 2 ms statement: SELECT 2',{dbname:{value:'app'}}),JSON.stringify({message:'duration: 3 ms statement: SELECT 3',nested:Array(20).fill(0).reduce(a=>[a],0)}),log('duration: 4 ms statement: SELECT 4',{__proto__:'ignored'})].join('\n'),'app');
  assert.equal(result.rows.length,2);assert.equal(result.counts.invalid,3);assert.ok(!Object.hasOwn(result.rows[0],'nested'));
  assert.throws(()=>parseSlowLogs('x'.repeat(LOG_LIMITS.bytes+1),'app'),/2 MB/);assert.throws(()=>parseSlowLogs('\0','app'),/UTF-8/);assert.throws(()=>parseSlowLogs('',null),/Select a database/);
});

test('record, SQL and output limits report incomplete imports without returning oversized output',()=>{
  const many=parseSlowLogs(Array.from({length:510},(_,i)=>log(`duration: ${i} ms statement: SELECT ${i}`)).join('\n'),'app');
  assert.equal(many.rows.length,500);assert.match(many.warnings.join(' '),/Import limit reached/);
  const oversized=parseSlowLogs(log('duration: 1 ms statement: SELECT '+"'"+'x'.repeat(30000)+"'"),'app');assert.equal(oversized.rows.length,0);assert.equal(oversized.counts.invalid,1);
  const output=parseSlowLogs(Array.from({length:50},()=>log('duration: 1 ms statement: SELECT '+"'"+'x'.repeat(25000)+"'")).join('\n'),'app');
  assert.ok(output.rows.length>0&&output.rows.length<50);assert.ok(new TextEncoder().encode(JSON.stringify(output)).length<=LOG_LIMITS.outputBytes);assert.match(output.warnings.join(' '),/incomplete/);
});

test('file import rejects unsupported declarations and oversized files before creating a worker',async()=>{
  for(const file of [{size:LOG_LIMITS.bytes+1,name:'a.log',type:'text/plain'},{size:20,name:'a.html',type:'text/html'},{size:20,name:'a.json',type:'image/png'},{size:0,name:'a.log',type:''}])await assert.rejects(importSlowLogFile(file,'app'));
});
