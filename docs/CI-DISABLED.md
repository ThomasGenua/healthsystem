# Continuous integration is disabled

**Status: disabled. Requested by the repository owner on 2026-09-22.**

Every GitHub Actions workflow in this repository has had its automatic
triggers removed. Nothing runs on a push, on a pull request, or on a
schedule. Each workflow keeps `workflow_dispatch`, so a maintainer can still
start any of them deliberately from the **Actions** tab.

The reason is a change in how work is promoted here, not a problem with the
checks: changes are reviewed and merged by hand, and the owner asked that no
run start on their behalf in between.

## What was *not* done, and why it matters

A disabled pipeline and a pipeline rigged to report success look identical
from the outside, and only one of them is honest. So, explicitly:

- **No job, step, assertion or timeout was changed.** The diff that disabled
  CI removes trigger lines and adds comments. It touches nothing else.
- **No `continue-on-error`, no `if: false`, no `|| true`, no `--passWithNoTests`,
  no swallowed exit code.** If one of these workflows is started by hand
  today, it runs exactly the checks it always ran and fails on exactly what it
  always failed on.
- **No test was skipped, quarantined or deleted** to make anything pass.
- **No workflow file was deleted.** The configuration and its history are
  intact and the diff is readable, which is what makes re-enabling a one-line
  revert rather than an archaeology exercise.
- **CI was green when it was switched off.** The last automatic run of each
  workflow on `main` — commit `96325ac` — concluded `success`. This disables a
  passing pipeline; it does not bury a failing one.

## What was disabled

| Workflow | File | Jobs | Trigger removed | Trigger kept |
| --- | --- | --- | --- | --- |
| CI | `.github/workflows/ci.yml` | `check` (node 22.x, 24.x), `supply-chain` | `push` to every branch, `pull_request` | `workflow_dispatch` |
| Monitoring rules and outage drill | `.github/workflows/monitoring.yml` | `drill` | `push`, `pull_request` | `workflow_dispatch` |
| Resilience | `.github/workflows/resilience.yml` | `crash`, `disk-full`, `restore`, `load` | `schedule` (`0 8 * * *`, nightly) | `workflow_dispatch` (unchanged, still takes `messages`) |
| Staging container | `.github/workflows/staging.yml` | `smoke` | `push`, `pull_request` | `workflow_dispatch` |

That is all four workflows in the repository. There is no Dependabot
configuration, no CodeQL workflow and no other GitHub automation, so nothing
outside this table was touched.

### Deliberately left alone

- **The application itself.** No runtime process, timer, worker or health
  check was disabled. `src/` is untouched by this change.
- **Deployment.** None of these workflows deploys anything; `staging.yml`
  builds and smoke-tests a container inside the runner and tears it down.
  There was no deployment pipeline to disable, and none was.
- **Security controls outside CI.** `SECURITY.md`, private vulnerability
  reporting, the authentication gate, the audit trail and the secret-handling
  rules are all unaffected.

### The one security-relevant casualty, named

`ci.yml`'s `supply-chain` job is the exception worth stating out loud rather
than leaving in the table. It produces a CycloneDX SBOM and the packed
tarball on every run, and a signed **build provenance attestation** over both
on the default branch. Those are supply-chain security artifacts, and while
CI is disabled **no new ones are minted** — a commit landing on `main` today
gets no attestation.

It is disabled along with the rest because it is a CI job and the request was
to disable CI, not because it is unimportant. Existing attestations remain
valid for the commits they were minted against. Anyone cutting a release
while CI is off should start `CI` by hand from the Actions tab on the release
commit, which mints the attestation for that tree.

## What still has to be run, and how

Nothing below needs CI. It is what CI was running, in the form a person runs
it:

```sh
npm ci
npm run typecheck                  # tsc --noEmit; there is no build step
npm test                           # the full suite
npm run hazardcheck -- origin/main # hazard identifiers vs the branch being merged into
```

`NORTHSTAR_REQUIRE_BROWSER=1` makes a missing Chromium fail rather than skip
the browser journey; set `NORTHSTAR_TEST_CHROME` to the binary.

The heavier rehearsals, which used to run nightly:

```sh
npm run crashtest    -- --messages 300 --kills 3
npm run diskfulltest -- --dir /a/size-capped/filesystem
npm run restoretest  -- --messages 20000
npm run loadtest     -- --messages 20000
```

And the container boundary check, which `staging.yml` ran:

```sh
docker compose -f deploy/staging/compose.yaml up --build -d --wait app
docker compose -f deploy/staging/compose.yaml exec -T app \
  node scripts/staging-smoke.ts http://127.0.0.1:8686
```

The hazard check is the one most easily forgotten and the one that fails
silently when it is: it is the only coordination between branches allocating
hazard identifiers, and two branches cut from the same revision will
otherwise both claim the next number and each look correct on its own. See
[CLINICAL-SAFETY.md](CLINICAL-SAFETY.md) §4.

## Re-enabling

Put the trigger block back at the top of each file, below `name:`, and delete
the `CI IS DISABLED` comment beneath it.

`.github/workflows/ci.yml`:

```yaml
on:
  push:
    branches: ["**"]
  pull_request:
```

`.github/workflows/monitoring.yml` and `.github/workflows/staging.yml`:

```yaml
on: [push, pull_request]
```

`.github/workflows/resilience.yml` — restore the `schedule:` stanza above the
existing `workflow_dispatch:`, leaving its `inputs:` as they are:

```yaml
on:
  schedule:
    # 08:00 UTC is roughly 01:00 in Yellowknife, so a failure is waiting in the
    # morning rather than interrupting the day.
    - cron: "0 8 * * *"
  workflow_dispatch:
    inputs:
      messages:
        description: "Messages to push through the crash and load tests"
        required: false
        default: "300"
```

Then delete this file, and restore the two sentences noted in its commit —
in `README.md` under **Contributing** and in `docs/CLINICAL-SAFETY.md` §4 —
which were changed because they said CI runs these checks and it no longer
does.

If branch protection on `main` requires any of these checks, re-enabling is
also what unblocks merges: with the workflows disabled, a required check
never reports, and a pull request waits for a status that cannot arrive.
Protection rules are repository settings and cannot be changed from the
working tree; adjust them in **Settings → Branches** if merges are blocked.
