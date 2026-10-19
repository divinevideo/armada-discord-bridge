import { describe, expect, it } from "bun:test";
import { capacityReportHash, REQUIRED_CAPACITY_CASES, validateCapacityContract } from "./capacityContract";
import type { CapacityMeasurementReport, PublicCapacityContract } from "./capacityContract";

// Synthetic contract inputs test validation; these values certify no deployment.
function fixture(): PublicCapacityContract {
  const sourceSha = "1".repeat(40), harnessSha = "2".repeat(40), imageId = "sha256:" + "3".repeat(64);
  const resources = { cpus: 1, memoryBytes: 536870912, database: "synthetic-postgres-envelope" };
  const report: CapacityMeasurementReport = {
    version: 1, sourceSha, harnessSha, imageId, platform: "linux/amd64", resourceEnvelope: resources,
    fixtureHash: "4".repeat(64), matrixHash: "5".repeat(64), startedAt: 1000, finishedAt: 2000,
    emulated: false, certified: false, provenance: { destinationMatched: true, controllerModelVerified: true },
    cases: REQUIRED_CAPACITY_CASES.map((id) => ({ id, status: "measured", samples: [{
      caseId: id, historyCount: 64, historyBytes: 65536, rekeyCount: 2, streamCount: 8, inFlight: 4,
      wallMs: 100, innerAdmissionMs: 60, expectedAccept: true, accepted: true, okReceived: true,
      persisted: true, fanout: true, lateDatabaseWrite: false, unsafeEffect: false,
    }] })),
  };
  for (const entry of report.cases.filter((c) => ["plugin_failure", "sql_timeout", "external_timeout"].includes(c.id))) {
    Object.assign(entry.samples[0], { expectedAccept: false, accepted: false, persisted: false, fanout: false });
  }
  return { version: 1, sourceSha, harnessSha, imageId, platform: "linux/amd64", reportHash: capacityReportHash(report),
    resourceEnvelope: resources, maxima: { historyCount: 64, historyBytes: 65536, rekeyCount: 2, streamCount: 8, inFlight: 4, innerAdmissionMs: 60 },
    thresholds: { warningHistoryCount: 16, pauseHistoryCount: 32, urgentReserve: 8 },
    deadlines: { sqlMs: 1500, pluginMs: 2000, externalMs: 3000, observedMaxMs: 100 },
    maxSampleAgeMs: 30000, measuredAt: 2000, measurement: report };
}
const identity = { sourceSha: "1".repeat(40), platform: "linux/amd64" };
function resign(value: PublicCapacityContract) { value.reportHash = capacityReportHash(value.measurement); return value; }

describe("measured capacity contract", () => {
  it("accepts a complete internally consistent synthetic evidence artifact", () => {
    expect(validateCapacityContract(fixture(), identity).thresholds.pauseHistoryCount).toBe(32);
  });
  it("rejects unsupported versions, missing evidence and source mismatch", () => {
    for (const value of [null, {}, { ...fixture(), version: 2 }, { ...fixture(), measurement: undefined }, { ...fixture(), sourceSha: "a".repeat(40) }]) {
      expect(() => validateCapacityContract(value, identity)).toThrow();
    }
  });
  it("rejects missing/duplicate/unmeasured scenarios", () => {
    for (const change of [(r: CapacityMeasurementReport) => r.cases.pop(), (r: CapacityMeasurementReport) => r.cases.push(r.cases[0]), (r: CapacityMeasurementReport) => { r.cases[0].status = "unsupported"; }]) {
      const value = fixture(); change(value.measurement);
      expect(() => validateCapacityContract(resign(value), identity)).toThrow();
    }
  });
  it("rejects nonfinite, unordered and unmeasured maxima", () => {
    for (const mutate of [(v: PublicCapacityContract) => { v.maxima.historyBytes = Infinity; }, (v: PublicCapacityContract) => { v.thresholds.warningHistoryCount = 40; }, (v: PublicCapacityContract) => { v.thresholds.pauseHistoryCount = 4096; }, (v: PublicCapacityContract) => { v.maxima.historyCount = 128; }, (v: PublicCapacityContract) => { v.thresholds.urgentReserve = 60; }]) {
      const value = fixture(); mutate(value);
      expect(() => validateCapacityContract(value, identity)).toThrow();
    }
  });
  it("rejects changed hard deadlines and a ceiling at an observed failure", () => {
    const changed = fixture(); changed.deadlines.externalMs = 6000;
    expect(() => validateCapacityContract(changed, identity)).toThrow();
    const failed = fixture(); failed.measurement.cases[0].samples.push({ ...failed.measurement.cases[0].samples[0], historyCount: 32, accepted: false, persisted: false, fanout: false, wallMs: 3001 });
    expect(() => validateCapacityContract(resign(failed), identity)).toThrow();
  });
  it("rejects forged hashes, mismatched image/resource/fixture identity and emulation", () => {
    for (const mutate of [(v: PublicCapacityContract) => { v.reportHash = "0".repeat(64); }, (v: PublicCapacityContract) => { v.imageId = "sha256:" + "a".repeat(64); }, (v: PublicCapacityContract) => { v.resourceEnvelope = { ...v.resourceEnvelope, cpus: 2 }; }, (v: PublicCapacityContract) => { v.measurement.fixtureHash = ""; resign(v); }, (v: PublicCapacityContract) => { v.measurement.emulated = true; resign(v); }]) {
      const value = fixture(); mutate(value);
      expect(() => validateCapacityContract(value, identity)).toThrow();
    }
  });
  it("rejects unknown inner timings, unsafe late work, false acceptance or lost fanout", () => {
    for (const changes of [{ innerAdmissionMs: null }, { lateDatabaseWrite: true }, { unsafeEffect: true }, { persisted: false }, { fanout: false }, { okReceived: false }]) {
      const value = fixture(); Object.assign(value.measurement.cases[0].samples[0], changes);
      expect(() => validateCapacityContract(resign(value), identity)).toThrow();
    }
  });
  it("rejects unverified destination/controller assumptions and stale report identity", () => {
    for (const mutate of [(v: PublicCapacityContract) => { v.measurement.provenance.controllerModelVerified = false; }, (v: PublicCapacityContract) => { v.measurement.provenance.destinationMatched = false; }, (v: PublicCapacityContract) => { v.measuredAt = 999; }, (v: PublicCapacityContract) => { v.maxSampleAgeMs = 0; }]) {
      const value = fixture(); mutate(value);
      expect(() => validateCapacityContract(resign(value), identity)).toThrow();
    }
  });
});
