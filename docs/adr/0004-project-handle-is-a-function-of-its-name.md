# A project's handle is a function of its name; a name whose handle is taken is refused

Code imports scripts of any project in its workspace as `@w/<workspace handle>/<project handle>/scripts/<path>`. A project's handle is derived from its name every time (lowercase, accents dropped, every run of other characters as one `-`, at most 40 characters) and stored nowhere in the repo. Creating, renaming or moving a project whose handle another project of the workspace already has, archived ones included, is refused. A name that yields no handle is refused too. Every environment derives the same handle from the same tree, so an import that works on one branch works after a promotion.

## Considered options

- **A numeric suffix on a clash, as user handles do** (`vendas-br2`): the suffix depends on which project came first, which two servers can see in different orders, so the same import would point at different projects in two environments.
- **A handle stored in the project's file**: what ADR 0002 rejected for slugs, a second name to keep in step with the path, and one a hand-written tree can omit or duplicate.
- **A handle that survives a rename**: imports would not break on a rename, at the cost of a stored handle (above). Broken imports on a rename are accepted for now.

## Consequences

- Renaming a project, or moving it to another workspace, breaks every import of its scripts from other projects; validation reports them as missing scripts. The move rewrites the project's imports of its own scripts.
- Two names that differ only in punctuation or accents ("Vendas BR", "Vendas-BR", "Vendás BR") cannot live in one workspace.
