import { z } from 'zod';
import { handleOf, handleTakenMessage, validateName } from '@flowtinus/core';
import { fail } from '#shared/use-cases/use-case-result';
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
    handle: string;
    description: string;
    icon: string;
    color: string;
    createdAt: Date;
    archivedAt: Date | null;
    readOnly?: true;
    removedBranch?: true;
};

export const toProjectView = (project: Project): ProjectView => ({
    id: project.id,
    name: project.name,
    handle: handleOf(project.name),
    description: project.description,
    icon: project.icon,
    color: project.color,
    createdAt: project.createdAt,
    archivedAt: project.deletedAt,
});

export const handleTaken = (name: string, holder: { name: string; deletedAt: Date | null }, there?: { workspace: string; field: string }) =>
    fail('conflict', handleTakenMessage(name, { name: holder.name, archived: holder.deletedAt !== null, workspace: there?.workspace }), {
        [there?.field ?? 'name']: `Handle taken by "${holder.name}"`,
    });
