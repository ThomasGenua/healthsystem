# Local synthetic staging

This is a local rehearsal package, not a clinical deployment. The app is bound
to `127.0.0.1:18686`, uses API-key authentication, and starts with an empty
dedicated named volume. Demo identity, synthetic antivirus, sample outbound
channels and live providers are disabled. Never load real patient data here.

## Start and verify

From the repository root, with Docker running Linux containers:

```sh
docker compose -f deploy/staging/compose.yaml config --quiet
docker compose -f deploy/staging/compose.yaml up --build -d --wait app
npm run staging:smoke
```

Open `http://127.0.0.1:18686/me`. Clinic sign-in is unavailable until a provider
is configured. The first bootstrap operator key is in app logs; treat those
logs as credentials and do not attach them to issues or CI artifacts. The
smoke test uses no credentials and checks health, HTML, protected admin/patient
routes and disabled development identity. It is not an authenticated clinical
journey; the repository's portal browser tests cover that with a fake issuer.

Optional synthetic chart seed: before the first `up`, on a fresh dedicated
volume only:

```sh
docker compose -f deploy/staging/compose.yaml run --rm app node scripts/portal-demo.ts /var/lib/northstar
```

Do not run the seed against a running server or a volume containing real records.

## Real local scanner

The optional official ClamAV container needs several GB of RAM, disk space and
network access for signatures. Its network namespace is shared with the app
so the existing loopback-only scanner adapter remains local. Port 3310 is
never published. Without the scanner, uploads remain quarantined.

```sh
docker compose -f deploy/staging/compose.yaml --profile scanner up -d --wait --wait-timeout 600
docker compose -f deploy/staging/compose.yaml exec -T app node scripts/staging-smoke.ts http://127.0.0.1:8686 --scanner
```

The scanner check sends a harmless sample and the standard EICAR test string
directly to clamd; it does not store either in a chart. Maintain signatures
and rehearse actual upload outages before enabling the feature at a site.
Recreate the scanner whenever the app container is recreated, since their
network namespace is shared.

## Stop, retain and upgrade

`docker compose -f deploy/staging/compose.yaml --profile scanner down` stops
the stack and retains both named volumes. Do not use `down -v` casually: it
deletes the staging database and signature volume. Images use recorded registry
digests; dependencies use the npm lockfile. Review and deliberately update
digests for security patches, then rebuild and rerun checks. FreshClam signature
updates remain mutable by design. Record the git commit with rehearsal results.

The container runs as the Node non-root user with a read-only root filesystem,
dropped app capabilities and dedicated data/tmp storage. These settings are
not a substitute for host security, volume encryption or backup recovery.

## Move toward a pilot

`clinic.env.example` is a reference, not automatically loaded. Select the host,
identity provider and backup store first. Register the exact HTTPS callback,
mount secret files read-only, configure TLS (or the site's trusted proxy), and
override the app environment through a separately reviewed Compose override.
Do not put secret values in YAML, build arguments or committed env files.
The local HTTP smoke target will need to become HTTPS after that change.

Run `npm run preflight` in the configured service environment. The default
local package deliberately fails its pilot identity/backup checks; do not turn
them off to make it green. Use `docs/PILOT-ACCEPTANCE.md` for site evidence.

References: [Docker Compose services](https://docs.docker.com/reference/compose-file/services/)
and [official ClamAV containers](https://docs.clamav.net/manual/Installing/Docker.html).

## Recorded local verification — 2026-09-12

Docker Compose configuration validation, image build, localhost smoke checks,
real clamd clean/EICAR checks and app restart smoke checks passed. The four
smoke unit tests passed in the Linux image. Type-checking passed. The Windows
test assertions passed but the Node 24.11.0 process encountered the previously
observed native shutdown assertion; that run is not recorded as passing.
No remote deployment, real clinic provider, real patient data or site approval
was involved. CI now includes a container build/start/restart smoke job; that
job deliberately excludes the resource-intensive optional scanner profile.
