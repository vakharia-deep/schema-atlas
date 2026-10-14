export const overviewColumns = [
  {key:'name',label:'Table'},
  {key:'type',label:'Type'},
  {key:'partitioning',label:'Partitioning'},
  {key:'columns',label:'Columns',numeric:true},
  {key:'indexes',label:'Indexes',numeric:true},
  {key:'foreignKeys',label:'Foreign keys',numeric:true},
  {key:'estimatedRows',label:'Est. rows',numeric:true},
  {key:'totalBytes',label:'Total size',numeric:true},
  {key:'indexBytes',label:'Index size',numeric:true},
  {key:'dataBytes',label:'Data size',numeric:true},
];
const collator = new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
function integer(value) {
  // PostgreSQL bigint statistics arrive as strings; retain their full precision.
  if(typeof value==='string'&&/^\d{1,20}$/.test(value))return BigInt(value);
  if(typeof value==='number'&&Number.isInteger(value)&&value>=0)return BigInt(value);
  return null;
}

export function overviewRows(tables,relationships,{column='name',direction='ascending'}={}) {
  const selected=overviewColumns.find(c=>c.key===column)||overviewColumns[0];
  const references=new Map();
  for(const r of relationships)if(r.kind==='foreign_key')references.set(r.from,(references.get(r.from)||0)+1);
  const rows=tables.map(table=>{
    const strategy=table.partitions.find(p=>p.type==='strategy');
    const row={
      table,name:table.id,
      type:strategy?'Partitioned table':table.partitionOf?'Partition':table.kind||'Table',
      partitioning:[strategy?`${strategy.key} · ${table.partitions.filter(p=>p.type==='child').length} children`:null,table.partitionOf?`Partition of ${table.partitionOf}`:null].filter(Boolean).join(' · ')||'Not partitioned',
      columns:table.columns.length,indexes:table.indexes.length,foreignKeys:references.get(table.id)||0,
      estimatedRows:table.statistics?.estimatedRows,totalBytes:table.statistics?.totalBytes,
      indexBytes:table.statistics?.indexBytes,dataBytes:table.statistics?.dataBytes,
    };
    return {row,value:selected.numeric?integer(row[selected.key]):row[selected.key]};
  });
  const sign=direction==='descending'?-1:1;
  rows.sort((a,b)=>{
    // Missing statistics remain last in either direction; zero is a known value.
    if(a.value==null&&b.value!=null)return 1;
    if(b.value==null&&a.value!=null)return -1;
    const comparison=a.value==null?0:selected.numeric?(a.value<b.value?-1:a.value>b.value?1:0):collator.compare(a.value,b.value);
    return sign*comparison||collator.compare(a.row.name,b.row.name)||a.row.name.localeCompare(b.row.name);
  });
  return rows.map(({row})=>row);
}
