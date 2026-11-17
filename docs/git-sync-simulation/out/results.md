# git-sim raw results

git version 2.54.0.windows.1, bun 1.4.4. Flow files written by the core's flowToYaml; validity checked by the core's flowFromYaml plus repo-wide checks.
Seed workspace: Load orders.yaml: 20 nodes, 360 lines; Sync customers.yaml: 12 nodes, 218 lines; Monthly invoices.yaml: 28 nodes, 497 lines. Seed tree: valid.
Canonical writer is stable (read + write again gives no diff): true

## Scenario 1: promotion chain with merge commits, three rounds

### 1 (merge commits)

Round 1: before promotion, commits on dev not in staging: 1

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

Round 1: trees dev/staging identical, staging/prod identical; staging..dev = 0; valid
Round 2: before promotion, commits on dev not in staging: 1

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml    | 2 +-
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 2 files changed, 2 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml    | 2 +-
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 2 files changed, 2 insertions(+), 2 deletions(-)
```

Round 2: trees dev/staging identical, staging/prod identical; staging..dev = 0; valid
Round 3: before promotion, commits on dev not in staging: 1

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 15 +--------------
 2 files changed, 2 insertions(+), 15 deletions(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 15 +--------------
 2 files changed, 2 insertions(+), 15 deletions(-)
```

Round 3: trees dev/staging identical, staging/prod identical; staging..dev = 0; valid

What has been promoted, from git alone:

```
$ git log --oneline staging..dev    [exit 0]
26d4b8a round 4 (not promoted yet)
```

```
$ git diff --stat staging...dev    [exit 0]
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge-base --is-ancestor 26d4b8a staging    [exit 1]
```

```
$ git merge-base --is-ancestor dev~1 prod    [exit 0]
```

```
$ git branch --contains dev~1    [exit 0]
* dev
  prod
  staging
```

```
$ git log --oneline --graph -8 prod    [exit 0]
*   4fc4428 Merge staging into prod
|\
| *   48918a9 Merge dev into staging
| |\
| | * 4b72636 round 3: Load orders: remove Audit again; Monthly invoices: code
* | | 9e013ab Merge staging into prod
|\| |
| * | ec30db3 Merge dev into staging
| |\|
| | * 403f7e2 round 2: Load orders: one day of overlap; Sync customers: filter
* | | 05916cb Merge staging into prod
|\| |
| * | ac419ca Merge dev into staging
|/| |
| |/
```

staging vs dev: rev-list dev..staging = 3 (no-merges: 0); merging staging into dev would change dev: no
prod vs staging: rev-list staging..prod = 3 (no-merges: 0); merging prod into staging would change staging: no

**RESULT 1-no-ff:** r1: staging clean, prod clean; r2: staging clean, prod clean; r3: staging clean, prod clean

### 1 (fast-forward only)

Round 1: before promotion, commits on dev not in staging: 1

```
$ git merge --ff-only dev    [exit 0]
Updating d795343..79b671b
Fast-forward
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --ff-only staging    [exit 0]
Updating d795343..79b671b
Fast-forward
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

Round 1: trees dev/staging identical, staging/prod identical; staging..dev = 0; valid
Round 2: before promotion, commits on dev not in staging: 1

```
$ git merge --ff-only dev    [exit 0]
Updating 79b671b..79a95b6
Fast-forward
 acme/Billing/flows/Sales/Load orders.yaml    | 2 +-
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
... (1 more lines)
```

```
$ git merge --ff-only staging    [exit 0]
Updating 79b671b..79a95b6
Fast-forward
 acme/Billing/flows/Sales/Load orders.yaml    | 2 +-
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
... (1 more lines)
```

Round 2: trees dev/staging identical, staging/prod identical; staging..dev = 0; valid
Round 3: before promotion, commits on dev not in staging: 1

```
$ git merge --ff-only dev    [exit 0]
Updating 79a95b6..f9e2f3b
Fast-forward
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 15 +--------------
... (1 more lines)
```

```
$ git merge --ff-only staging    [exit 0]
Updating 79a95b6..f9e2f3b
Fast-forward
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 15 +--------------
... (1 more lines)
```

Round 3: trees dev/staging identical, staging/prod identical; staging..dev = 0; valid

What has been promoted, from git alone:

```
$ git log --oneline staging..dev    [exit 0]
774a2f4 round 4 (not promoted yet)
```

```
$ git diff --stat staging...dev    [exit 0]
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge-base --is-ancestor 774a2f4 staging    [exit 1]
```

```
$ git merge-base --is-ancestor dev~1 prod    [exit 0]
```

```
$ git branch --contains dev~1    [exit 0]
* dev
  prod
  staging
```

```
$ git log --oneline --graph -8 prod    [exit 0]
* f9e2f3b round 3: Load orders: remove Audit again; Monthly invoices: code
* 79a95b6 round 2: Load orders: one day of overlap; Sync customers: filter
* 79b671b round 1: Load orders: >= since, add Audit after Query 1
* d795343 seed workspace
```

staging vs dev: rev-list dev..staging = 0 (no-merges: 0); merging staging into dev would change dev: no
prod vs staging: rev-list staging..prod = 0 (no-merges: 0); merging prod into staging would change staging: no

**RESULT 1-ff:** r1: staging clean, prod clean; r2: staging clean, prod clean; r3: staging clean, prod clean

## Scenario 2: the same chain, promotion PRs squashed

### 2 round 1

```
$ git merge --squash dev    [exit 0]
Updating cb18f57..33b343d
Fast-forward
Squash commit -- not updating HEAD
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --squash staging    [exit 0]
Updating cb18f57..fb0fc5e
Fast-forward
Squash commit -- not updating HEAD
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

After round 1: trees dev/staging identical, staging/prod identical; rev-list staging..dev = 1; merge-base(dev, staging) = cb18f57 seed workspace

### 2 round 2

```
$ git merge --squash dev    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Squash commit -- not updating HEAD
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 78
        FROM dbo.Orders_1 o
        JOIN dbo.Customer c ON c.id = o.customerId
<<<<<<< HEAD
        WHERE o.updatedAt >= @since
=======
        WHERE o.updatedAt >= DATEADD(day, -1, @since)
>>>>>>> dev
          AND o.status IN ('paid', 'shipped')
```

(resolved by taking the whole file from dev)

```
$ git merge --squash staging    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Squash commit -- not updating HEAD
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 78
        FROM dbo.Orders_1 o
        JOIN dbo.Customer c ON c.id = o.customerId
<<<<<<< HEAD
        WHERE o.updatedAt >= @since
=======
        WHERE o.updatedAt >= DATEADD(day, -1, @since)
>>>>>>> staging
          AND o.status IN ('paid', 'shipped')
```

(resolved by taking the whole file from staging)
After round 2: trees dev/staging identical, staging/prod identical; rev-list staging..dev = 2; merge-base(dev, staging) = cb18f57 seed workspace

### 2 round 3

```
$ git merge --squash dev    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Squash commit -- not updating HEAD
Automatic merge went well; stopped before committing as requested
```

```
$ git merge --squash staging    [exit 0]
Squash commit -- not updating HEAD
Automatic merge went well; stopped before committing as requested
```

After round 3: trees dev/staging DIFFERENT, staging/prod identical; rev-list staging..dev = 3; merge-base(dev, staging) = cb18f57 seed workspace

### 2 after round 3: the silent wrong result

