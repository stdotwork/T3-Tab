/** Which project a new thread starts in. */
import type { Project } from './t3-client';

/** The stored value for "no project". T3 runs such a thread in its Scratch project. */
export const NO_PROJECT = 'none';
/** The stored default that means "the project I used last". */
export const LAST_PROJECT = 'last';
/** Where the owner's default for a tab that has not picked a project is kept. */
export const DEFAULT_PROJECT_KEY = 'newThread.defaultProject';

/** What the panel calls a project: T3's Scratch project is "No project" everywhere, as the pickers and the thread list say. */
export function projectName(project: Project, scratchRoot: string | undefined): string {
  return project.workspaceRoot === scratchRoot ? 'No project' : project.title;
}

/** The projects a picker lists: T3's Scratch project is the "No project" row, not a project of its own. */
export function pickableProjects(projects: readonly Project[], scratchRoot: string | undefined): Project[] {
  return projects.filter((project) => project.workspaceRoot !== scratchRoot);
}

/**
 * The project this tab's new thread is in, or undefined for no project. The tab's own pick wins, then the owner's
 * default. A project that no longer exists counts as no project. When T3 offers no Scratch project, a thread needs a
 * real one, so the first is used.
 */
export function resolveProject(input: {
  projects: readonly Project[];
  tabChoice: string | undefined;
  defaultProject: string;
  lastProject: string | undefined;
  noProjectAvailable: boolean;
}): Project | undefined {
  const { projects, tabChoice, defaultProject, lastProject, noProjectAvailable } = input;
  const wanted = tabChoice ?? (defaultProject === LAST_PROJECT ? (lastProject ?? NO_PROJECT) : defaultProject);
  const found = projects.find((project) => project.id === wanted);
  return found ?? (noProjectAvailable ? undefined : projects[0]);
}
