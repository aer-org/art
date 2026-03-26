export interface StageTemplate {
  name: string;
  type: 'agent' | 'command';
  description: string;
  prompt: string;
  mounts: Record<string, 'ro' | 'rw' | null>;
  transitions: Array<{
    marker: string;
    next: string | null;
    prompt?: string;
  }>;
  /** Shell command to run (command-type stages only) */
  command?: string;
  /** Container image override */
  image?: string;
  /** Enable GPU passthrough */
  gpu?: boolean;
  /** Environment variables that must be set before the stage runs */
  requiredEnv?: string[];
}
