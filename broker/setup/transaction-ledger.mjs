// Shared real-filesystem journal selection for the macOS adapter and temp tests.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join,dirname } from 'node:path';
const historyParent=dirname;
import{createHash}from'node:crypto';
import{verifyStoredLineage}from'./recovery-chain.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const releaseID=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function readObject(path,validate) {
 validate(path);
 if(lstatSync(path).size>4096)throw Error('Oversized transaction record');
 const value=JSON.parse(readFileSync(path,'utf8'));
 if(!value||Array.isArray(value)||typeof value!=='object')throw Error('Invalid transaction record');
 return value;
}
export function assertCompleteHistory(path,release,validate,seen=new Set()) {
 if(seen.has(release))throw Error('Recovery cycle');seen.add(release);
 validate(path);
 if(!lstatSync(path).isDirectory())throw Error('Unexpected transaction history entry');
 const journal=join(path,'journal.json');
 if(!existsSync(journal))throw Error('Unfinished transaction, including plan without journal: '+release);
 const receipt=join(path,'recovery-receipt.json');
 if(existsSync(receipt)){
  const r=readObject(receipt,validate);
  if(!['predecessor,predecessorJournalSHA256,predecessorPlanSHA256,successor,successorPlanSHA256,version','lineageSHA256,predecessor,predecessorJournalSHA256,predecessorPlanSHA256,successor,successorPlanSHA256,version'].includes(Object.keys(r).sort().join(','))||r.version!==1||r.predecessor!==release||!releaseID(r.successor)||[r.predecessorJournalSHA256,r.predecessorPlanSHA256,r.successorPlanSHA256].some(x=>!releaseID(x)))throw Error('Invalid recovery receipt');
  const child=join(historyParent(path),r.successor),intent=join(child,'recovery-intent.json'),plan=join(path,'plan.json'),childPlan=join(child,'plan.json');
  for(const p of [intent,plan,childPlan])validate(p);
  if(!readFileSync(intent).equals(readFileSync(receipt))||hash(readFileSync(journal))!==r.predecessorJournalSHA256||hash(readFileSync(plan))!==r.predecessorPlanSHA256||hash(readFileSync(childPlan))!==r.successorPlanSHA256)throw Error('Recovery linkage mismatch');
  if(r.lineageSHA256)verifyStoredLineage(child,r.lineageSHA256,historyParent(path),validate);
  assertCompleteHistory(child,r.successor,validate,seen);return;
 }
 const j=readObject(journal,validate);
 if(Object.keys(j).some(k=>!['release','phase','stateMayHaveChanged'].includes(k))||
    j.release!==release||j.phase!=='ready'||j.stateMayHaveChanged!==true)
  throw Error('Another unresolved transaction: '+release);
}
export function claimTransaction({history,activePath,release,validate,writeAtomic}) {
 if(!releaseID(release))throw Error('Invalid release identity');
 validate(history);
 // Scan ALL histories, not just the requested release. This catches pre-pointer
 // drafts, interrupted preparation, and orphan directories as well as journals.
 for(const name of readdirSync(history)){
  if(!releaseID(name))throw Error('Unknown transaction history name');
  const path=join(history,name);validate(path);
  if(name!==release)assertCompleteHistory(path,name,validate);
 }
 if(existsSync(activePath)){
  const active=readObject(activePath,validate);
  if(Object.keys(active).sort().join(',')!=='release,version'||active.version!==1||!releaseID(active.release))
   throw Error('Invalid global transaction pointer');
  if(active.release!==release)assertCompleteHistory(join(history,active.release),active.release,validate);
 }
 // Atomic+durable claim precedes creating the requested directory or any plan.
 // An interrupted claim with no journal still blocks a different release.
 writeAtomic(activePath,JSON.stringify({version:1,release})+'\n');
}
