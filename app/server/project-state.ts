import { PipelineProject } from './pipeline-watcher.ts';

class ProjectState {
  current: PipelineProject | null = null;

  async load(projectDir: string): Promise<PipelineProject> {
    if (this.current?.projectDir === projectDir) return this.current;
    if (this.current) await this.current.stop();
    const next = new PipelineProject(projectDir);
    next.start();
    this.current = next;
    return next;
  }
}

export const projectState = new ProjectState();
