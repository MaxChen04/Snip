/**
 * The Worker's own version, reported by `/transfer/status`, `/api/cloud-status` and the MCP
 * server so one number identifies a deployment. This is the only version constant: nothing
 * compares it to the desktop app's version, and the engine compares the deployed value against
 * `cloud.workerVersion`, which it records at deploy time (contracts §5.4).
 *
 * Bump it whenever `web/worker` or the schema changes in a way the client can observe.
 */
export const WORKER_VERSION = "1.1.2"
