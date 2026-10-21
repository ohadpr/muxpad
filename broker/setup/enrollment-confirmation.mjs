// Used only after the trusted bootstrap has verified the entire protected stage.
// Transport adapter must use the fixed private socket, never an HTTP relay.
const keys = ['candidateID','credentialID','fingerprint','rpID','origin','generation'];
export function parseConfirmation(raw, mode) {
 if (typeof raw !== 'string' || Buffer.byteLength(raw)>4096) throw Error('Invalid setup confirmation');
 const c=JSON.parse(raw);
 if(!c||Array.isArray(c)||Object.keys(c).sort().join(',')!==[...keys].sort().join(',')||
   typeof c.candidateID!=='string'||!/^[a-f0-9-]{36}$/.test(c.candidateID)||
   typeof c.credentialID!=='string'||!/^[A-Za-z0-9_-]{1,2048}$/.test(c.credentialID)||
   typeof c.fingerprint!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(c.fingerprint)||
   c.rpID!==mode.passkeyRPID||c.origin!==mode.passkeyOrigin||c.generation!==mode.passkeyGeneration)
  throw Error('Exact browser setup confirmation required');
 return c;
}
export function matchingRegistration(status, receipt) {
 return status?.registered===true&&status.storageFault===false&&
  ['credentialID','fingerprint','rpID','origin','generation'].every(k=>status[k]===receipt[k]);
}
export async function confirmExact(receipt, transport) {
 // A response may be lost after successful persistence. Read-only reconciliation
 // is permitted; repeating the mutation or picking a different key is not.
 const before=await transport('GET','/status');
 if(before.storageFault) throw Error('Setup storage uncertain; trusted reconciliation required');
 if(before.registered){
  if(!matchingRegistration(before,receipt))throw Error('Different active credential; refuse replacement');
  return;
 }
 try{await transport('POST','/confirm-enrollment',receipt);}catch{/* Reconcile only, never repeat. */}
 const after=await transport('GET','/status');
 if(!matchingRegistration(after,receipt))throw Error('Exact setup not confirmed; transaction remains starting');
}
