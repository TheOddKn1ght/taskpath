import type { Category, Status } from "./types.js";

export interface EditorValues {
  title: string;
  notes: string;
  tags: string[];
  tag: string;
  column: Status;
  category: Category;
  due: string;
  reminder: string;
  reminderAt?: string | null;
}
