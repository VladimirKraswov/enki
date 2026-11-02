import {expect,it,vi} from 'vitest';
import {transportDiagnostic,setTransportOrigin,reportTransportFailure,pendingTransportFailures,acknowledgeTransportFailures} from '../src/hub/transportDiagnostics';
import {drain} from '../src/hub/client';
import {capabilityNative} from '../src/capabilities/integration';
vi.mock('../src/capabilities/integration',()=>({capabilityNative:vi.fn(),invalidateCapabilities:vi.fn()}));

it('a connection failure sends only a bounded code and actual session, never raw errors or URLs',()=>{
 const log=transportDiagnostic('session-1','https://private/?token=secret Bearer private','event-stream');
 expect(log).toMatchObject({session:'session-1',code:'stream.transport',detail:'',agent:'desktop'});
 expect(JSON.stringify(log)).not.toMatch(/private|secret|https/);
 expect(log.observed).toBeGreaterThan(0);
});

it('pending diagnostics cannot cross Hub profiles and disabled sharing does not capture history',()=>{
 setTransportOrigin(null);reportTransportFailure('disabled','offline','stream');
 setTransportOrigin('first');reportTransportFailure('first-session','offline','stream');
 setTransportOrigin('second');reportTransportFailure('second-session','offline','stream');
 expect(pendingTransportFailures('first').map(v=>v.session)).toEqual(['first-session']);
 expect(pendingTransportFailures('second').map(v=>v.session)).toEqual(['second-session']);
 acknowledgeTransportFailures([...pendingTransportFailures('first'),...pendingTransportFailures('second')].map(v=>v.requestId));
 setTransportOrigin(null);
});

it('partial batch delivery keeps the same diagnostic IDs queued until all acknowledgements arrive',async()=>{
 const log=transportDiagnostic('s','event stream HTTP 401','event-stream');
 const batch={origin:'pinned',records:[{engine:'pi',id:'m'},{workshopLog:log}],hashes:['history','log'],pending:2,dropped:0};
 let fail=true;
 vi.mocked(capabilityNative).mockImplementation(async(name,args:any)=>{
  if(name==='hub_spool'&&args.action==='read')return batch;
  if(name==='hub_request'&&args.path==='workshop/logs'&&fail)throw Error('lost acknowledgement');
  return {accepted:true};
 });
 await expect(drain()).rejects.toThrow('lost acknowledgement');
 expect(vi.mocked(capabilityNative).mock.calls.some(([n,a]:any)=>n==='hub_spool'&&a.action==='ack')).toBe(false);
 fail=false;await drain();
 const requests=vi.mocked(capabilityNative).mock.calls.filter(([n,a]:any)=>n==='hub_request'&&a.path==='workshop/logs');
 expect(requests.map(([,a]:any)=>a.body.requestId)).toEqual([log.requestId,log.requestId]);
 expect(vi.mocked(capabilityNative).mock.calls.at(-1)).toEqual(['hub_spool',{action:'ack',records:null,hashes:['history','log'],expected:'pinned'}]);
});