```
$ git diff --stat dev staging    [exit 0]
 acme/Billing/flows/Sales/Load orders.yaml | 15 ++++++++++++++-
 1 file changed, 14 insertions(+), 1 deletion(-)
```

Audit node on dev: false; on staging: true; on prod: true
staging tree: valid (0 issues)

**RESULT 2:** r1 dev->staging: clean; r1 staging->prod: clean; r2 dev->staging: CONFLICT in 1 file(s); r2 staging->prod: CONFLICT in 1 file(s); r3 dev->staging: clean; r3 staging->prod: clean; after r3 dev/staging trees DIFFERENT

## Scenario 3: hotfix committed directly on prod

### 3a: back-ported to dev by a merge, then dev changes the same query, then promotion

prod vs staging: rev-list staging..prod = 2 (no-merges: 1); merging prod into staging would change staging: yes
prod vs dev: rev-list dev..prod = 3 (no-merges: 1); merging prod into dev would change dev: yes

```
$ git merge --no-ff -m "Merge prod into dev" prod    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

prod vs dev: rev-list dev..prod = 0 (no-merges: 0); merging prod into dev would change dev: no

```
$ git merge-base --is-ancestor staging dev    [exit 0]
```

```
$ git merge-base --is-ancestor prod dev    [exit 0]
```

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

hotfix present in dev: true, staging: true, prod: true
trees dev/staging identical, staging/prod identical; valid

**RESULT 3a:** backport merge clean; next promotion: staging clean, prod clean; all three trees end identical

### 3b1: never back-ported, dev changes the same line of the same flow

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 79
        JOIN dbo.Customer c ON c.id = o.customerId
        WHERE o.updatedAt >= @since
<<<<<<< HEAD
          AND o.status IN ('paid', 'shipped', 'refunded')
=======
          AND o.status IN ('paid', 'shipped', 'partial')
>>>>>>> staging
        ORDER BY o.updatedAt
```

hotfix present in dev: false, staging: false, prod: (conflicted)

**RESULT 3b1:** staging clean; prod CONFLICT in acme/Billing/flows/Sales/Load orders.yaml

### 3b2: never back-ported, dev changes another node of the same flow

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

hotfix present in dev: false, staging: false, prod: true
prod vs staging: rev-list staging..prod = 3 (no-merges: 1); merging prod into staging would change staging: yes

```
$ git log --oneline --no-merges staging..prod    [exit 0]
ec88f05 HOTFIX on prod: include refunded orders
```

```
$ git diff --stat staging prod    [exit 0]
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

**RESULT 3b2:** staging clean; prod clean; hotfix present in dev: false, staging: false, prod: true; valid

### 3c: never back-ported, dev changes a different flow

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

hotfix present in dev: false, staging: false, prod: true
prod vs staging: rev-list staging..prod = 3 (no-merges: 1); merging prod into staging would change staging: yes

**RESULT 3c:** staging clean; prod clean; hotfix present in dev: false, staging: false, prod: true

### 3d: back-ported by cherry-pick (or a squashed backport PR) instead of a merge

```
$ git cherry-pick prod    [exit 0]
[dev a734ad0] HOTFIX on prod: include refunded orders
 Date: Thu Jan 1 06:47:00 2026 +0000
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
```

hotfix present in dev: true, staging: true, prod: true
prod vs dev: rev-list dev..prod = 5 (no-merges: 1); merging prod into dev would change dev: no

```
$ git cherry dev prod    [exit 0]
+ 76875a8f2c80380d96c1125e6b14a9d8b5542c21
```

**RESULT 3d:** staging clean; prod clean; but prod vs dev: rev-list dev..prod = 5 (no-merges: 1); merging prod into dev would change dev: no

## Scenario 4: two user branches from dev edit the same flow (sorted by id vs insertion order)

### 4a [sorted]: different nodes (config of Query 1 vs config of Filter 9)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

merged flow: valid

### 4a [insertion]: different nodes (config of Query 1 vs config of Filter 9)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

merged flow: valid

### 4b1 [sorted]: the same node's config, the same SQL line

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 78
        FROM dbo.Orders_1 o
        JOIN dbo.Customer c ON c.id = o.customerId
<<<<<<< HEAD
        WHERE o.updatedAt >= @since
=======
        WHERE o.updatedAt > DATEADD(day, -7, @since)
>>>>>>> users/bob/work
          AND o.status IN ('paid', 'shipped')
```

### 4b1 [insertion]: the same node's config, the same SQL line

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 33
        FROM dbo.Orders_1 o
        JOIN dbo.Customer c ON c.id = o.customerId
<<<<<<< HEAD
        WHERE o.updatedAt >= @since
=======
        WHERE o.updatedAt > DATEADD(day, -7, @since)
>>>>>>> users/bob/work
          AND o.status IN ('paid', 'shipped')
```

### 4b2 [sorted]: the same node's config, different existing keys (a middle SQL line vs timeoutS)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

merged flow: valid

### 4b2 [insertion]: the same node's config, different existing keys (a middle SQL line vs timeoutS)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

merged flow: valid

### 4b3 [sorted]: the same node's config, each adds a new key (onError vs outputKey-like `retries`)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 1 +
 1 file changed, 1 insertion(+)
```

merged flow: valid

### 4b3 [insertion]: the same node's config, each adds a new key (onError vs outputKey-like `retries`)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 41
          expression: true
      timeoutS: 30
<<<<<<< HEAD
      onError: continue
=======
      retries: 3
>>>>>>> users/bob/work
  - id: cc312684-e4ed-4aa3-a643-4ef2510c632d
```

### 4b4 [sorted]: the same node's config, the last SQL line vs timeoutS (adjacent lines in sorted order)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 80
        WHERE o.updatedAt > @since
          AND o.status IN ('paid', 'shipped')
<<<<<<< HEAD
        ORDER BY o.updatedAt DESC
      timeoutS: 30
=======
        ORDER BY o.updatedAt
      timeoutS: 120
>>>>>>> users/bob/work
  - id: 45b5875b-bf1f-4416-aa68-5beb15428015
```

### 4b4 [insertion]: the same node's config, the last SQL line vs timeoutS (adjacent lines in sorted order)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

merged flow: valid

### 4c1 [sorted]: one moves every node (positions), the other changes a SQL line

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

merged flow: valid

### 4c1 [insertion]: one moves every node (positions), the other changes a SQL line

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

merged flow: valid

### 4c2 [sorted]: one moves every node, the other changes the node's first config key (the line right after `config:`)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)
```

merged flow: valid

### 4c2 [insertion]: one moves every node, the other changes the node's first config key (the line right after `config:`)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)
```

merged flow: valid

### 4c3 [sorted]: one moves every node, the other renames a node (label, the line right before `position:`)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

merged flow: valid

### 4c3 [insertion]: one moves every node, the other renames a node (label, the line right before `position:`)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

merged flow: valid

### 4d1 [sorted]: both add a node and its edges, as side branches off different nodes

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 16 ++++++++++++++++
 1 file changed, 16 insertions(+)
```

merged flow: valid

### 4d1 [insertion]: both add a node and its edges, as side branches off different nodes

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
2 conflict hunk(s)
@@ line 252
      level: info
      message: "`step 102: order ${$id}`"
<<<<<<< HEAD
  - id: 00fb8673-8b42-4c83-a548-4f3e32248c1e
    type: log
    label: Log 201
    position:
      x: 1000
      y: 400
    config:
      level: info
      message: "`step 201: order ${$id}`"
=======
  - id: 89af9ed0-2560-41c5-a67f-bb5522e53a50
    type: filter
    label: Filter 202
    position:
      x: 2500
      y: 400
    config:
      condition: $total > 2020 && $customerId != null
>>>>>>> users/bob/work
edges:
```

