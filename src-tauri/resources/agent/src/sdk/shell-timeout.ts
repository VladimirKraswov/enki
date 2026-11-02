/** Host shell policy; explicit limits (including SDK-invalid values) are left
 * to the SDK. This is a default, not a ceiling on long builds or downloads. */
export const DEFAULT_SHELL_TIMEOUT_SECONDS = 1800;

export function withShellTimeout<T extends { command: string; timeout?: number }>(input: T): T & { timeout: number } {
  return { ...input, timeout: input.timeout === undefined ? DEFAULT_SHELL_TIMEOUT_SECONDS : input.timeout };
}
