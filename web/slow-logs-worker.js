import { parseSlowLogs, LOG_LIMITS } from './slow-logs.js';
self.onmessage=async({data})=>{
  try{
    if(!(data?.file instanceof File)||data.file.size<=0||data.file.size>LOG_LIMITS.bytes)throw new Error('Choose a non-empty log file up to 2 MB.');
    const bytes=await data.file.arrayBuffer();
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    self.postMessage({result:parseSlowLogs(text,data.database)});
  }catch{self.postMessage({error:'Could not parse this log. Use a UTF-8 PostgreSQL JSON-lines or plain-text file up to 2 MB.'});}
};
