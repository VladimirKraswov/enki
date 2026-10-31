import {test} from 'node:test';import assert from 'node:assert/strict';
import crypto from 'node:crypto';import fs from 'node:fs';
import {assertSignedForClients,verifyPublication,publishAndVerify} from './verify.mjs';import {hash} from './packet.mjs';
/** Test-only minisign (legacy 'Ed') key and signatures in the exact wrapped
 * format the release tooling and clients parse. Never a release key. */
function minisignKey(){
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519'),id=crypto.randomBytes(8);
 const raw=publicKey.export({format:'der',type:'spki'}).subarray(-32);
 const wrapped=Buffer.from(`untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'),id,raw]).toString('base64')}\n`).toString('base64');
 const sign=(payload,version)=>{
  const sig=crypto.sign(null,payload,privateKey),comment=`timestamp:1\tfile:packet.json\tversion:${version}`;
  const global=crypto.sign(null,Buffer.concat([sig,Buffer.from(comment)]),privateKey);
  return Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'),id,sig]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
 };
 return {wrapped,sign};
}
function signedRelease(key,{version='1.2.3',fp='a'.repeat(64),kinds={hot:'hot',source:'source'}}={}){
 return Object.fromEntries(Object.entries(kinds).map(([slot,kind])=>{
  const payload=Buffer.from(JSON.stringify({schemaVersion:1,kind,version,nativeFingerprint:fp,notes:'',files:{}}));
  return [slot,{payload:payload.toString('base64'),signature:key.sign(payload,version)}];
 }));
}
test('nothing is published unless both packets verify against the pinned client key',()=>{
 const key=minisignKey(),expected={version:'1.2.3',nativeFingerprint:'a'.repeat(64)};
 assert.doesNotThrow(()=>assertSignedForClients(signedRelease(key),expected,key.wrapped));
 // Signed with a key the clients do not trust (the real pinned updater.pub).
 const pinned=fs.readFileSync(new URL('../../src-tauri/updater.pub',import.meta.url),'utf8');
 assert.throws(()=>assertSignedForClients(signedRelease(key),expected,pinned),/Invalid release signature/);
 // Version, fingerprint or kind slot that differs from this release.
 assert.throws(()=>assertSignedForClients(signedRelease(key,{version:'1.2.4'}),expected,key.wrapped),/Signed version mismatch|does not match/);
 assert.throws(()=>assertSignedForClients(signedRelease(key,{fp:'b'.repeat(64)}),expected,key.wrapped),/does not match this release/);
 assert.throws(()=>assertSignedForClients(signedRelease(key,{kinds:{hot:'source',source:'source'}}),expected,key.wrapped),/does not match this release/);
 // Tampered bytes after signing, and a missing packet.
 const tampered=signedRelease(key);tampered.hot.payload=Buffer.from('{"kind":"hot"}').toString('base64');
 assert.throws(()=>assertSignedForClients(tampered,expected,key.wrapped),/verification failed/);
 assert.throws(()=>assertSignedForClients({hot:signedRelease(key).hot},expected,key.wrapped),/Missing signed source packet/);
});
function fixture(){
 const envelopes=Object.fromEntries(['hot','source'].map(kind=>[kind,{payload:Buffer.from(kind).toString('base64'),signature:`signed-${kind}`}]))
 const head={available:true,version:'1.2.3',nativeFingerprint:'fp',revision:'revision',artifacts:Object.fromEntries(['hot','source'].map(kind=>[kind,{digest:hash(Buffer.from(kind)),bytes:kind.length}]))};
 const download=async digest=>Object.values(envelopes).find(e=>hash(Buffer.from(e.payload,'base64'))===digest);
 return{head,envelopes,download,expected:{version:'1.2.3',nativeFingerprint:'fp'}};
}
test('publication succeeds only after head and both client-download packets match',async()=>{const f=fixture();const receipt=await verifyPublication(f.head,f.expected,f.envelopes,f.download);assert.equal(receipt.version,'1.2.3');assert.equal(Object.keys(receipt.artifacts).length,2);});
test('the Hub-published commit is the contract: a newer local HEAD cannot claim it',async()=>{
 // Same release bytes published from another commit: dispatching or receipting
 // the local HEAD would make CI refuse (published_commit must equal main).
 const f=fixture();f.head.publication={commit:'b'.repeat(40),checks:'operator-attested'};f.expected.commit='a'.repeat(40);
 await assert.rejects(()=>verifyPublication(f.head,f.expected,f.envelopes,f.download),/published Enki 1\.2\.3 from commit b{40}/);
 // Exact commit equality keeps the normal and idempotent paths working.
 const g=fixture();g.head.publication={commit:'a'.repeat(40)};g.expected.commit='a'.repeat(40);
 const receipt=await verifyPublication(g.head,g.expected,g.envelopes,g.download);assert.equal(receipt.publishedCommit,'a'.repeat(40));
 // A Hub that reports no publication commit still verifies by bytes.
 const h=fixture();h.expected.commit='a'.repeat(40);
 assert.equal((await verifyPublication(h.head,h.expected,h.envelopes,h.download)).publishedCommit,undefined);
});
test('unavailable/other/stale heads, missing/mismatched descriptor or failed download cannot mark a release published',async()=>{
 for(const change of [h=>h.available=false,h=>h.version='1.2.2',h=>h.nativeFingerprint='other',h=>delete h.revision,h=>delete h.artifacts.source,h=>h.artifacts.hot.bytes++,h=>h.artifacts.source.digest='other']){
  const f=fixture();change(f.head);await assert.rejects(()=>verifyPublication(f.head,f.expected,f.envelopes,f.download));
 }
 const f=fixture();await assert.rejects(()=>verifyPublication(f.head,f.expected,f.envelopes,async()=>{throw Error('offline')}));
 await assert.rejects(()=>verifyPublication(f.head,f.expected,f.envelopes,async digest=>({...await f.download(digest),signature:'tampered'})));
});

test('lost POST acknowledgement verifies committed release once and never replays publication',async()=>{
 const f=fixture();let writes=0;const result=await publishAndVerify(async()=>{writes++;throw Error('socket hang up')},async()=>f.head,f.expected,f.envelopes,f.download);
 assert.equal(writes,1);assert.equal(result.recoveredAcknowledgement,true);
});
test('an uncommitted failed POST cannot be reported as released or retried',async()=>{
 const f=fixture();let writes=0;await assert.rejects(()=>publishAndVerify(async()=>{writes++;throw Error('socket hang up')},async()=>({...f.head,version:'1.2.2'}),f.expected,f.envelopes,f.download));assert.equal(writes,1);
});
