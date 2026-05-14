# AGENTS.md (reconstruction phase)

This file defines the minimum rules for rebuilding project history from `v0.1.0` to `v0.7.0`.

## 1. Scope and target (temporary, remove after reconstruction)

- Rebuild commits in version order: `v0.1.0` -> `v0.7.0`.
- One version update per commit.
- Do not introduce unrelated features during reconstruction.

## 2. Commit hygiene

- Stage files by explicit paths only.
- Do not use `git add .`.
- During reconstruction, do not include `mineru-pdf-converter/` in any commit.

## 3. Version synchronization (must keep)

For each version commit, update these files together:

1. `manifest.json` (`version`)
2. `package.json` (`version`)
3. `package-lock.json` (top-level versions)
4. `CHANGELOG.md` (matching release notes)

## 4. dev-logs policy (temporary for reconstruction)

- Keep logs under repo-root `dev-logs/`.
- During reconstruction, write logs but do not commit them with version commits.
- After review and cleanup, commit logs in a separate final docs commit.

## 5. Knowledge capture (must keep)

Only record items that are proven and reusable:

- concrete issue
- verified solution
- impact/risk

## 6. Reconstruction notes

- Reserved for high-value findings during reconstruction.

## 7. Reconstruction notes

- Reserved for high-value findings during reconstruction.

## 8. Reconstruction notes

- Reserved for high-value findings during reconstruction.

## 9. Reconstruction notes

- Reserved for high-value findings during reconstruction.

## Post-reconstruction cleanup plan

After reconstruction:

- remove section 1
- in section 2, remove the `mineru-pdf-converter/` restriction
- keep section 3
- in section 4, switch to "commit dev-logs together with each version change"
- keep section 5
- keep and refine sections 6-9 as project memory