### 4d2 [sorted]: both add a node as a side branch off the same node

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 16 ++++++++++++++++
 1 file changed, 16 insertions(+)
```

merged flow: valid

### 4d2 [insertion]: both add a node as a side branch off the same node

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
2 conflict hunk(s)
@@ line 252
      level: info
      message: "`step 102: order ${$id}`"
<<<<<<< HEAD
  - id: 00fb8673-8b42-4c83-a548-4f3e32248c1e
    type: log
    label: Log 201
    position:
      x: 1000
      y: 400
    config:
      level: info
      message: "`step 201: order ${$id}`"
=======
  - id: 89af9ed0-2560-41c5-a67f-bb5522e53a50
    type: filter
    label: Filter 202
    position:
      x: 1000
      y: 600
    config:
      condition: $total > 2020 && $customerId != null
>>>>>>> users/bob/work
edges:
```

### 4d3 [sorted]: both insert a node into the same link (Map 3 -> Code 4)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 308
  - source: 4e86a538-cc03-4aa0-a56d-a5590e89a11d
    sourcePort: out-0
<<<<<<< HEAD
    target: 00fb8673-8b42-4c83-a548-4f3e32248c1e
=======
    target: 89af9ed0-2560-41c5-a67f-bb5522e53a50
>>>>>>> users/bob/work
    targetPort: in-0
```

### 4d3 [insertion]: both insert a node into the same link (Map 3 -> Code 4)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
3 conflict hunk(s)
@@ line 252
      level: info
      message: "`step 102: order ${$id}`"
<<<<<<< HEAD
  - id: 00fb8673-8b42-4c83-a548-4f3e32248c1e
    type: log
    label: Log 201
=======
  - id: 89af9ed0-2560-41c5-a67f-bb5522e53a50
    type: filter
    label: Filter 202
>>>>>>> users/bob/work
    position:
```

### 4d4 [sorted]: both insert a node into different links (Map 3 -> Code 4, Query 8 -> Filter 9)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 14 +++++++++++++-
 1 file changed, 13 insertions(+), 1 deletion(-)
```

merged flow: valid

### 4d4 [insertion]: both insert a node into different links (Map 3 -> Code 4, Query 8 -> Filter 9)

```
$ git merge --no-ff -m "Merge users/bob/work into dev" users/bob/work    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
2 conflict hunk(s)
@@ line 252
      level: info
      message: "`step 102: order ${$id}`"
<<<<<<< HEAD
  - id: 00fb8673-8b42-4c83-a548-4f3e32248c1e
    type: log
    label: Log 201
    position:
      x: 1050
      y: 0
    config:
      level: info
      message: "`step 201: order ${$id}`"
=======
  - id: 89af9ed0-2560-41c5-a67f-bb5522e53a50
    type: filter
    label: Filter 202
    position:
      x: 2550
      y: 0
    config:
      condition: $total > 2020 && $customerId != null
>>>>>>> users/bob/work
edges:
```

### 4 summary table

| case | edits                                                                                                | canonical (sorted) | insertion order   |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------ | ----------------- |
| 4a   | different nodes (config of Query 1 vs config of Filter 9)                                            | clean, valid       | clean, valid      |
| 4b1  | the same node's config, the same SQL line                                                            | CONFLICT (1 hunk)  | CONFLICT (1 hunk) |
| 4b2  | the same node's config, different existing keys (a middle SQL line vs timeoutS)                      | clean, valid       | clean, valid      |
| 4b3  | the same node's config, each adds a new key (onError vs outputKey-like `retries`)                    | clean, valid       | CONFLICT (1 hunk) |
| 4b4  | the same node's config, the last SQL line vs timeoutS (adjacent lines in sorted order)               | CONFLICT (1 hunk)  | clean, valid      |
| 4c1  | one moves every node (positions), the other changes a SQL line                                       | clean, valid       | clean, valid      |
| 4c2  | one moves every node, the other changes the node's first config key (the line right after `config:`) | clean, valid       | clean, valid      |
| 4c3  | one moves every node, the other renames a node (label, the line right before `position:`)            | clean, valid       | clean, valid      |
| 4d1  | both add a node and its edges, as side branches off different nodes                                  | clean, valid       | CONFLICT (2 hunk) |
| 4d2  | both add a node as a side branch off the same node                                                   | clean, valid       | CONFLICT (2 hunk) |
| 4d3  | both insert a node into the same link (Map 3 -> Code 4)                                              | CONFLICT (1 hunk)  | CONFLICT (3 hunk) |
| 4d4  | both insert a node into different links (Map 3 -> Code 4, Query 8 -> Filter 9)                       | clean, valid       | CONFLICT (2 hunk) |

### 4 trials: both add one node (random uuid) as a side branch off a random node, 150 trials, `git merge-file`

- side branch off random nodes, sorted: 19/150 conflict, 0/150 clean but invalid
- side branch off random nodes, insertion: 150/150 conflict, 0/150 clean but invalid
- inserted into random links, sorted: 27/150 conflict, 0/150 clean but invalid
- inserted into random links, insertion: 150/150 conflict, 0/150 clean but invalid

**RESULT 4:** 4a: clean, valid: clean, valid // 4b1: CONFLICT (1 hunk): CONFLICT (1 hunk) // 4b2: clean, valid: clean, valid // 4b3: clean, valid: CONFLICT (1 hunk) // 4b4: CONFLICT (1 hunk): clean, valid // 4c1: clean, valid: clean, valid // 4c2: clean, valid: clean, valid // 4c3: clean, valid: clean, valid // 4d1: clean, valid: CONFLICT (2 hunk) // 4d2: clean, valid: CONFLICT (2 hunk) // 4d3: CONFLICT (1 hunk): CONFLICT (3 hunk) // 4d4: clean, valid: CONFLICT (2 hunk) // trials: {"side branch off random nodes / sorted":{"conflict":19,"invalid":0},"side branch off random nodes / insertion":{"conflict":150,"invalid":0},"inserted into random links / sorted":{"conflict":27,"invalid":0},"inserted into random links / insertion":{"conflict":150,"invalid":0}}

## Scenario 5: renames

### 5a1: alice renames the flow (file move + its `name:` line), bob edits its content

```
$ git merge --no-ff -m "Merge users/alice/rename into dev" users/alice/rename    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/{Load orders.yaml => Load sales orders.yaml} | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
 rename acme/Billing/flows/Sales/{Load orders.yaml => Load sales orders.yaml} (99%)
```

```
$ git merge --no-ff -m "Merge users/bob/edit into dev" users/bob/edit    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load sales orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load sales orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

new path has bob's edit and the old path is gone: true
dev tree: valid (0 issues)

**RESULT 5a1:** clean; git followed the rename: true

### 5a2a: alice renames AND reworks (every node touched) the flow in the same branch, bob edits its content

```
$ git diff -M --summary dev users/alice/rename    [exit 0]
 rename acme/Billing/flows/Sales/{Sync customers.yaml => Sync accounts.yaml} (62%)
```

```
$ git merge --no-ff -m "Merge users/alice/rename into dev" users/alice/rename    [exit 0]
Merge made by the 'ort' strategy.
 .../{Sync customers.yaml => Sync accounts.yaml}    | 144 ++++++++-------------
 1 file changed, 57 insertions(+), 87 deletions(-)
 rename acme/Billing/flows/Sales/{Sync customers.yaml => Sync accounts.yaml} (62%)
```

