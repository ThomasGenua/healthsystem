import { createStagingAlertSink } from "../src/core/staging-alert-sink.ts";
if (process.env.NORTHSTAR_SYNTHETIC_ALERT_SINK !== "on") throw new Error("Synthetic alert sink requires explicit opt-in");
const server = createStagingAlertSink();
server.requestTimeout = 5000;
server.listen(9094, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
