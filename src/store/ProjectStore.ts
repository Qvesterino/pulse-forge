import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";
import { normalizeProject } from "../project-model/schema";

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

export class ProjectStore {
  private doc_: ProjectDocument;
  private listeners = new Set<() => void>();
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private saveStatus_: SaveStatus = "saved";
  onDocChanged: ((doc: ProjectDocument) => void) | null = null;

  constructor(initial: ProjectDocument) {
    this.doc_ = initial;
  }

  get doc(): ProjectDocument {
    return this.doc_;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get lastCommandLabel(): string | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1].label : null;
  }

  get saveStatus(): SaveStatus {
    return this.saveStatus_;
  }

  setSaveStatus(status: SaveStatus): void {
    this.saveStatus_ = status;
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getDoc = (): ProjectDocument => this.doc_;

  getSaveStatus = (): SaveStatus => this.saveStatus_;

  execute(command: Command): void {
    this.doc_ = command.execute(this.doc_);
    this.undoStack.push(command);
    if (this.undoStack.length > 256) this.undoStack.shift();
    this.redoStack = [];
    this.afterMutation();
  }

  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    this.doc_ = command.undo(this.doc_);
    this.redoStack.push(command);
    this.afterMutation();
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    this.doc_ = command.execute(this.doc_);
    this.undoStack.push(command);
    this.afterMutation();
  }

  replaceDoc(doc: ProjectDocument): void {
    this.doc_ = normalizeProject(doc);
    this.undoStack = [];
    this.redoStack = [];
    this.afterMutation();
  }

  private afterMutation(): void {
    this.saveStatus_ = "dirty";
    this.emit();
    this.onDocChanged?.(this.doc_);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
