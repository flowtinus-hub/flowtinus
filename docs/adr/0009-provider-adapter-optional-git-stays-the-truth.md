# Git sync: the provider adapter is optional, turns on with a token that can use the API, and git stays the truth

Recorded with git sync step 7. Through the git provider's API (GitLab first) the app opens its pull requests, reads a pull request's state, the project's merge settings and the branches' protection. There is no setting for it: the adapter is on when the provider is known from the remote's URL and the workspace's token can use the API, and it falls back to pushing the branch and linking to the provider's page when the token cannot, or the API stops answering. Whether a promotion or a backport was merged, or reached its target by a squash, is still read from git ([ADR 0007](0007-promotion-state-read-from-git.md)); the provider adds only what git cannot tell: that the pull request exists (its number and link) and that it was closed without merging. Its settings and its branch protection warn or block before the harm, never replace what git shows after it.

## Considered options

- **The pull request's state as the truth** (merged when the provider says so): exact on GitLab, but every state rule would then depend on an adapter, a plain git server would have none, and the provider says "merged" for a squash that broke the lineage.
- **An explicit setting to turn the adapter on**: one more thing to configure and keep in step with the token; the token's scope already says whether the API can be used, and the access test reports it.
- **A second secret for the API**: a token without the `api` scope for git and one with it for the API; GitLab's `api` scope covers both, and two tokens double what can expire.
- **Acting as each user on the provider**: the pull request's author would be the app's user, but it needs a token per user (OAuth with the provider), out of scope; the app's user is named in the description instead.

## Consequences

- Everything works with a plain git server and a token without the `api` scope, as before this step: the adapter only adds.
- The pull request's author on the provider is the token's owner, ideally a service account.
- A token that loses its scope degrades to push and link without an error in the user's way; the git section says why.
- The GitHub adapter implements the same interface, and the same rule: git decides what was merged.