```
$ git merge --no-ff -m "Merge users/bob/edit into dev" users/bob/edit    [exit 1]
Auto-merging acme/Billing/flows/Sales/Sync accounts.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Sync accounts.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
$ git status --short    [exit 0]
UU "acme/Billing/flows/Sales/Sync accounts.yaml"
```

**RESULT 5a2a:** similarity 62%; rename followed, CONFLICT (content)

### 5a2b: alice renames AND rebuilds (most nodes replaced) the flow in the same branch, bob edits its content

```
$ git diff -M --summary dev users/alice/rename    [exit 0]
 rename acme/Billing/flows/Sales/{Sync customers.yaml => Sync accounts.yaml} (60%)
```

```
$ git merge --no-ff -m "Merge users/alice/rename into dev" users/alice/rename    [exit 0]
Merge made by the 'ort' strategy.
 .../{Sync customers.yaml => Sync accounts.yaml}    | 214 +++++++++++----------
 1 file changed, 115 insertions(+), 99 deletions(-)
 rename acme/Billing/flows/Sales/{Sync customers.yaml => Sync accounts.yaml} (60%)
```

```
$ git merge --no-ff -m "Merge users/bob/edit into dev" users/bob/edit    [exit 1]
Auto-merging acme/Billing/flows/Sales/Sync accounts.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Sync accounts.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
$ git status --short    [exit 0]
UU "acme/Billing/flows/Sales/Sync accounts.yaml"
```

**RESULT 5a2b:** similarity 60%; rename followed, CONFLICT (content)

### 5c: alice deletes a flow and adds an unrelated new flow (other id, other name) in the same branch; bob edits the deleted flow

```
$ git diff -M --summary dev users/alice/a    [exit 0]
 rename acme/Billing/flows/{Sales/Sync customers.yaml => Finance/Refund report.yaml} (70%)
```

```
$ git merge --no-ff -m "Merge users/alice/a into dev" users/alice/a    [exit 0]
Merge made by the 'ort' strategy.
 .../Refund report.yaml}                            | 188 ++++++++++-----------
 1 file changed, 94 insertions(+), 94 deletions(-)
 rename acme/Billing/flows/{Sales/Sync customers.yaml => Finance/Refund report.yaml} (70%)
```

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 1]
Auto-merging acme/Billing/flows/Finance/Refund report.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Finance/Refund report.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
$ git status --short    [exit 0]
UU "acme/Billing/flows/Finance/Refund report.yaml"
```

```
# acme/Billing/flows/Finance/Refund report.yaml
1 conflict hunk(s)
@@ line 63
      y: 200
    config:
<<<<<<< HEAD:acme/Billing/flows/Finance/Refund report.yaml
      level: info
      message: "`step 100: order ${$id}`"
  - id: 7ab2ae9e-ae0a-4ca7-afd6-ab47e42c09d4
=======
      condition: $total > 90 && $customerId != null
  - id: d7397984-3e98-4324-ad3f-3d55be56de56
    type: filter
    label: Filter 2
    position:
      x: 600
      y: 0
    config:
      condition: $total > 1
  - id: ee8d2542-4e44-4e13-a0aa-9c5d0aad2826
>>>>>>> users/bob/b:acme/Billing/flows/Sales/Sync customers.yaml
    type: mapper
```

**RESULT 5c:** CONFLICT (content) in the unrelated new flow: git took delete + add for a rename

### 5a3: both branches rename the same flow, to different names

```
$ git merge --no-ff -m "Merge users/alice/rename into dev" users/alice/rename    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/{Load orders.yaml => Load sales orders.yaml} | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
... (1 more lines)
```

```
$ git merge --no-ff -m "Merge users/bob/rename into dev" users/bob/rename    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (rename/rename): acme/Billing/flows/Sales/Load orders.yaml renamed to acme/Billing/flows/Sales/Load sales orders.yaml in HEAD and to acme/Billing/flows/Sales/Import orders.yaml in users/bob/rename.
Automatic merge failed; fix conflicts and then commit the result.
```

```
$ git status --short    [exit 0]
UA "acme/Billing/flows/Sales/Import orders.yaml"
DD "acme/Billing/flows/Sales/Load orders.yaml"
AU "acme/Billing/flows/Sales/Load sales orders.yaml"
```

**RESULT 5a3:** CONFLICT (rename/rename): three paths involved, not a "mine or theirs for this file" conflict

### 5b: alice renames the folder Sales -> Revenue, bob adds a flow inside Sales

merge.directoryRenames=conflict (git default):

```
$ git -c merge.directoryRenames=conflict merge --no-ff -m "Merge bob" users/bob/new    [exit 1]
CONFLICT (file location): acme/Billing/flows/Sales/Refund report.yaml added in users/bob/new inside a directory that was renamed in HEAD, suggesting it should perhaps be moved to acme/Billing/flows/Revenue/Refund report.yaml.
Automatic merge failed; fix conflicts and then commit the result.
```

```
$ git status --short    [exit 0]
UA "acme/Billing/flows/Revenue/Refund report.yaml"
```

folders under flows/: Finance, Revenue
merge.directoryRenames=true:

```
$ git -c merge.directoryRenames=true merge --no-ff -m "Merge bob" users/bob/new    [exit 0]
Path updated: acme/Billing/flows/Sales/Refund report.yaml added in users/bob/new inside a directory that was renamed in HEAD; moving it to acme/Billing/flows/Revenue/Refund report.yaml.
Merge made by the 'ort' strategy.
 acme/Billing/flows/Revenue/Refund report.yaml | 181 ++++++++++++++++++++++++++
 1 file changed, 181 insertions(+)
 create mode 100644 acme/Billing/flows/Revenue/Refund report.yaml
```

```
$ git status --short    [exit 0]
```

folders under flows/: Finance, Revenue
merge.directoryRenames=false:

```
$ git -c merge.directoryRenames=false merge --no-ff -m "Merge bob" users/bob/new    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Refund report.yaml | 181 ++++++++++++++++++++++++++++
 1 file changed, 181 insertions(+)
 create mode 100644 acme/Billing/flows/Sales/Refund report.yaml
```

```
$ git status --short    [exit 0]
```

folders under flows/: Finance, Revenue, Sales

**RESULT 5b:** directoryRenames=conflict: CONFLICT (file location), folders: Finance, Revenue; directoryRenames=true: clean, folders: Finance, Revenue; directoryRenames=false: clean, folders: Finance, Revenue, Sales

## Scenario 6: silent semantic breakage (git merges cleanly, the result is broken)

### 6.1: alice deletes a node, bob adds an edge to that node

bob's new edge from each of the 17 other nodes to "Filter 9" (git merge-file): 17 merge cleanly (17 of them give an invalid flow), 0 conflict (the edge sorts next to a removed one).

```
$ git merge --no-ff -m "Merge users/alice/a into dev" users/alice/a    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 14 +-------------
 1 file changed, 1 insertion(+), 13 deletions(-)
```

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 4 ++++
... (1 more lines)
```

dev tree after both merges: 1 issue(s)

- acme/Billing/flows/Sales/Load orders.yaml: Edge 22 connects a node that is not in the flow.

**RESULT 6.1:** clean merge; merged flow: INVALID (acme/Billing/flows/Sales/Load orders.yaml: Edge 22 connects a node that is not in the flow.)

