import { z } from 'zod';
import { validateName } from '@flowtinus/core';
import type { Project } from './project';

export const projectName = z.string().transform((name, ctx) => {
    const { value, error } = validateName(name, [], 'project');
    if (error) {
        ctx.addIssue({ code: 'custom', message: error });
    }
    return value;
});

export const projectDescription = z.string().trim().max(500, 'At most 500 characters');

/** an icon or color name: the editor owns the list (its project-appearance.ts), the server only checks the shape */
export const appearanceKey = z.string().regex(/^[a-z][a-z-]{0,31}$/, 'Invalid');

export type ProjectView = {
    id: string;
    name: string;
    description: string;
    icon: string;
    color: string;
    createdAt: Date;
    archivedAt: Date | null;
    /** read from a work branch the user cannot edit */
    readOnly?: true;
    /** read from a work branch removed on the remote: its changes go to a new branch or are discarded */
    removedBranch?: true;
};

export const toProjectView = (project: Project): ProjectView => ({
    id: project.id,
    name: project.name,
    description: project.description,
    icon: project.icon,
    color: project.color,
    createdAt: project.createdAt,
    archivedAt: project.deletedAt,
});
