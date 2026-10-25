import { expect, it } from 'vitest';
import { executionFeedback } from '../src-tauri/resources/browser/execution-feedback.mjs';
import { createToolGate } from '../src-tauri/resources/pi/tool-gate';
import { legacyV2ToolWorkflowReminder, toolWorkflowReminder } from '../src-tauri/resources/agent/src/policy/toolWorkflow';
import { visiblePromptText } from '../src-tauri/resources/agent/src/policy/prompt';

it('recognizes only the Pi bash executor timeout marker on a failed result', () => {
  const result = executionFeedback('pi', 'bash', 'log\n'.repeat(5000) + 'Command timed out after 1.5 seconds', true);
  expect(result?.outcome).toBe('timed_out');
  expect(result?.message).toContain('проверка не завершена успешно');
});

it('does not turn ordinary timeout logs, successful results or other tools into failure', () => {
  for (const output of ['request timeout', 'Command exited with code 1', 'example: Command timed out after 10 seconds\nprocess succeeded'])
    expect(executionFeedback('pi', 'bash', output, true)).toBeUndefined();
  expect(executionFeedback('pi', 'bash', 'Command timed out after 10 seconds', false)).toBeUndefined();
  expect(executionFeedback('pi', 'read', 'Command timed out after 10 seconds', true)).toBeUndefined();
  // The removed OpenCode executor has no marker any more.
  expect(executionFeedback('opencode', 'bash', 'Command timed out after 10 seconds', true)).toBeUndefined();
});

it('the runtime gate preserves images/text and labels the timeout as an error', async () => {
  const handlers: Record<string, (event: any, ctx?: any) => Promise<any> | any> = {};
  createToolGate({
    decide: () => ({ decision: 'allow' }), approve: async () => false,
    feedback: (tool, output, isError) => executionFeedback('pi', tool, output, isError),
  })({ on: (name: string, handler: any) => { handlers[name] = handler; } } as never);
  const content = [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'log\n\nCommand timed out after 1.5 seconds' }];
  const event = { toolName: 'bash', content, isError: true };
  const result = await handlers.tool_result(event);
  expect(result?.isError).toBe(true);
  expect(result.content.slice(0, 2)).toEqual(content);
  expect(content).toHaveLength(2);
  expect(result.content[2].text).toBe(executionFeedback('pi', 'bash', content[1].text, true)?.message);
  expect(await handlers.tool_result({ ...event, isError: false })).toBeUndefined();
});

it('a gate without feedback cannot change results and still enforces approval', async () => {
  const handlers: Record<string, (event: any, ctx?: any) => Promise<any> | any> = {};
  createToolGate({ decide: () => ({ decision: 'ask', permission: 'bash', pattern: '*' }), approve: async () => false })(
    { on: (name: string, handler: any) => { handlers[name] = handler; } } as never);
  expect(await handlers.tool_result({ toolName: 'bash', content: [], isError: false })).toBeUndefined();
  expect(await handlers.tool_call({ toolName: 'bash', toolCallId: 'c', input: {} }, { cwd: '/p' })).toMatchObject({ block: true });
});

it('refreshed guidance and old v2 histories stay hidden only in their own session', () => {
  for (const block of [legacyV2ToolWorkflowReminder('own'), toolWorkflowReminder('own')]) {
    expect(visiblePromptText('request\n\n' + block, 'own')).toBe('request');
    expect(visiblePromptText('request\n\n' + block, 'other')).toBe('request\n\n' + block);
    expect(visiblePromptText('quote:' + block, 'own')).toBe('quote:' + block);
  }
});