### 6.2: alice renames a script file (and fixes its users), bob adds a flow that references the old path

alice branch alone: valid (0 issues)

bob branch alone: valid (0 issues)

```
$ git merge --no-ff -m "Merge users/alice/a into dev" users/alice/a    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml | 6 +++---
 acme/Billing/flows/Sales/Load orders.yaml        | 4 ++--
... (4 more lines)
```

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Tax report.yaml | 217 +++++++++++++++++++++++++++++
 1 file changed, 217 insertions(+)
... (1 more lines)
```

dev tree after both merges: 1 issue(s)

- acme/Billing/flows/Finance/Tax report.yaml: node "Tax 5" calls pricing/tax#total, but acme/Billing/scripts/pricing/tax.ts does not exist

**RESULT 6.2:** clean merge; INVALID (acme/Billing/flows/Finance/Tax report.yaml: node "Tax 5" calls pricing/tax#total, but acme/Billing/scripts/pricing/tax.ts does not exist)

### 6.3: alice removes a connection from workspace.yaml (no flow uses it), bob adds a flow that uses it

```
$ git merge --no-ff -m "Merge users/alice/a into dev" users/alice/a    [exit 0]
Merge made by the 'ort' strategy.
 acme/workspace.yaml | 3 ---
 1 file changed, 3 deletions(-)
```

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Send reminders.yaml | 181 +++++++++++++++++++++++++
 1 file changed, 181 insertions(+)
... (1 more lines)
```

dev tree after both merges: 1 issue(s)

- acme/Billing/flows/Finance/Send reminders.yaml: node "Send 6" uses connection dddddddd-dddd-4ddd-addd-000000000004, not declared in workspace.yaml

**RESULT 6.3:** clean merge; INVALID (acme/Billing/flows/Finance/Send reminders.yaml: node "Send 6" uses connection dddddddd-dddd-4ddd-addd-000000000004, not declared in workspace.yaml)

### 6.4: alice deletes a flow, bob adds a Flow Invoker calling it by id; and both add a flow file with the same flow id

```
$ git merge --no-ff -m "Merge users/alice/a into dev" users/alice/a    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Copy of orders.yaml | 359 +++++++++++++++++++++++++++
 acme/Billing/flows/Sales/Sync customers.yaml | 217 ----------------
... (3 more lines)
```

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml | 17 +++++++++++++++++
 1 file changed, 17 insertions(+)
```

dev tree after both merges: 2 issue(s)

- flow id a08ff49b-6f77-4263-a271-6c43069c43a8 is in 2 files: acme/Billing/flows/Sales/Copy of orders.yaml, acme/Billing/flows/Sales/Load orders.yaml
- acme/Billing/flows/Finance/Monthly invoices.yaml: node "Call sync" calls flow b548ea75-c1c3-46d9-a2a5-f0e0230f7af3, which is not in the repo

**RESULT 6.4:** clean merge; 2 issue(s): acme/Billing/flows/Sales/Copy of orders.yaml, acme/Billing/flows/Sales/Load orders.yaml | node "Call sync" calls flow b548ea75-c1c3-46d9-a2a5-f0e0230f7af3, which is not in the repo

## Scenario 7: two branches each add a connection to workspace.yaml

### 7 list-append: a list, new entries appended

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 1]
Auto-merging acme/workspace.yaml
CONFLICT (content): Merge conflict in acme/workspace.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/workspace.yaml
1 conflict hunk(s)
@@ line 15
    name: Mail API
    type: http
<<<<<<< HEAD
  - id: 3c0ffee0-1111-4111-a111-00000000000a
    name: Billing DB
    type: sqlserver
=======
  - id: e7777777-2222-4222-a222-00000000000b
    name: Slack webhook
    type: http
>>>>>>> users/bob/b

```

### 7 list-sorted: a list sorted by id, the two ids far apart

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 0]
Auto-merging acme/workspace.yaml
Merge made by the 'ort' strategy.
 acme/workspace.yaml | 3 +++
 1 file changed, 3 insertions(+)
```

connections after the merge: 6 (expected 6)

### 7 list-sorted: a list sorted by id, the two ids next to each other

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 1]
Auto-merging acme/workspace.yaml
CONFLICT (content): Merge conflict in acme/workspace.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/workspace.yaml
1 conflict hunk(s)
@@ line 6
    name: ERP
    type: sqlserver
<<<<<<< HEAD
  - id: 3c0ffee0-1111-4111-a111-00000000000a
    name: Billing DB
    type: sqlserver
=======
  - id: 3d000000-2222-4222-a222-00000000000b
    name: Slack webhook
    type: http
>>>>>>> users/bob/b
  - id: 55555555-bbbb-4bbb-bbbb-000000000002
```

### 7 map-sorted: a map keyed by id, sorted, ids far apart

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 0]
Auto-merging acme/workspace.yaml
Merge made by the 'ort' strategy.
 acme/workspace.yaml | 3 +++
 1 file changed, 3 insertions(+)
```

connections after the merge: 6 (expected 6)

### 7 map-sorted: a map keyed by id, sorted, ids next to each other

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 1]
Auto-merging acme/workspace.yaml
CONFLICT (content): Merge conflict in acme/workspace.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/workspace.yaml
1 conflict hunk(s)
@@ line 6
    name: ERP
    type: sqlserver
<<<<<<< HEAD
  3c0ffee0-1111-4111-a111-00000000000a:
    name: Billing DB
    type: sqlserver
=======
  3d000000-2222-4222-a222-00000000000b:
    name: Slack webhook
    type: http
>>>>>>> users/bob/b
  55555555-bbbb-4bbb-bbbb-000000000002:
```

### 7 file-per: one file per connection

```
$ git merge --no-ff -m "Merge users/bob/b into dev" users/bob/b    [exit 0]
Merge made by the 'ort' strategy.
 acme/connections/3d000000-2222-4222-a222-00000000000b.yaml | 3 +++
 1 file changed, 3 insertions(+)
 create mode 100644 acme/connections/3d000000-2222-4222-a222-00000000000b.yaml
```

connections after the merge: 6 (expected 6)

### 7 trials: both add one connection with a random uuid to a workspace of 4 / 12 connections, 150 trials, `git merge-file`

- 4 existing connections, list-append: 150/150 conflict
- 4 existing connections, list-sorted: 48/150 conflict
- 4 existing connections, map-sorted: 49/150 conflict
- 12 existing connections, list-append: 150/150 conflict
- 12 existing connections, list-sorted: 17/150 conflict
- 12 existing connections, map-sorted: 21/150 conflict

**RESULT 7:** a list, new entries appended: CONFLICT; a list sorted by id, the two ids far apart: clean (6 connections); a list sorted by id, the two ids next to each other: CONFLICT; a map keyed by id, sorted, ids far apart: clean (6 connections); a map keyed by id, sorted, ids next to each other: CONFLICT; one file per connection: clean (6 connections); trials n=4 list-append: 150/150 conflict; trials n=4 list-sorted: 48/150 conflict; trials n=4 map-sorted: 49/150 conflict; trials n=12 list-append: 150/150 conflict; trials n=12 list-sorted: 17/150 conflict; trials n=12 map-sorted: 21/150 conflict

## Scenario 8: "mine or theirs per file"

### 8a: bob updates his branch from dev (alice already merged), one line conflicts

alice's work (base -> alice): nodes added 1, removed 0, changed 2 (Query 1: config.sql; Filter 9: config.condition), edges +2 -1, moved 6
bob's work (base -> bob): nodes added 0, removed 0, changed 3 (Query 15: config.timeoutS; Query 1: config.sql; Log 14: config.message), edges +0 -0, moved 0

