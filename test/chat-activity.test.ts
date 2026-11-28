import { describe, expect, it } from 'vitest';
import { groupToolActivities, toolActivitySummary } from '../src/chat/activity';

const part = (id: string, type: string, tool?: string) => ({ id, type, tool, sessionID: 's', messageID: 'm' });

describe('groupToolActivities', () => {
  it('groups adjacent tool calls by readable category and keeps their order', () => {
    const result = groupToolActivities([part('1', 'tool', 'read'), part('2', 'tool', 'bash'), part('3', 'text'), part('4', 'tool', 'edit')]);
    expect(result.map(row => row.kind)).toEqual(['tools', 'part', 'tools']);
    expect(result[0]).toMatchObject({ label: 'Действия · 2', parts: [{id: '1'}, {id: '2'}] });
    expect(result[2]).toMatchObject({ label: 'Изменил файлы · 1', parts: [{id: '4'}] });
  });

  it('labels read and command sequences without merging across message content', () => {
    const result = groupToolActivities([part('1', 'tool', 'read'), part('2', 'tool', 'grep'), part('3', 'reasoning'), part('4', 'tool', 'bash')]);
    expect(result[0]).toMatchObject({label: 'Прочитал файлы · 2'});
    expect(result[2]).toMatchObject({label: 'Выполнил команды · 1'});
  });

  it('summarizes work categories for the collapsed turn row', () => {
    expect(toolActivitySummary([part('1', 'tool', 'edit'), part('2', 'tool', 'read'), part('3', 'tool', 'bash'), part('4', 'tool', 'bash')]))
      .toEqual(['Изменил файлы', 'Прочитал файлы', 'Выполнил команды · 2']);
  });
});
