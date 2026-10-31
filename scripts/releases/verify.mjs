import {hash} from './packet.mjs';
import {verifyEnvelope} from './device.mjs';
// Before any POST: BOTH locally signed envelopes must verify against the pinned
// client key (src-tauri/updater.pub) and carry exactly this kind, version and
// native fingerprint. A packet signed with another key would be accepted by the
// Hub and then refused by every client.
export function assertSignedForClients(envelopes, expected, publicKey){
  for(const kind of ['hot','source']){
    const envelope=envelopes?.[kind];
    if(typeof envelope?.payload!=='string'||typeof envelope.signature!=='string')throw Error(`Missing signed ${kind} packet`);
    const packet=verifyEnvelope(envelope,hash(Buffer.from(envelope.payload,'base64')),expected.version,publicKey);
    if(packet?.kind!==kind||packet.version!==expected.version||packet.nativeFingerprint!==expected.nativeFingerprint)
      throw Error(`Signed ${kind} packet does not match this release`);
  }
}
// A successful upload is not a successful rollout until the client-facing head
// and BOTH downloadable signed packets match the reviewed local release.
export async function verifyPublication(head, expected, envelopes, download){
  if(head?.available!==true||head.version!==expected.version||head.nativeFingerprint!==expected.nativeFingerprint||typeof head.revision!=='string'||!head.revision)
    throw Error('Published Hub head does not match this release');
  // The Hub records which commit produced this release. CI builds GitHub
  // packages from that exact commit, so a locally newer HEAD (e.g. a tracked
  // checkpoint made after publication) must never be recorded as published.
  const publishedCommit=head.publication?.commit;
  if(expected.commit&&publishedCommit&&publishedCommit!==expected.commit)
    throw Error(`Hub published Enki ${expected.version} from commit ${publishedCommit}, not the verified HEAD ${expected.commit}; commit final docs and checkpoints before release:local`);
  const artifacts={};
  for(const kind of ['hot','source']){
    const wanted=envelopes[kind], raw=Buffer.from(wanted.payload,'base64'),digest=hash(raw),descriptor=head.artifacts?.[kind];
    if(descriptor?.digest!==digest||descriptor.bytes!==raw.length)throw Error(`Hub ${kind} descriptor mismatch`);
    const actual=await download(digest);
    if(actual?.payload!==wanted.payload||actual.signature?.trim()!==wanted.signature.trim())throw Error(`Hub ${kind} downloaded packet mismatch`);
    artifacts[kind]={digest,bytes:raw.length};
  }
  return{version:head.version,nativeFingerprint:head.nativeFingerprint,revision:head.revision,artifacts,...(publishedCommit?{publishedCommit}:{})};
}

export async function publishAndVerify(write, read, expected, envelopes, download) {
  let published, lostAcknowledgement;
  try { published=await write(); } catch(error) { lostAcknowledgement=error; }
  // Never replay a POST: a disconnected response may have committed a release.
  const served=await read();
  if(published&&served.revision!==published.revision)throw Error('Hub channel changed while verifying publication');
  try {
    return {...await verifyPublication(served,expected,envelopes,download),...(lostAcknowledgement?{recoveredAcknowledgement:true}:{})};
  } catch(error) {
    if(lostAcknowledgement)throw new Error('Upload acknowledgement lost; served release did not verify. No publication retry was sent.',{cause:lostAcknowledgement});
    throw error;
  }
}
