import type { ProjectDocument } from "../project-model/types";

export interface Command {
  readonly type: string;
  readonly label: string;
  execute(doc: ProjectDocument): ProjectDocument;
  undo(doc: ProjectDocument): ProjectDocument;
}
