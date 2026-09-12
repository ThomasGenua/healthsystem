# Local alert pipeline and outage drill

This routes alerts to a local synthetic receiver, **not an operator**. It sends
no email, SMS or external webhook. Prometheus and Alertmanager use pinned image
digests. Their dashboards are bound to localhost (19090 and 19093); the test
receiver is on localhost 19094. Metrics, silences and test events are ephemeral.

Run `npm run staging:drill` from the repository root. It creates only the fixed
`northstar-alert-drill` project, refuses existing project containers, builds the
app, waits for a successful metrics scrape, stops only that app, verifies a
firing webhook, restarts it and verifies a resolved webhook. The app uses
localhost port 18986. Allow several minutes for image downloads and the
one-minute alert threshold. Other stacks and their ports are not stopped.
Finally it removes its containers/network but retains its synthetic data volume.
If interrupted during Docker execution, inspect that project before rerunning.

The receiver keeps at most 100 known alert names and firing/resolved states;
it discards labels and annotations. It is intentionally unauthenticated inside
the local rehearsal network. Never expose or reuse it as a clinical receiver.

| Alert | Default trigger | First response |
|---|---|---|
| ServiceDown | Scrape failure for 1 minute | Check app health, network, disk and process; preserve evidence |
| ScannerBacklog | Oldest upload over 15 minutes for 2 minutes | Check daemon/signatures and retries; never release quarantine manually |
| DeliveryFailures | Dead letters for 2 minutes | Inspect authenticated delivery queue; resolve cause before replay |
| BackupFailed | Configured replica not verified for 5 minutes | Check destination/key/connectivity; preserve last good backup |
| BackupStale | Verified replica older than 24 hours for 5 minutes | Check backup schedule and recent failures |

Thresholds are staging defaults, not recovery commitments. Notification delivery
metrics cover transport dead letters, not patient awareness or all provider
receipts. Missing/unconfigured backup is a preflight blocker, not this incident
alert. This stack cannot independently alert if the entire host or Prometheus
fails; an external heartbeat/uptime monitor and receiver ownership are required.

## Before connecting an operator

Choose the receiver and escalation owner, route via the provider's documented
authenticated HTTPS mechanism, mount credentials as secrets, restrict dashboard
access and test delivery/acknowledgement/recovery with the actual recipient.
Do not copy the local HTTP sink URL into production. Decide backup cadence,
retention, severity, quiet-hours policy and on-call coverage with the site.
The operator notification and independent review steps remain outstanding.

Rule fixtures test all five firing conditions plus a healthy/unconfigured
baseline. CI also runs the actual outage pipeline. These are not evidence of
off-machine disaster recovery or real operator delivery.

Local verification on 2026-09-12: Prometheus rule fixtures passed; the actual
Docker outage drill received firing and resolved webhooks; receiver privacy
tests and TypeScript checks passed. Drill containers/network were removed and
the dedicated synthetic data volume retained. The added CI workflow has not yet
run on GitHub for this monitoring increment.

References: [Prometheus configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)
and [Alertmanager receivers](https://prometheus.io/docs/alerting/latest/configuration/).
