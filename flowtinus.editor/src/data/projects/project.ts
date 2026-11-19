import { NAME_MAX, validateName } from '@flowtinus/core';
import { isProjectColor, isProjectIcon, type ProjectColorName, type ProjectIconName } from './project-appearance';

/*
 * Projects as the editor sees them (projects-api.ts loads and saves them on flowtinus.server). validateNewProject has the
 * same rules as the server's create-project, for instant feedback in the form; the server checks again.
 * icon and color are names from project-appearance.ts: the editor owns that list, the server stores the names.
 */

export type Project = {
    id: string;
    name: string;
    description: string;
    icon: ProjectIconName;
    color: ProjectColorName;
    createdAt: Date;
    /** when it was archived; null while it is active */
    archivedAt: Date | null;
    /** what it holds (the projects' list has it) */
    summary?: ProjectSummary;
    /** read from a branch the user cannot edit */
    readOnly?: boolean;
    /** read from a work branch removed on the remote: its changes go to a new branch or are discarded */
    removedBranch?: boolean;
};

/** a project's active flows (and how many are deployed) and scripts (connections, secrets and variables are the workspace's) */
export type ProjectSummary = { flows: number; deployed: number; scripts: number };

export type SummaryItem = { key: 'flows' | 'deployed' | 'scripts'; text: string; title: string };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** what a project holds as its card says it, in the order of its tabs */
export function summaryItems(summary: ProjectSummary): SummaryItem[] {
    return [
        { key: 'flows', text: plural(summary.flows, 'flow'), title: 'Active flows' },
        { key: 'deployed', text: `${summary.deployed} deployed`, title: 'Flows deployed in this environment' },
        { key: 'scripts', text: plural(summary.scripts, 'script'), title: 'Scripts' },
    ];
}

export type NewProject = Pick<Project, 'name' | 'description' | 'icon' | 'color'>;

export type NewProjectErrors = Partial<Record<keyof NewProject, string>>;

export { NAME_MAX };
export const DESCRIPTION_MAX = 500;

/** the fields trimmed, and the error of each invalid one (none = can be saved); `exceptId` is the project being edited */
export function validateNewProject(
    input: NewProject,
    existing: Project[],
    exceptId?: string,
): { value: NewProject; errors: NewProjectErrors } {
    const name = validateName(
        input.name,
        existing.filter(project => project.id !== exceptId),
        'project',
    );
    const value = { ...input, name: name.value, description: input.description.trim() };
    const errors: NewProjectErrors = name.error ? { name: name.error } : {};

    if (value.description.length > DESCRIPTION_MAX) {
        errors.description = `At most ${DESCRIPTION_MAX} characters`;
    }

    if (!isProjectIcon(value.icon)) {
        errors.icon = 'Unknown icon';
    }

    if (!isProjectColor(value.color)) {
        errors.color = 'Unknown color';
    }

    return { value, errors };
}
