import {openSync,closeSync,readSync,readFileSync,existsSync,writeSync} from 'node:fs';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {parseConfirmation,confirmExact,matchingRegistration} from './enrollment-confirmation.mjs';
function terminalLine(prompt,max=4096){
 const fd=openSync('/dev/tty','r+');
 try{
  writeSync(fd,prompt);let out='';const byte=Buffer.alloc(1);
  while(Buffer.byteLength(out)<=max){
   if(readSync(fd,byte,0,1,null)!==1)throw Error('Trusted terminal input ended');
   if(byte[0]===10)return out.trim();out+=byte.toString('utf8');
  }
  throw Error('Terminal input too long');
 }finally{closeSync(fd);}
}
export async function completeSetup({tx,mode,transport,progress,validate,atomic,prompt=terminalLine,secret=()=>randomBytes(32).toString('base64url'),uuid=randomUUID}){
 const current=tx+'/enrollment-current.json';validate(current,{optional:true});
 const status=await transport('GET','/status');
 if(status.storageFault)throw Error('Setup storage uncertain; trusted reconciliation required');
 let prior=existsSync(current)?JSON.parse(readFileSync(current,'utf8')):null;
 if(status.registered){
  if(!prior||typeof prior.operationID!=='string'||!/^[a-f0-9-]{36}$/.test(prior.operationID))throw Error('No exact local setup record');
  const path=tx+'/confirmation-'+prior.operationID+'.json';validate(path);
  const receipt=parseConfirmation(readFileSync(path,'utf8'),mode);
  if(!matchingRegistration(status,receipt))throw Error('Active key differs from locally confirmed receipt');
  return;
 }
 if(prior){
  const answer=prompt('Setup is incomplete. Type NEW SETUP to retire only the old pending setup, or stop: ',40);
  if(answer!=='NEW SETUP')throw Error('Setup not renewed; transaction remains starting');
 }
 const e=status.enrollment;
 if(!e||Object.keys(e).sort().join(',')!=='candidateFingerprint,candidateID,leaseID')throw Error('Invalid private enrollment state');
 for(const key of ['candidateID','candidateFingerprint','leaseID'])if(e[key]!==null&&typeof e[key]!=='string')throw Error('Invalid private enrollment state');
 const capability=secret(),operationID=uuid();
 const body={operationID,secretHash:createHash('sha256').update(capability).digest('base64url'),
  previousLeaseID:e.leaseID,candidateID:e.candidateID,candidateFingerprint:e.candidateFingerprint,
  rpID:mode.passkeyRPID,origin:mode.passkeyOrigin,generation:mode.passkeyGeneration};
 // Persist the exact operation and secret before issuance. No state file reads,
 // generic writes, automatic secret regeneration or anonymous latest selection.
 atomic(current,JSON.stringify({operationID,body,capability})+'\n',0o600);
 let issued;
 try{issued=await transport('POST','/begin-enrollment',body);}catch{
  const observed=await transport('GET','/status');
  if(observed.enrollment?.leaseID!==operationID)throw Error('Setup lease uncertain; stop and resume same transaction');
 }
 if(issued&&issued.operationID!==operationID)throw Error('Mismatched setup lease');
 progress('Open muxpad Settings → Slack approval passkey on '+mode.passkeyOrigin+'.');
 progress('Choose Create passkey with this one-use setup code (not a Slack credential): '+capability);
 const raw=prompt('After 1Password creates the passkey, copy setup confirmation from Settings and paste it here: ',4096);
 const receipt=parseConfirmation(raw,mode);
 // Bind browser-derived public key receipt before mutating the live broker.
 atomic(tx+'/confirmation-'+operationID+'.json',JSON.stringify(receipt)+'\n',0o600);
 await confirmExact(receipt,transport);
 progress('Exact passkey key confirmed. No Slack action was approved by setup.');
}