**mine (whole file)**

```
$ git merge dev   [exit 1]
1 conflict hunk(s)
@@ line 87
        FROM dbo.Orders_1 o
        JOIN dbo.Customer c ON c.id = o.customerId
<<<<<<< HEAD
        WHERE o.updatedAt > DATEADD(day, -7, @since)
=======
        WHERE o.updatedAt >= @since
>>>>>>> dev
          AND o.status IN ('paid', 'shipped')
```

result is a valid flow: yes
on bob's branch after the update: alice's work 0/12 changes kept (lost: move of Query 15, move of Code 11, move of Log 102, new node Log 201, move of Code 4, move of Query 1, Query 1.sql, move of Send 13, Filter 9.condition, new edge, new edge, removed edge); bob's work 3/3 changes kept
Query 1 SQL line: WHERE o.updatedAt > DATEADD(day, -7, @since)
then bob's PR into dev: clean; on dev: alice's (already merged) work 0/12 changes kept (lost: move of Query 15, move of Code 11, move of Log 102, new node Log 201, move of Code 4, move of Query 1, Query 1.sql, move of Send 13, Filter 9.condition, new edge, new edge, removed edge); bob's work 3/3 changes kept

**theirs (whole file)**
result is a valid flow: yes
on bob's branch after the update: alice's work 12/12 changes kept; bob's work 0/3 changes kept (lost: Query 15.timeoutS, Query 1.sql, Log 14.message)
Query 1 SQL line: WHERE o.updatedAt >= @since
then bob's PR into dev: clean; on dev: alice's (already merged) work 12/12 changes kept; bob's work 0/3 changes kept (lost: Query 15.timeoutS, Query 1.sql, Log 14.message)

**mine per hunk (-X ours)**
result is a valid flow: yes
on bob's branch after the update: alice's work 11/12 changes kept (lost: Query 1.sql); bob's work 3/3 changes kept
Query 1 SQL line: WHERE o.updatedAt > DATEADD(day, -7, @since)
then bob's PR into dev: clean; on dev: alice's (already merged) work 11/12 changes kept (lost: Query 1.sql); bob's work 3/3 changes kept

**theirs per hunk (-X theirs)**
result is a valid flow: yes
on bob's branch after the update: alice's work 12/12 changes kept; bob's work 2/3 changes kept (lost: Query 1.sql)
Query 1 SQL line: WHERE o.updatedAt >= @since
then bob's PR into dev: clean; on dev: alice's (already merged) work 12/12 changes kept; bob's work 2/3 changes kept (lost: Query 1.sql)

**union per hunk**
result is a valid flow: yes
on bob's branch after the update: alice's work 11/12 changes kept (lost: Query 1.sql); bob's work 2/3 changes kept (lost: Query 1.sql)
Query 1 SQL line: WHERE o.updatedAt > DATEADD(day, -7, @since) | WHERE o.updatedAt >= @since
then bob's PR into dev: clean; on dev: alice's (already merged) work 11/12 changes kept (lost: Query 1.sql); bob's work 2/3 changes kept (lost: Query 1.sql)

**RESULT 8a:** mine (whole file): valid flow; dev after bob's PR: alice 0/12 changes kept (lost: move of Query 15, move of Code 11, move of Log 102, new node Log 201, move of Code 4, move of Query 1, Query 1.sql, move of Send 13, Filter 9.condition, new edge, new edge, removed edge), bob 3/3 changes kept // theirs (whole file): valid flow; dev after bob's PR: alice 12/12 changes kept, bob 0/3 changes kept (lost: Query 15.timeoutS, Query 1.sql, Log 14.message) // mine per hunk (-X ours): valid flow; dev after bob's PR: alice 11/12 changes kept (lost: Query 1.sql), bob 3/3 changes kept // theirs per hunk (-X theirs): valid flow; dev after bob's PR: alice 12/12 changes kept, bob 2/3 changes kept (lost: Query 1.sql) // union per hunk: valid flow; dev after bob's PR: alice 11/12 changes kept (lost: Query 1.sql), bob 2/3 changes kept (lost: Query 1.sql)

### 8b: the promotion conflict of 3b1 (hotfix on prod vs dev change on the same line), whole file taken from one side

**prod keeps its own file (mine)**
prod Query 1: `AND o.status IN ('paid', 'shipped', 'refunded')`; Filter 9: `$total > 90 && $customerId != null`; Query 15 timeoutS: 30
rev-list --count prod..staging = 0 (git says everything on staging is promoted); trees staging/prod DIFFERENT
prod vs staging: rev-list staging..prod = 3 (no-merges: 1); merging prod into staging would change staging: yes
next promotion: clean; prod Filter 9 is still `$total > 90 && $customerId != null` (dev has `$total > 999`), SQL line still `AND o.status IN ('paid', 'shipped', 'refunded')`

**RESULT 8b-ours:** prod SQL: AND o.status IN ('paid', 'shipped', 'refunded'); Filter 9 on prod: $total > 90 && $customerId != null; prod..staging after = 0; next promotion clean and does not bring the dropped side back

**prod keeps staging's file (theirs)**
prod Query 1: `AND o.status IN ('paid', 'shipped', 'partial')`; Filter 9: `$total > 999`; Query 15 timeoutS: 300
rev-list --count prod..staging = 0 (git says everything on staging is promoted); trees staging/prod identical
prod vs staging: rev-list staging..prod = 3 (no-merges: 1); merging prod into staging would change staging: no
next promotion: clean; prod Filter 9 is still `$total > 999` (dev has `$total > 999`), SQL line still `AND o.status IN ('paid', 'shipped', 'partial')`

**RESULT 8b-theirs:** prod SQL: AND o.status IN ('paid', 'shipped', 'partial'); Filter 9 on prod: $total > 999; prod..staging after = 0; next promotion clean and does not bring the dropped side back

### 8c: workspace.yaml (appended list) conflict of scenario 7, whole file from one side

```
$ git merge --no-ff -m "Update from dev" dev    [exit 1]
Auto-merging acme/workspace.yaml
CONFLICT (content): Merge conflict in acme/workspace.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

bob's branch after `mine` on workspace.yaml: 1 issue(s)

- acme/Billing/flows/Sales/Load orders.yaml: node "Query 1" uses connection 3c0ffee0-1111-4111-a111-00000000000a, not declared in workspace.yaml

**RESULT 8c:** mine on workspace.yaml: acme/Billing/flows/Sales/Load orders.yaml: node "Query 1" uses connection 3c0ffee0-1111-4111-a111-00000000000a, not declared in workspace.yaml

## Scenario 9: promoting a commit that is not the tip

```
$ git log --oneline staging..dev    [exit 0]
299bed1 round 3: Load orders: remove Audit again; Monthly invoices: code
0dce47e round 2: Load orders: one day of overlap; Sync customers: filter
00132db round 1: Load orders: >= since, add Audit after Query 1
```

```
$ git merge --no-ff -m "Merge promote/dev-0dce47e into staging" promote/dev-0dce47e    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml    | 17 +++++++++++++++--
 acme/Billing/flows/Sales/Sync customers.yaml |  2 +-
 2 files changed, 16 insertions(+), 3 deletions(-)
