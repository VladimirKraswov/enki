import type { MessagePart } from '../api/types';

export type ToolActivityGroup = { kind: 'tools'; parts: MessagePart[]; label: string } | { kind: 'part'; part: MessagePart };

const editTools = new Set(['edit', 'write', 'patch', 'apply_patch', 'str_replace_editor']);
const readTools = new Set(['read', 'grep', 'find', 'glob', 'list_files']);

function category(part: MessagePart): 'edit' | 'read' | 'command' {
  const tool = (part.tool ?? '').toLowerCase();
  if (editTools.has(tool) || /edit|write|patch/.test(tool)) return 'edit';
  if (readTools.has(tool) || /read|grep|search|find|glob/.test(tool)) return 'read';
  return 'command';
}

function groupLabel(parts: MessagePart[]): string {
  const kinds = new Set(parts.map(category));
  const title = kinds.size > 1 ? 'Действия' : kinds.has('edit') ? 'Изменил файлы' : kinds.has('read') ? 'Прочитал файлы' : 'Выполнил команды';
  return `${title} · ${parts.length}`;
}

/** Group consecutive tool events while retaining their original order and details. */
export function groupToolActivities(parts: MessagePart[]): ToolActivityGroup[] {
  const out: ToolActivityGroup[] = [];
  let pending: MessagePart[] = [];
  const flush = () => {
    if (pending.length) out.push({ kind: 'tools', parts: pending, label: groupLabel(pending) });
    pending = [];
  };
  for (const part of parts) {
    if (part.type === 'tool') pending.push(part);
    else { flush(); out.push({ kind: 'part', part }); }
  }
  flush();
  return out;
}

export function toolActivitySummary(parts: MessagePart[]): string[] {
  const totals = new Map<'edit' | 'read' | 'command', number>([['edit', 0], ['read', 0], ['command', 0]]);
  for (const part of parts) if (part.type === 'tool') totals.set(category(part), totals.get(category(part))! + 1);
  return ([
    ['edit', 'Изменил файлы'],
    ['read', 'Прочитал файлы'],
    ['command', 'Выполнил команды'],
  ] as const).flatMap(([kind, label]) => {
    const count = totals.get(kind)!;
    return count ? [`${label}${count > 1 ? ` · ${count}` : ''}`] : [];
  });
}
