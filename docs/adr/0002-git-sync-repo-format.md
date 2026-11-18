# Git sync: one repository, a branch per environment, the name in the path and the id in the file

Recorded after step 1 (#8). With git on, a workspace lives in one repository, in a folder of its own, and each environment is a branch of it. The topology (environments, their branches, where each promotes, its mode) is a file on `flowtinus/config`, a branch outside the pipeline. A flow's, project's, folder's or connection's name is its path; a flow's, project's and connection's identity is the `id` in its file, never git's rename detection; scripts and folders are identified by their path. The repo is a public format, written by the app, by hand or by other tools (the future VS Code extension, a local Flowtinus), so any valid tree is read in any order and the server never rewrites a branch to normalize it.

## Considered options

- **One `main` with a moving ref per environment**: a promotion is moving a ref, so nothing is reviewed as a pull request, and a protected environment cannot be protected by the provider.
- **One repository per environment**: works only if the repos share history, and every promotion becomes a cross-repo operation.
- **The topology in each server's configuration**: each server sees only its neighbours, and nothing catches two servers that disagree.
- **The topology inside the pipeline's branches**: one copy per branch, promoted with the flows.
- **A stored slug per project, folder and flow**: a rename would not move the file, but the file would no longer be found by the flow's name.
- **An id per script**: a `.py` has nowhere to keep one but a second file.

## Consequences

- Every name must be a valid file name everywhere, with a length limit, unique among siblings whatever the case and after NFC normalization, git on or off.
- Renaming a script changes every flow that calls it, since flows name scripts by path.
- Changing the format later means migrating every repository: the format carries a version (`format: 1` in `workspace.yaml`).
