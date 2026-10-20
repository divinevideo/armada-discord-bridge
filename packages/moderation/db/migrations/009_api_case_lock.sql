-- FOR SHARE needs UPDATE on one column; evidence and expiry stay read-only.
GRANT UPDATE (case_id) ON moderation.cases TO moderation_api;
