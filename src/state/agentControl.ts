/** Native control gateway status (src-tauri/src/control.rs `AgentControlStatus`). */
export interface AgentControlStatus {
  supported: boolean;
  ready: boolean;
  command: string;
  descriptorPath: string;
  protocol: number;
}