```

staging tree equals dev at 0dce47e: identical; valid

```
$ git log --oneline staging..dev    [exit 0]
299bed1 round 3: Load orders: remove Audit again; Monthly invoices: code
```

```
$ git merge-base --is-ancestor 0dce47e staging    [exit 0]
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml    | 17 +++++++++++++++--
 acme/Billing/flows/Sales/Sync customers.yaml |  2 +-
 2 files changed, 16 insertions(+), 3 deletions(-)
```

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 17 ++---------------
 2 files changed, 3 insertions(+), 16 deletions(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 17 ++---------------
 2 files changed, 3 insertions(+), 16 deletions(-)
```

trees dev/staging identical, staging/prod identical; staging..dev = 0; valid

**RESULT 9:** promote/dev-0dce47e into staging clean, on to prod clean; later tip into staging clean, prod clean; trees end identical

### 9b: the same, but staging also got a hotfix between the two promotions (not back-ported)

```
$ git merge --no-ff -m "Merge promote/dev-d11fd44 into staging" promote/dev-d11fd44    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 78
        FROM dbo.Orders_1 o
        JOIN dbo.Customer c ON c.id = o.customerId
<<<<<<< HEAD
        WHERE o.updatedAt >= @since -- staging hotfix
=======
        WHERE o.updatedAt >= DATEADD(day, -1, @since)
>>>>>>> dev
          AND o.status IN ('paid', 'shipped')
```

**RESULT 9b:** tip promotion after a partial promotion + a hotfix on the line a not-yet-promoted commit changed: CONFLICT

## Scenario 10: a hotfix on prod while staging and dev both have unpromoted work; backport to the root vs one hop at a time

### 10a1: the hotfix touches a flow nobody else changed; backport to the root (dev)

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml    | 2 +-
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
... (1 more lines)
```

before: staging -> prod BLOCKED

```
$ git merge --no-ff -m "Merge prod into backport/prod-e08d95b" prod    [exit 0]
Auto-merging acme/Billing/flows/Sales/Sync customers.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge --no-ff -m "Merge backport/prod-e08d95b into dev" backport/prod-e08d95b    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

after the backport into dev: staging -> prod BLOCKED, dev -> staging open
the only dev commits that carry the hotfix are the backport merge and later; the promotion takes the tip:

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 15 +--------------
 acme/Billing/flows/Sales/Sync customers.yaml     |  2 +-
 3 files changed, 3 insertions(+), 16 deletions(-)
```

after dev -> staging: staging has round 2: true, round 3: true; staging -> prod open

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 17 ++---------------
 acme/Billing/flows/Sales/Sync customers.yaml     |  2 +-
 3 files changed, 4 insertions(+), 17 deletions(-)
```

after staging -> prod: prod has round 2: true, round 3: true; valid

**RESULT 10a1:** backport clean; staging -> prod unblocked only after dev -> staging (clean), which brought round 3 into staging: true; next prod promotion (clean) carries round 3: true

### 10a2: the hotfix touches a flow nobody else changed; backport one hop at a time (prod into staging, then staging into dev)

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml    | 2 +-
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
... (1 more lines)
```

```
$ git merge --no-ff -m "Merge prod into backport/prod-9537b9c" prod    [exit 0]
Auto-merging acme/Billing/flows/Sales/Sync customers.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge --no-ff -m "Merge backport/prod-9537b9c into staging" backport/prod-9537b9c    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

after hop 1: staging -> prod open, dev -> staging BLOCKED; staging has round 2: true, round 3: false

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml    | 2 +-
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 2 files changed, 2 insertions(+), 2 deletions(-)
```

staging -> prod right away (clean): prod has round 2: true, round 3: false

```
$ git merge --no-ff -m "Merge staging into backport/staging-d80409c" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge --no-ff -m "Merge backport/staging-d80409c into dev" backport/staging-d80409c    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

