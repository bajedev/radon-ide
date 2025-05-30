import { BuildProgressProcessor } from "./BuildProgressProcessor";

export class BuildAndroidProgressProcessor implements BuildProgressProcessor {
  private completedTasks: number = 0;
  private tasksToComplete: number = 0;

  constructor(private progressListener: (newProgress: number) => void) {}

  private updateProgress() {
    if (!this.tasksToComplete) {
      return;
    }
    // the 0.999 max value is here to prevent situations in which users see 100% indiction,
    // but the build process is still takeing a couple more seconds.
    this.progressListener(Math.min(0.999, this.completedTasks / this.tasksToComplete));
  }

  processLine(line: string): void {
    const taskGrapfSizeMatch = /RadonIDE:TaskGraphSize: (\d+)/m.exec(line);

    if (taskGrapfSizeMatch) {
      this.tasksToComplete += Number(taskGrapfSizeMatch[1]);
    }
    const taskExecutedMatch = /> Task /m.exec(line);
    if (taskExecutedMatch) {
      this.completedTasks++;
      this.updateProgress();
    }
  }
}
