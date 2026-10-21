import{readFileSync,lstatSync,existsSync}from'node:fs';import{join}from'node:path';import{createHash}from'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex'),id=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function bytes(path,validate,max=65536){validate(path);if(lstatSync(path).size>max)throw Error('Oversized chain record');return readFileSync(path);}
export function verifyLineage(rows,history,validate){
 if(!Array.isArray(rows)||!rows.length||rows.length>8)throw Error('Invalid lineage');const seen=new Set();
 for(let n=0;n<rows.length;n++){
  const r=rows[n];if(Object.keys(r).sort().join(',')!=='intentSHA256,journalSHA256,planSHA256,release'||!id(r.release)||!id(r.journalSHA256)||!id(r.planSHA256)||(n===0?r.intentSHA256!==null:!id(r.intentSHA256))||seen.has(r.release))throw Error('Invalid/cyclic lineage');seen.add(r.release);
  const dir=join(history,r.release),journal=bytes(join(dir,'journal.json'),validate,4096),plan=bytes(join(dir,'plan.json'),validate),j=JSON.parse(journal);
  if(j.release!==r.release||j.phase!=='starting'||j.stateMayHaveChanged!==true||hash(journal)!==r.journalSHA256||hash(plan)!==r.planSHA256)throw Error('Lineage record drift');
  const intentPath=join(dir,'recovery-intent.json');
  if(n===0){if(existsSync(intentPath))throw Error('Unlisted earlier ancestor');continue;}
  const intent=bytes(intentPath,validate,4096),i=JSON.parse(intent),previous=rows[n-1];
  if(hash(intent)!==r.intentSHA256||i.version!==1||i.predecessor!==previous.release||i.successor!==r.release||i.predecessorJournalSHA256!==previous.journalSHA256||i.predecessorPlanSHA256!==previous.planSHA256||i.successorPlanSHA256!==r.planSHA256)throw Error('Partial/substituted lineage');
  const receipt=join(history,previous.release,'recovery-receipt.json');if(existsSync(receipt)&&!bytes(receipt,validate,4096).equals(intent))throw Error('Conflicting ancestor receipt');
 }
}
export function collectLineage(releases,history,validate){
 const rows=releases.map((release,n)=>{if(!id(release))throw Error('Invalid ancestor');const dir=join(history,release);return{release,journalSHA256:hash(bytes(join(dir,'journal.json'),validate,4096)),planSHA256:hash(bytes(join(dir,'plan.json'),validate)),intentSHA256:n?hash(bytes(join(dir,'recovery-intent.json'),validate,4096)):null};});verifyLineage(rows,history,validate);return rows;
}
export function verifyStoredLineage(target,expected,history,validate){const b=bytes(join(target,'recovery-lineage.json'),validate,16384);if(!id(expected)||hash(b)!==expected)throw Error('Lineage digest mismatch');verifyLineage(JSON.parse(b),history,validate);}
