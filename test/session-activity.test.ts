import {expect,it} from 'vitest';
import {hasActiveSessions} from '../src/state/activity';
it('a live idle update supersedes a stale busy directory snapshot for the same session',()=>{
 expect(hasActiveSessions({statuses:{old:{type:'busy'}},activityStatuses:{old:{type:'idle'}}})).toBe(false);
 expect(hasActiveSessions({statuses:{old:{type:'busy'},other:{type:'busy'}},activityStatuses:{old:{type:'idle'}}})).toBe(true);
 expect(hasActiveSessions({statuses:{old:{type:'idle'}},activityStatuses:{old:{type:'busy'}}})).toBe(true);
});
