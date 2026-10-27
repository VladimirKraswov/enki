/** Only the bridge's discovery failure, never a failed/uncertain tool action. */
export function isMcpStartupNotice(text: string): boolean {
  return text.endsWith("Действия сервиса при подключении не запускались.")
    && text.includes("Не удалось подключиться к сервису MCP.");
}

/** One automatic recovery for a failed discovery episode. A fresh connected
 * report releases the budget; another failure does not create a retry loop. */
export class McpRecoveryBudget {
  private attempted = new Set<string>();
  hasAttempted(key: string): boolean { return this.attempted.has(key); }
  claim(key: string): boolean {
    if (this.attempted.has(key)) return false;
    this.attempted.add(key);
    while (this.attempted.size > 256) this.attempted.delete(this.attempted.values().next().value!);
    return true;
  }
  connected(key: string): void { this.attempted.delete(key); }
}
