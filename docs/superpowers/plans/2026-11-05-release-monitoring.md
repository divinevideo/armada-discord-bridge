# Concord release monitoring implementation

Approved scope: finish the monitoring required by the connected-community release plan before private activation. No protocol authorization or deployment changes.

1. Test then add a worker authority observation using the verified existing control fold, current grant citation, BAN and MANAGE_MESSAGES permissions, ban/rekey/completeness/freshness checks and the current control write key. Export one expiring aggregate gauge; keep action authorization unchanged.
2. Test then add persisted paused/severed bridge counts to the internal portal metrics endpoint. Failed SQL queries fail the scrape. Worker metrics also check SQL connectivity; no identity or evidence labels.
3. In the infrastructure companion change, scrape worker port 8081 and production CNPG port 9187, and alert on missing authority, paused/severed bridges, failed/absent scrapes and failed/missing/overdue daily backups. Use existing severity-based on-call routes. Aggregate backup timestamps across the selected cluster; allow 30 hours for the daily schedule (24 hours plus six hours of completion/retry allowance).
4. Verify synthetic authority vectors and real disposable-Postgres status aggregates, the full integration/type/build gate, and deployed alert expressions with promtool firing/recovery/absence/failover cases. Freeze commits for independent review. Container runtime validation remains required when a Docker daemon and test images are available; local SQL tests cannot substitute for it.

The authority gauge describes general worker capability, not authority over every member/channel or a completed moderation action. Existing action-specific checks remain the source of truth. A green backup timestamp does not establish restore success or relay-volume coverage.
