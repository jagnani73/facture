# Upstream: ATS registry generator silently produces no roles on Windows

**Upstream repo:** [hashgraph/asset-tokenization-studio](https://github.com/hashgraph/asset-tokenization-studio)
**File:** `packages/ats/contracts/scripts/tools/registry-generator/pipeline.ts`
**Base commit:** `be4f860` (`feat: v8.0.0 (#1298)`, tag v8.0.0)
**Status:** fix written and verified locally; PR not yet submitted.
**Patch:** [`ats-windows-registry-generator.patch`](./ats-windows-registry-generator.patch) — verified
to apply cleanly to pristine `be4f860` with `git apply`.

This document covers two separate Windows issues found while standing up ATS for Facture:

1. A real portability bug in the registry generator, written up as an upstream contribution.
2. A `git clone` failure caused by long paths, with the workaround the Facture team should use.

---

## 1. The bug

### Symptom, as a developer hits it

On Windows, you clone ATS, `npm ci`, and run any build or test. Everything reports success:

```
[INFO] Step 6: Scanning standalone role constants...
[INFO]   Found 0 standalone role files
[INFO]   Total unique roles: 0
...
[SUCCESS] Roles file generated successfully!
[SUCCESS] Done in 1020ms!
```

Exit code 0. No error, no warning that anything is wrong. But the generator has just overwritten the
checked-in `packages/ats/contracts/scripts/domain/atsRoles.generated.ts` with an empty registry:

```ts
/**
 * No roles found in contracts.
 */
export const ROLES = {} as const;
```

`git diff` on a clean checkout shows 45 lines deleted from a file you never touched.

Every downstream consumer then reads `undefined` for every role hash. The failures that follow point
nowhere near the cause. From `npm run test:scripts:unit`:

```
1) atsRegistry - Registry Helper Functions
     ROLES constant
       should have defined roles:
    AssertionError: expected +0 to be above +0

2) atsRegistry - Registry Helper Functions
     ROLES constant
       should have ROLE_PAUSER defined:
    AssertionError: expected undefined not to be undefined

3) createFactoryConfiguration
     should call with FACTORY_CONFIG_ID as configuration ID:
    Error: No resolver key found for facet: FactoryFacet
```

And from the contract integration tests, where `grantRole(undefined, ...)` reaches ethers:

```
1) BusinessLogicResolver
     "before each" hook:
   TypeError: Cannot read properties of undefined (reading 'then')
    at ParamType.#walkAsync (node_modules/ethers/src.ts/abi/fragments.ts:780:20)
    at Proxy.grantRole (node_modules/ethers/src.ts/contract/contract.ts:352:22)
    at deployBusinessLogicResolverFixture (test/contracts/integration/resolver/BusinessLogicResolver.test.ts:47:25)
```

Nothing in any of this mentions the registry generator. The generator is several steps upstream and
reported success.

### Root cause

`pipeline.ts` selects the Solidity files to scan for resolver keys and roles by converting glob
patterns from `DEFAULT_CONFIG` into regexes and testing them against file paths:

```ts
const resolverKeyFiles = allSolidityFiles.filter((filePath) =>
  fullConfig.resolverKeyPaths.some((pattern) => {
    const regexPattern = pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
    return new RegExp(regexPattern).test(filePath);
  }),
);
```

The patterns are POSIX-shaped and compile to forward-slash regexes:

| Config key         | Pattern                         | Compiled regex                   |
| ------------------ | ------------------------------- | -------------------------------- |
| `resolverKeyPaths` | `**/I*.sol`                     | `.*/I[^/]*\.sol`                 |
| `resolverKeyPaths` | `**/constants/resolverKeys.sol` | `.*/constants/resolverKeys\.sol` |
| `rolesPaths`       | `**/constants/roles.sol`        | `.*/constants/roles\.sol`        |
| `rolesPaths`       | `**/interfaces/roles.sol`       | `.*/interfaces/roles\.sol`       |

The paths they are tested against come from `findSolidityFiles` →
`findFiles` in `scripts/tools/registry-generator/utils/fileUtils.ts`, which builds them with
`path.join`:

```ts
const fullPath = path.join(dir, entry.name);
```

On Windows `path.join` yields `C:\...\contracts\layer_1\interfaces\IPause.sol`. The regex
`.*/I[^/]*\.sol` requires a literal `/`, so it matches nothing. Both filters return empty arrays.

The failure is silent because an empty result is indistinguishable from "this repo genuinely has no
role files". `generateRolesFile` handles the empty map by emitting the `No roles found` variant
rather than raising, and the pipeline reports `[SUCCESS]`.

Only these two call sites are affected — they are the only glob-to-regex conversions in the package
(`grep -rn '\[^/\]\*' scripts/ --include=*.ts`). `excludePaths`, `includePaths` and
`mockContractPaths` are declared in `DEFAULT_CONFIG` but are not matched through this code path.

### The fix

Normalise the path to forward slashes at the point of comparison. The two call sites were byte-identical,
so the fix folds them into one small documented helper rather than duplicating the normalisation:

```diff
+/**
+ * Match a filesystem path against glob-style config patterns.
+ *
+ * Config patterns are written with POSIX separators, so the path is normalised to
+ * forward slashes before matching. Without this, discovery silently matches nothing
+ * on Windows, where path.join produces backslash-separated paths.
+ */
+function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
+  const posixPath = filePath.split(path.sep).join("/");
+  return patterns.some((pattern) => {
+    const regexPattern = pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
+    return new RegExp(regexPattern).test(posixPath);
+  });
+}
+
 /**
  * Generate a complete contract registry from Solidity source files.

   const resolverKeyFiles = allSolidityFiles.filter((filePath) =>
-    fullConfig.resolverKeyPaths.some((pattern) => {
-      const regexPattern = pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
-      return new RegExp(regexPattern).test(filePath);
-    }),
+    matchesAnyPattern(filePath, fullConfig.resolverKeyPaths),
   );

-  const rolesFiles = allSolidityFiles.filter((filePath) =>
-    fullConfig.rolesPaths.some((pattern) => {
-      const regexPattern = pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
-      return new RegExp(regexPattern).test(filePath);
-    }),
-  );
+  const rolesFiles = allSolidityFiles.filter((filePath) => matchesAnyPattern(filePath, fullConfig.rolesPaths));
```

Total diff: **1 file changed, 17 insertions(+), 10 deletions(-)**.

`path.sep` is `/` on POSIX, so `.split(path.sep).join("/")` is a no-op there — behaviour on
Linux and macOS is unchanged. Paths are normalised only for the comparison; nothing that is read from
disk or written to output is mutated, so artifact paths stay native.

### Why not the alternatives

- **Normalise inside `findSolidityFiles`/`findFiles`.** Would fix these two call sites but change the
  return type contract of a shared utility whose results are also passed to `fs.readFileSync` and
  compared against artifact paths elsewhere. Riskier and wider than the bug warrants.
- **Swap the hand-rolled glob for `minimatch`/`picomatch`.** Correct long-term, but adds a dependency
  to a module whose header comment explicitly demands zero extra imports for load-time reasons.
- **Fail loudly on zero matches.** Worth doing as a follow-up (it would have turned this into a
  five-minute diagnosis), but it is a behaviour change and belongs in its own PR.

---

## 2. Verification

Environment: Windows 11, Node v24.18.0, npm 11.16.0, ATS at `be4f860`.

### Before — reproduce on pristine upstream code

```
$ git checkout -- packages/ats/contracts/scripts/tools/registry-generator/pipeline.ts
$ cd packages/ats/contracts && npm run generate:registry
[INFO] Step 4: Scanning resolver key constants...
[INFO]   Found 0 resolver key files
[INFO]   Total unique resolver keys: 0
[INFO] Step 6: Scanning standalone role constants...
[INFO]   Found 0 standalone role files
[INFO]   Total unique roles: 0
[SUCCESS] Registry generated successfully!
[SUCCESS] Roles file generated successfully!
[WARN] 111 facets missing resolver keys: AccessControlFacet, AdjustBalancesFacet, ... IDiamondFacet
[SUCCESS] Done in 1020ms!
```

The checked-in roles file is clobbered:

```
$ git status --short packages/ats/contracts/scripts/domain/atsRoles.generated.ts
 M packages/ats/contracts/scripts/domain/atsRoles.generated.ts

$ git diff --stat packages/ats/contracts/scripts/domain/atsRoles.generated.ts
 .../contracts/scripts/domain/atsRoles.generated.ts | 47 +---------------------
 1 file changed, 2 insertions(+), 45 deletions(-)

$ tail -3 packages/ats/contracts/scripts/domain/atsRoles.generated.ts
export const ROLES = {} as const;
```

Tests in that state:

```
$ npm run test:scripts:unit
  633 passing (9s)
  8 failing
  1) atsRegistry - Registry Helper Functions > ROLES constant > should have defined roles
  2) atsRegistry - Registry Helper Functions > ROLES constant > should have ROLE_PAUSER defined
  3) createFactoryConfiguration > should call with FACTORY_CONFIG_ID as configuration ID
  4) createFactoryConfiguration > should use FactoryFacet address from facetAddresses
  5) createFactoryConfiguration > should accept useTimeTravel=false by default
  6) Deployment File Utilities > getDeploymentsDir > should return an absolute path
  7) Deployment File Utilities > getNetworkDeploymentDir > should append network to deployments dir
  8) Deployment File Utilities > getNetworkDeploymentDir > should use custom deployments dir when provided
```

```
$ npx hardhat test --no-compile test/contracts/integration/resolver/BusinessLogicResolver.test.ts
  1 failing
  1) BusinessLogicResolver "before each" hook:
     TypeError: Cannot read properties of undefined (reading 'then')
      at Proxy.grantRole (node_modules/ethers/src.ts/contract/contract.ts:352:22)
```

### After — with the fix applied

```
$ npm run generate:registry
[INFO] Step 4: Scanning resolver key constants...
[INFO]   Found 162 resolver key files
[INFO]   Total unique resolver keys: 109
[INFO] Step 6: Scanning standalone role constants...
[INFO]   Found 2 standalone role files
[INFO]   Total unique roles: 37
[SUCCESS] Registry generated successfully!
[SUCCESS] Roles file generated successfully!
[WARN] 1 facets missing resolver keys: IDiamondFacet
[SUCCESS] Done in 956ms!
```

`0 → 162` resolver key files, `0 → 109` resolver keys, `0 → 2` role files, `0 → 37` roles, and
facets missing resolver keys drops from `111` to `1`.

**Regenerated output matches the git-checked-in file byte-for-byte:**

```
$ git status --porcelain packages/ats/contracts/scripts/domain/atsRoles.generated.ts
(no output — identical to HEAD)

$ git show HEAD:packages/ats/contracts/scripts/domain/atsRoles.generated.ts | sha256sum
f0830550d395b95be12e48f5d9e21efb1264f93ee0bbc6f921fbfb0826d36338 *-

$ sha256sum packages/ats/contracts/scripts/domain/atsRoles.generated.ts
f0830550d395b95be12e48f5d9e21efb1264f93ee0bbc6f921fbfb0826d36338 *packages/ats/contracts/scripts/domain/atsRoles.generated.ts
```

Role count — 36 `ROLE_*` entries plus `DEFAULT_ADMIN_ROLE`:

```
$ grep -cE '^  ROLE_' packages/ats/contracts/scripts/domain/atsRoles.generated.ts
36
$ grep -cE '^  (ROLE_|DEFAULT_ADMIN_ROLE)' packages/ats/contracts/scripts/domain/atsRoles.generated.ts
37
```

Tests:

```
$ npm run test:scripts:unit
  638 passing (7s)
  3 failing
  1) Deployment File Utilities > getDeploymentsDir > should return an absolute path
  2) Deployment File Utilities > getNetworkDeploymentDir > should append network to deployments dir
  3) Deployment File Utilities > getNetworkDeploymentDir > should use custom deployments dir when provided
```

```
$ npx hardhat test --no-compile test/contracts/integration/resolver/BusinessLogicResolver.test.ts
  19 passing (5s)
```

**633 passing / 8 failing → 638 passing / 3 failing.** All five role- and resolver-key failures are
resolved, and the resolver integration suite goes from a failing `before each` hook to 19/19.

### The 3 remaining failures are a separate, pre-existing issue

They are not caused by, and not fixed by, this change. `test/scripts/unit/utils/deploymentFiles.test.ts`
hardcodes POSIX path assumptions in the assertions themselves:

```ts
expect(dir.startsWith("/")).to.be.true; // Unix absolute path
...
const customBase = "/custom/deployments";
expect(networkDir).to.equal(`${customBase}/${TEST_NETWORK}`);
```

That is a second Windows portability problem, in test expectations rather than product code. It is
deliberately left out of this PR to keep the change focused; it deserves its own issue.

The same file also carries a pre-existing type error, present identically at pristine `HEAD` (verified
by `git stash`-ing the fix and re-running):

```
test/scripts/unit/utils/deploymentFiles.test.ts(60,5): error TS2739: Type '{ equity: ...; }'
  is missing the following properties from type '{ equity: ConfigurationMetadata; ... }':
  loan, loansPortfolio, depositToken, factory
```

This change introduces no new type errors.

### Lint and format

```
$ npx prettier --check packages/ats/contracts/scripts/tools/registry-generator/pipeline.ts
Checking formatting...
All matched files use Prettier code style!

$ npx eslint packages/ats/contracts/scripts/tools/registry-generator/pipeline.ts
0 errors
```

---

## 3. Submitting the PR

Per [`CONTRIBUTING.md`](https://github.com/hashgraph/asset-tokenization-studio/blob/main/CONTRIBUTING.md):

- Target the **`develop`** branch, not `main`.
- Branch name: `fix/windows-registry-generator-path-separators`.
- Conventional Commits, **DCO sign-off (`--signoff`) and GPG signature (`-S`) are both mandatory** —
  the `pre-push` hook blocks pushes without them.
- A **changeset is required** for package changes. This is a bug fix, so choose **patch** for
  `@hashgraph/asset-tokenization-contracts`. Alternatively apply a `hotfix` bypass label to the PR.

```bash
git checkout develop
git checkout -b fix/windows-registry-generator-path-separators
# apply the change to packages/ats/contracts/scripts/tools/registry-generator/pipeline.ts
npm run changeset          # select @hashgraph/asset-tokenization-contracts, patch
git add packages/ats/contracts/scripts/tools/registry-generator/pipeline.ts .changeset/*.md
git commit --signoff -S -m "fix(ats:contracts): normalise path separators in registry globs"
git push origin fix/windows-registry-generator-path-separators
```

Commit subject is 65 characters, within the 72-char commitlint ceiling.

### PR title

```
fix(ats:contracts): normalise path separators in registry globs
```

### PR description

````markdown
## Summary

On Windows the registry generator silently discovers **zero** resolver keys and **zero** roles, then
overwrites the checked-in `scripts/domain/atsRoles.generated.ts` with `export const ROLES = {}`.
Every subsequent test fails on undefined role hashes, with nothing in the output pointing at the
generator.

`pipeline.ts` filters `.sol` files by compiling POSIX glob patterns from `DEFAULT_CONFIG` into
regexes and testing them against paths produced by `path.join`. On Windows those paths are
backslash-separated, so a regex such as `.*/I[^/]*\.sol` can never match.

## Motivation and context

The failure is silent: an empty match set is indistinguishable from "this repo has no role files",
so `generateRolesFile` emits its `No roles found` variant and the pipeline reports `[SUCCESS]` with
exit code 0. The damage only surfaces much later, as `grantRole(undefined, ...)` blowing up inside
ethers' ABI encoder:

```
TypeError: Cannot read properties of undefined (reading 'then')
  at ParamType.#walkAsync (node_modules/ethers/src.ts/abi/fragments.ts:780:20)
  at Proxy.grantRole (node_modules/ethers/src.ts/contract/contract.ts:352:22)
```

This makes ATS effectively unusable on Windows without the fix, and gives a contributor no trail to
follow.

## Changes

Normalise the path to forward slashes at the point of comparison, via a small helper that replaces
the two byte-identical filter blocks (`resolverKeyPaths` and `rolesPaths`):

```ts
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  const posixPath = filePath.split(path.sep).join('/');
  return patterns.some((pattern) => {
    const regexPattern = pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
    return new RegExp(regexPattern).test(posixPath);
  });
}
```

One file, +17/-10. `path.sep` is `/` on POSIX, so this is a no-op on Linux and macOS. Only the
comparison is normalised — no path used for I/O is mutated.

## Testing performed

On Windows 11, Node v24.18.0, npm 11.16.0.

**Generator output, before → after:**

| Metric                       | Before | After |
| ---------------------------- | -----: | ----: |
| Resolver key files found     |      0 |   162 |
| Unique resolver keys         |      0 |   109 |
| Standalone role files found  |      0 |     2 |
| Unique roles                 |      0 |    37 |
| Facets missing resolver keys |    111 |     1 |

**Regenerated `atsRoles.generated.ts` now matches the checked-in file byte-for-byte** —
`git status --porcelain` reports no modification, and sha256 matches
`git show HEAD:...` at `f0830550d395b95be12e48f5d9e21efb1264f93ee0bbc6f921fbfb0826d36338`
(36 `ROLE_*` entries plus `DEFAULT_ADMIN_ROLE`).

**`npm run test:scripts:unit`:** 633 passing / 8 failing → **638 passing / 3 failing**.
All five role- and resolver-key failures resolved.

**`npx hardhat test --no-compile test/contracts/integration/resolver/BusinessLogicResolver.test.ts`:**
failing `before each` hook → **19 passing**.

Verified in both directions — reverting the patch reproduces the empty output and the failures.

The 3 remaining unit failures are unrelated and pre-existing: `test/scripts/unit/utils/deploymentFiles.test.ts`
asserts POSIX separators in the test expectations themselves (`expect(dir.startsWith("/")).to.be.true`).
That is a separate Windows portability issue in test code, left out to keep this change focused, and
happy to open a follow-up issue for it.

`npx prettier --check` and `npx eslint` both clean on the changed file. No new `tsc` errors — the one
error in `deploymentFiles.test.ts` is present identically at the base commit.

## Related issues

None currently filed — happy to open one if maintainers prefer an issue first.
````

### Possible follow-up to offer maintainers

The generator should probably refuse to overwrite a checked-in registry with an empty one. A guard —
warn or fail when `rolesPaths` is non-empty but zero role files matched — would have turned this from
a multi-hour hunt into an immediate diagnosis. Worth raising separately if there is interest.

---

## 4. Second Windows gotcha: cloning ATS fails on long paths

**This is not an upstream bug to fix — it is setup guidance for the Facture team.**

A full `git clone` of ATS fails on Windows. The deepest tracked paths live under
`packages/mass-payout/sdk` and reach **180 characters relative to the repo root**:

```
packages/mass-payout/sdk/test/unit/app/usecases/command/lifecyclecashflow/operations/executePercentageSnapshotByAddresses/ExecutePercentageSnapshotByAddressesCommandHandler.spec.ts   (180)
packages/mass-payout/sdk/test/unit/app/usecases/command/lifecyclecashflow/operations/executeAmountSnapshotByAddresses/ExecuteAmountSnapshotByAddressesCommandHandler.spec.ts            (172)
packages/mass-payout/sdk/src/app/usecase/command/lifeCycleCashFlow/operations/executePercentageSnapshotByAddresses/error/ExecutePercentageSnapshotByAddressesCommandError.ts            (172)
```

Add any non-trivial checkout root and you cross the 260-character `MAX_PATH` ceiling. Checking out
under a 107-character root gives `107 + 180 = 287` characters, and the clone fails partway through.

`git config --global core.longpaths true` helps git itself but does not save you: Node tooling,
`npm`, and many bundlers still call Win32 APIs that enforce `MAX_PATH`.

### Workaround: sparse checkout

Facture only builds against `packages/ats/contracts`, so skip the rest of the monorepo entirely.
`packages/eslint-config` is also needed — the contracts package resolves it as a workspace dependency.

```bash
# Clone without checking out any files (blobless + shallow keeps it fast)
git clone --filter=blob:none --depth 1 --sparse \
  https://github.com/hashgraph/asset-tokenization-studio ats
cd ats

# Check out only what Facture needs
git sparse-checkout set packages/ats/contracts packages/eslint-config

# Install and build
npm install
cd packages/ats/contracts
npx hardhat compile
```

This leaves ~23% of tracked files on disk and never materialises anything under
`packages/mass-payout/`. Verify with:

```bash
$ git sparse-checkout list
packages/ats/contracts
packages/eslint-config
```

### Additional guidance

- **Keep the checkout root short.** `C:\dev\ats` costs 11 characters, leaving comfortable headroom;
  a path under `AppData\Local\Temp\...` costs over 100. With a short root, a full clone may succeed —
  but sparse checkout is faster and the reliable option.
- **Enable long paths anyway**, since it costs nothing:
  ```bash
  git config --global core.longpaths true
  ```
  It also needs the OS-level switch (admin PowerShell, then reboot):
  ```powershell
  Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
    -Name LongPathsEnabled -Value 1
  ```
- **Apply the `pipeline.ts` fix** in any local ATS working copy until the upstream PR lands:
  ```bash
  git apply /path/to/facture/docs/upstream/ats-windows-registry-generator.patch
  ```
  Without it, `npx hardhat compile` regenerates `atsRoles.generated.ts` as `ROLES = {}` and every
  role-dependent test breaks. If you ever see `ROLES = {}` in a `git diff`, this is why.
