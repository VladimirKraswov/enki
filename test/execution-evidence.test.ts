import { expect, it } from 'vitest';
import { executionEvidence, executionLabel } from '../src/chat/execution';
it('a real pending user interaction is waiting, not active work; disconnected state stays unconfirmed',()=>{
 expect(executionEvidence(false,true,true,true)).toBe('waiting');
 expect(executionLabel('waiting')).toBe('ожидает вашего ответа');
 expect(executionEvidence(false,true,false,true)).toBe('unconfirmed');
});
it('does not infer live execution from unfinished history when disconnected or idle',()=>{
 expect(executionEvidence(false,true,false)).toBe('unconfirmed');
 expect(executionEvidence(false,false,true)).toBe('inactive');
 expect(executionEvidence(true,true,true)).toBe('inactive');
 expect(executionEvidence(false,true,true)).toBe('active');
 expect(executionLabel('unconfirmed')).toContain('нет связи');
});