after hop 2: dev -> staging open

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 15 +--------------
 2 files changed, 2 insertions(+), 15 deletions(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 15 +--------------
 2 files changed, 2 insertions(+), 15 deletions(-)
```

then the ordinary promotions: dev -> staging clean, staging -> prod clean; trees dev/prod identical; valid

**RESULT 10a2:** hop 1 clean, staging -> prod open at once and (clean) carries round 2: true, round 3: false; hop 2 clean; later promotions clean, trees end identical

### 10b1: the hotfix changes the line round 2 changed on staging; backport to the root (dev)

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml    | 2 +-
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
... (1 more lines)
```

before: staging -> prod BLOCKED

```
$ git merge --no-ff -m "Merge prod into backport/prod-020f6d1" prod    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

conflict in backport/prod-020f6d1, resolved by taking prod's side of each hunk

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 78
        FROM dbo.Orders_1 o
        JOIN dbo.Customer c ON c.id = o.customerId
<<<<<<< HEAD
        WHERE o.updatedAt >= DATEADD(day, -1, @since)
=======
        WHERE o.updatedAt >= @since -- hotfix
>>>>>>> prod
          AND o.status IN ('paid', 'shipped')
```

```
$ git merge --no-ff -m "Merge backport/prod-020f6d1 into dev" backport/prod-020f6d1    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

after the backport into dev: staging -> prod BLOCKED, dev -> staging open
the only dev commits that carry the hotfix are the backport merge and later; the promotion takes the tip:

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml | 2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 2 +-
 2 files changed, 2 insertions(+), 2 deletions(-)
```

after dev -> staging: staging has round 2: true, round 3: true; staging -> prod open

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml | 2 +-
 acme/Billing/flows/Sales/Sync customers.yaml     | 2 +-
 2 files changed, 2 insertions(+), 2 deletions(-)
```

after staging -> prod: prod has round 2: true, round 3: true; valid

**RESULT 10b1:** backport CONFLICT; staging -> prod unblocked only after dev -> staging (clean), which brought round 3 into staging: true; next prod promotion (clean) carries round 3: true

### 10b2: the hotfix changes the line round 2 changed on staging; backport one hop at a time (prod into staging, then staging into dev)

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml    | 2 +-
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
... (1 more lines)
```

```
$ git merge --no-ff -m "Merge prod into backport/prod-b178598" prod    [exit 1]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
CONFLICT (content): Merge conflict in acme/Billing/flows/Sales/Load orders.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

conflict in backport/prod-b178598, resolved by taking prod's side of each hunk

```
# acme/Billing/flows/Sales/Load orders.yaml
1 conflict hunk(s)
@@ line 78
        FROM dbo.Orders_1 o
        JOIN dbo.Customer c ON c.id = o.customerId
<<<<<<< HEAD
        WHERE o.updatedAt >= DATEADD(day, -1, @since)
=======
        WHERE o.updatedAt >= @since -- hotfix
>>>>>>> prod
          AND o.status IN ('paid', 'shipped')
```

```
$ git merge --no-ff -m "Merge backport/prod-b178598 into staging" backport/prod-b178598    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

after hop 1: staging -> prod open, dev -> staging BLOCKED; staging has round 2: true, round 3: false

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Sync customers.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

staging -> prod right away (clean): prod has round 2: true, round 3: false

```
$ git merge --no-ff -m "Merge staging into backport/staging-7f8b32c" staging    [exit 0]
Auto-merging acme/Billing/flows/Sales/Load orders.yaml
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

```
$ git merge --no-ff -m "Merge backport/staging-7f8b32c into dev" backport/staging-7f8b32c    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Sales/Load orders.yaml | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

after hop 2: dev -> staging open

```
$ git merge --no-ff -m "Merge dev into staging" dev    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 15 +--------------
 2 files changed, 2 insertions(+), 15 deletions(-)
```

```
$ git merge --no-ff -m "Merge staging into prod" staging    [exit 0]
Merge made by the 'ort' strategy.
 acme/Billing/flows/Finance/Monthly invoices.yaml |  2 +-
 acme/Billing/flows/Sales/Load orders.yaml        | 15 +--------------
 2 files changed, 2 insertions(+), 15 deletions(-)
```

then the ordinary promotions: dev -> staging clean, staging -> prod clean; trees dev/prod identical; valid

**RESULT 10b2:** hop 1 CONFLICT, staging -> prod open at once and (clean) carries round 2: true, round 3: false; hop 2 clean; later promotions clean, trees end identical

## Summary

- **1-no-ff**: r1: staging clean, prod clean; r2: staging clean, prod clean; r3: staging clean, prod clean
- **1-ff**: r1: staging clean, prod clean; r2: staging clean, prod clean; r3: staging clean, prod clean
- **2**: r1 dev->staging: clean; r1 staging->prod: clean; r2 dev->staging: CONFLICT in 1 file(s); r2 staging->prod: CONFLICT in 1 file(s); r3 dev->staging: clean; r3 staging->prod: clean; after r3 dev/staging trees DIFFERENT
- **3a**: backport merge clean; next promotion: staging clean, prod clean; all three trees end identical
- **3b1**: staging clean; prod CONFLICT in acme/Billing/flows/Sales/Load orders.yaml
- **3b2**: staging clean; prod clean; hotfix present in dev: false, staging: false, prod: true; valid
- **3c**: staging clean; prod clean; hotfix present in dev: false, staging: false, prod: true
- **3d**: staging clean; prod clean; but prod vs dev: rev-list dev..prod = 5 (no-merges: 1); merging prod into dev would change dev: no
- **4**: 4a: clean, valid: clean, valid // 4b1: CONFLICT (1 hunk): CONFLICT (1 hunk) // 4b2: clean, valid: clean, valid // 4b3: clean, valid: CONFLICT (1 hunk) // 4b4: CONFLICT (1 hunk): clean, valid // 4c1: clean, valid: clean, valid // 4c2: clean, valid: clean, valid // 4c3: clean, valid: clean, valid // 4d1: clean, valid: CONFLICT (2 hunk) // 4d2: clean, valid: CONFLICT (2 hunk) // 4d3: CONFLICT (1 hunk): CONFLICT (3 hunk) // 4d4: clean, valid: CONFLICT (2 hunk) // trials: {"side branch off random nodes / sorted":{"conflict":19,"invalid":0},"side branch off random nodes / insertion":{"conflict":150,"invalid":0},"inserted into random links / sorted":{"conflict":27,"invalid":0},"inserted into random links / insertion":{"conflict":150,"invalid":0}}
- **5a1**: clean; git followed the rename: true
- **5a2a**: similarity 62%; rename followed, CONFLICT (content)
- **5a2b**: similarity 60%; rename followed, CONFLICT (content)
- **5c**: CONFLICT (content) in the unrelated new flow: git took delete + add for a rename
- **5a3**: CONFLICT (rename/rename): three paths involved, not a "mine or theirs for this file" conflict
- **5b**: directoryRenames=conflict: CONFLICT (file location), folders: Finance, Revenue; directoryRenames=true: clean, folders: Finance, Revenue; directoryRenames=false: clean, folders: Finance, Revenue, Sales
- **6.1**: clean merge; merged flow: INVALID (acme/Billing/flows/Sales/Load orders.yaml: Edge 22 connects a node that is not in the flow.)
- **6.2**: clean merge; INVALID (acme/Billing/flows/Finance/Tax report.yaml: node "Tax 5" calls pricing/tax#total, but acme/Billing/scripts/pricing/tax.ts does not exist)
- **6.3**: clean merge; INVALID (acme/Billing/flows/Finance/Send reminders.yaml: node "Send 6" uses connection dddddddd-dddd-4ddd-addd-000000000004, not declared in workspace.yaml)
- **6.4**: clean merge; 2 issue(s): acme/Billing/flows/Sales/Copy of orders.yaml, acme/Billing/flows/Sales/Load orders.yaml | node "Call sync" calls flow b548ea75-c1c3-46d9-a2a5-f0e0230f7af3, which is not in the repo
- **7**: a list, new entries appended: CONFLICT; a list sorted by id, the two ids far apart: clean (6 connections); a list sorted by id, the two ids next to each other: CONFLICT; a map keyed by id, sorted, ids far apart: clean (6 connections); a map keyed by id, sorted, ids next to each other: CONFLICT; one file per connection: clean (6 connections); trials n=4 list-append: 150/150 conflict; trials n=4 list-sorted: 48/150 conflict; trials n=4 map-sorted: 49/150 conflict; trials n=12 list-append: 150/150 conflict; trials n=12 list-sorted: 17/150 conflict; trials n=12 map-sorted: 21/150 conflict
- **8a**: mine (whole file): valid flow; dev after bob's PR: alice 0/12 changes kept (lost: move of Query 15, move of Code 11, move of Log 102, new node Log 201, move of Code 4, move of Query 1, Query 1.sql, move of Send 13, Filter 9.condition, new edge, new edge, removed edge), bob 3/3 changes kept // theirs (whole file): valid flow; dev after bob's PR: alice 12/12 changes kept, bob 0/3 changes kept (lost: Query 15.timeoutS, Query 1.sql, Log 14.message) // mine per hunk (-X ours): valid flow; dev after bob's PR: alice 11/12 changes kept (lost: Query 1.sql), bob 3/3 changes kept // theirs per hunk (-X theirs): valid flow; dev after bob's PR: alice 12/12 changes kept, bob 2/3 changes kept (lost: Query 1.sql) // union per hunk: valid flow; dev after bob's PR: alice 11/12 changes kept (lost: Query 1.sql), bob 2/3 changes kept (lost: Query 1.sql)
- **8b-ours**: prod SQL: AND o.status IN ('paid', 'shipped', 'refunded'); Filter 9 on prod: $total > 90 && $customerId != null; prod..staging after = 0; next promotion clean and does not bring the dropped side back
- **8b-theirs**: prod SQL: AND o.status IN ('paid', 'shipped', 'partial'); Filter 9 on prod: $total > 999; prod..staging after = 0; next promotion clean and does not bring the dropped side back
- **8c**: mine on workspace.yaml: acme/Billing/flows/Sales/Load orders.yaml: node "Query 1" uses connection 3c0ffee0-1111-4111-a111-00000000000a, not declared in workspace.yaml
- **9**: promote/dev-0dce47e into staging clean, on to prod clean; later tip into staging clean, prod clean; trees end identical
- **9b**: tip promotion after a partial promotion + a hotfix on the line a not-yet-promoted commit changed: CONFLICT
- **10a1**: backport clean; staging -> prod unblocked only after dev -> staging (clean), which brought round 3 into staging: true; next prod promotion (clean) carries round 3: true
- **10a2**: hop 1 clean, staging -> prod open at once and (clean) carries round 2: true, round 3: false; hop 2 clean; later promotions clean, trees end identical
- **10b1**: backport CONFLICT; staging -> prod unblocked only after dev -> staging (clean), which brought round 3 into staging: true; next prod promotion (clean) carries round 3: true
- **10b2**: hop 1 CONFLICT, staging -> prod open at once and (clean) carries round 2: true, round 3: false; hop 2 clean; later promotions clean, trees end identical
