// Shared plan projection: retain only display fields, with explicit size/depth bounds.
export function normalizePlan(input) {
  const root=Array.isArray(input)?input[0]:input;
  if(!root||typeof root!=='object'||!root.Plan)throw new Error('Expected a PostgreSQL JSON execution plan.');
  let count=0;
  const num=(o,k)=>typeof o[k]==='number'&&Number.isFinite(o[k])&&o[k]>=0?o[k]:null;
  const str=(o,k)=>typeof o[k]==='string'?o[k].slice(0,8192):null;
  function walk(p,depth){
    if(!p||typeof p!=='object'||Array.isArray(p)||++count>1000||depth>40||typeof p['Node Type']!=='string')throw new Error('Plan is invalid or exceeds 1,000 nodes / 40 levels.');
    if(p.Plans!==undefined&&!Array.isArray(p.Plans))throw new Error('Invalid child plans.');
    const node={id:count,type:str(p,'Node Type'),schema:str(p,'Schema'),relation:str(p,'Relation Name'),alias:str(p,'Alias'),index:str(p,'Index Name'),join:str(p,'Join Type'),
      estimatedRows:num(p,'Plan Rows'),actualRows:num(p,'Actual Rows'),loops:num(p,'Actual Loops'),totalTime:num(p,'Actual Total Time'),cost:num(p,'Total Cost'),
      hits:num(p,'Shared Hit Blocks'),reads:num(p,'Shared Read Blocks'),tempRead:num(p,'Temp Read Blocks'),tempWritten:num(p,'Temp Written Blocks'),
      removed:num(p,'Rows Removed by Filter'),heapFetches:num(p,'Heap Fetches'),sortMethod:str(p,'Sort Method'),sortSpace:str(p,'Sort Space Type'),
      conditions:['Index Cond','Filter','Recheck Cond','Hash Cond','Merge Cond','Join Filter'].flatMap(k=>typeof p[k]==='string'?[{label:k,text:str(p,k)}]:[]),children:[]};
    node.children=(p.Plans||[]).map(c=>walk(c,depth+1));return node;
  }
  const plan=walk(root.Plan,0),nodes=[];
  const visit=n=>{nodes.push(n);n.children.forEach(visit);};visit(plan);
  const findings=[];
  for(const n of nodes){
    if(n.actualRows!==null&&n.loops>0&&n.estimatedRows!==null){const ratio=Math.max(n.actualRows,1)/Math.max(n.estimatedRows,1);if(ratio>=10||ratio<=.1)findings.push({node:n.id,text:`${n.type}: actual rows differ from the estimate by ${Math.max(ratio,1/ratio).toFixed(1)}×.`});}
    if(n.removed>1000&&n.removed>10*Math.max(n.actualRows||0,1))findings.push({node:n.id,text:`${n.type}: many rows are discarded by a filter. Inspect the predicate and index definitions.`});
    if(n.sortSpace==='Disk'||n.tempWritten>0)findings.push({node:n.id,text:`${n.type}: temporary disk I/O is reported. Inspect sorts, hashes and row volume.`});
  }
  return {plan,nodeCount:count,planningMs:num(root,'Planning Time'),executionMs:num(root,'Execution Time'),
    query:str(root,'Query Text'),settings:root.Settings&&typeof root.Settings==='object'?Object.entries(root.Settings).slice(0,30).map(([k,v])=>({name:k.slice(0,100),value:String(v).slice(0,300)})):[],
    measured:nodes.some(n=>n.actualRows!==null),indexes:[...new Set(nodes.filter(n=>n.actualRows===null||n.loops>0).map(n=>n.index).filter(Boolean))],
    scans:nodes.filter(n=>/Scan/.test(n.type)).map(n=>({id:n.id,type:n.type,schema:n.schema,relation:n.relation,index:n.index,loops:n.loops})),findings:findings.slice(0,50)};
}

export function comparePlans(a,b){
  const metric=(label,av,bv,unit='')=>({label,a:av,b:bv,delta:av===null||bv===null?null:bv-av,percent:av>0&&bv!==null?(bv-av)/av*100:null,unit});
  return [metric('Execution time',a.executionMs,b.executionMs,'ms'),metric('Planning time',a.planningMs,b.planningMs,'ms'),
    metric('Shared buffer hits',a.plan.hits,b.plan.hits),metric('Shared blocks read',a.plan.reads,b.plan.reads),
    metric('Temporary blocks written',a.plan.tempWritten,b.plan.tempWritten),metric('Output rows per loop',a.plan.actualRows,b.plan.actualRows),metric('Estimated cost',a.plan.cost,b.plan.cost)];
}
