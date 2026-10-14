import { expect, test } from 'bun:test';
import { renderMetrics } from './metrics';
test('operational metrics include only bounded aggregate labels and stale policy age', () => {
  const result = renderMetrics({ policyCount: 1, policyRevision: 42, policyAge: 61, pending: 3, failed: 2, oldestPendingAge: 120 });
  expect(result).toContain('concord_policy_age_seconds 61\n');
  expect(result).toContain('concord_deliveries_pending 3\n');
  expect(result).toContain('concord_deliveries_failed 2\n');
  expect(result).not.toContain('{');
  expect(() => renderMetrics({ policyCount: 1, policyRevision: 42, policyAge: NaN, pending: 3, failed: 2, oldestPendingAge: 120 })).toThrow();
});
