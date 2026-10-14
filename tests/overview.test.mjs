import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewRows } from '../web/overview.js';

const table=(id,options={})=>({id,kind:'table',columns:[],indexes:[],partitions:[],statistics:{},...options});
const ids=rows=>rows.map(row=>row.name);
const tables=[
  table('shop.z',{partitionOf:'shop.a',columns:Array(2).fill({}),indexes:Array(10).fill({}),statistics:{estimatedRows:'2',totalBytes:'921600',indexBytes:'2048',dataBytes:'8192'}}),
  table('shop.a',{partitions:[{type:'strategy',key:'RANGE (created_at)'},{type:'child',name:'shop.z'}],columns:Array(10).fill({}),indexes:Array(2).fill({}),statistics:{estimatedRows:'10',totalBytes:'1048576',indexBytes:'8192',dataBytes:'2048'}}),
  table('shop.m',{kind:'view',columns:Array(3).fill({}),indexes:[{}],statistics:{estimatedRows:'100',totalBytes:'2048',indexBytes:'4096',dataBytes:'4096'}}),
];
const relationships=[...Array(2).fill({kind:'foreign_key',from:'shop.z'}),...Array(10).fill({kind:'foreign_key',from:'shop.a'}),{kind:'foreign_key',from:'shop.m'},{kind:'partition',from:'shop.m'}];

test('all ten overview columns sort in both directions using the displayed metadata',()=>{
  const expected={name:['a','m','z'],type:['z','a','m'],partitioning:['m','z','a'],columns:['z','m','a'],indexes:['m','a','z'],foreignKeys:['m','z','a'],estimatedRows:['z','a','m'],totalBytes:['m','z','a'],indexBytes:['z','m','a'],dataBytes:['a','m','z']};
  for(const [column,names]of Object.entries(expected)){
    const ascending=names.map(name=>'shop.'+name);
    assert.deepEqual(ids(overviewRows(tables,relationships,{column,direction:'ascending'})),ascending,column);
    assert.deepEqual(ids(overviewRows(tables,relationships,{column,direction:'descending'})),ascending.toReversed(),column);
  }
  const rows=overviewRows(tables,relationships);
  assert.equal(rows[0].partitioning,'RANGE (created_at) · 1 children');
  assert.equal(rows[1].foreignKeys,1,'partition links are not foreign keys');
});

test('row counts and byte sizes retain bigint precision and keep unknowns last in both directions',()=>{
  for(const column of ['estimatedRows','totalBytes','indexBytes','dataBytes']){
    const input=[
      table('unknown'),table('z-smaller',{statistics:{[column]:'9007199254740992'}}),
      table('a-larger',{statistics:{[column]:'9007199254740993'}}),table('zero',{statistics:{[column]:0}}),
      table('null',{statistics:{[column]:null}}),
    ];
    assert.deepEqual(ids(overviewRows(input,[],{column})),['zero','z-smaller','a-larger','null','unknown']);
    assert.deepEqual(ids(overviewRows(input,[],{column,direction:'descending'})),['a-larger','z-smaller','zero','null','unknown']);
  }
});

test('ties use table names, filters and refreshed values are respected, and input order is unchanged',()=>{
  const input=[table('shop.table10',{indexes:[{}]}),table('shop.table2',{indexes:[{}]}),table('audit.table',{indexes:[{},{}]})];
  const original=structuredClone(input),sort={column:'indexes',direction:'descending'};
  assert.deepEqual(ids(overviewRows(input,[],sort)),['audit.table','shop.table2','shop.table10']);
  assert.deepEqual(ids(overviewRows(input.filter(t=>t.id.startsWith('shop.')),[],sort)),['shop.table2','shop.table10']);
  const refreshed=structuredClone(input);refreshed[0].indexes.push({},{});
  assert.deepEqual(ids(overviewRows(refreshed,[],sort)),['shop.table10','audit.table','shop.table2']);
  assert.deepEqual(input,original,'sorting must not change the ER model or its table order');
  assert.deepEqual(overviewRows([],[],sort),[]);
});
