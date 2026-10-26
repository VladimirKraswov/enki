/** History's pending tool is not proof that a process is still running. */
export type ExecutionEvidence = 'active' | 'waiting' | 'unconfirmed' | 'inactive';
export function executionEvidence(completed: boolean, busy: boolean, connected: boolean, waitingForUser = false): ExecutionEvidence {
  if (completed) return 'inactive';
  if (!connected) return 'unconfirmed';
  if (busy && waitingForUser) return 'waiting';
  return busy ? 'active' : 'inactive';
}
export function executionLabel(evidence: ExecutionEvidence) {
  return evidence === 'active' ? 'выполняется' : evidence === 'waiting' ? 'ожидает вашего ответа'
    : evidence === 'unconfirmed' ? 'статус не подтверждён: нет связи' : 'выполнение не подтверждено сервером';
}
