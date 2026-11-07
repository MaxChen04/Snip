/**
 * The Worker's own version, reported by `/transfer/status`, `/api/cloud-status` and the MCP
 * server so one number identifies a deployment. The provisioning engine records this at deploy
 * time and compares it later to detect drift; bump it whenever `web/worker` or the schema changes
 * in a way the client can observe.
 */
export const WORKER_VERSION = "1.1.0"

/** The value the MCP server advertises in its handshake. */
export const MCP_SERVER_VERSION = WORKER_VERSION
