-- A future-dated legacy cursor is not evidence to suppress later ordinary
-- traffic. Cap retained boundaries at the lifecycle's initialization time.
UPDATE channel_delivery_lifecycles l SET legacy_boundaries = COALESCE(
  (SELECT jsonb_object_agg(key, CASE WHEN value::bigint > l.activation_floor THEN GREATEST(0, l.activation_floor - 1) ELSE value::bigint END)
   FROM jsonb_each_text(l.legacy_boundaries)), '{}'::jsonb
);
