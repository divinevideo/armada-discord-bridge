import { createHash } from "node:crypto";

export const REQUIRED_CAPACITY_CASES = ["cold", "warm", "restart", "append", "cache_entries", "cache_bytes", "rekey", "held_roots", "stream_growth", "lock_contention", "concurrency", "plugin_failure", "sql_timeout", "external_timeout"] as const;
export type CapacityCaseId = typeof REQUIRED_CAPACITY_CASES[number];
export interface CapacityResources { cpus: number; memoryBytes: number; database: string }
export interface CapacitySample {
  caseId: CapacityCaseId; historyCount: number; historyBytes: number; rekeyCount: number; streamCount: number; inFlight: number;
  wallMs: number; innerAdmissionMs: number | null; expectedAccept: boolean; accepted: boolean; okReceived: boolean;
  persisted: boolean; fanout: boolean; lateDatabaseWrite: boolean; unsafeEffect: boolean; innerNotStarted?: boolean; error?: string;
}
export interface CapacityMeasurementReport {
  version: 1; sourceSha: string; harnessSha: string; imageId: string; platform: string; resourceEnvelope: CapacityResources;
  fixtureHash: string; matrixHash: string; startedAt: number; finishedAt: number; emulated: boolean; certified: false;
  provenance: { destinationMatched: boolean; controllerModelVerified: boolean };
  cases: { id: CapacityCaseId; status: "measured" | "unsupported"; reason?: string; samples: CapacitySample[] }[];
}
export interface PublicCapacityContract {
  version: 1; sourceSha: string; harnessSha: string; imageId: string; platform: string; reportHash: string;
  resourceEnvelope: CapacityResources;
  maxima: { historyCount: number; historyBytes: number; rekeyCount: number; streamCount: number; inFlight: number; innerAdmissionMs: number };
  thresholds: { warningHistoryCount: number; pauseHistoryCount: number; urgentReserve: number };
  deadlines: { sqlMs: number; pluginMs: number; externalMs: number; observedMaxMs: number };
  maxSampleAgeMs: number; measuredAt: number; measurement: CapacityMeasurementReport;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function capacityReportHash(report: CapacityMeasurementReport): string { return createHash("sha256").update(canonical(report)).digest("hex"); }
function need(value: unknown, message: string): asserts value { if (!value) throw new Error(`Invalid capacity contract: ${message}`); }
function finite(value: unknown, positive = false): value is number { return typeof value === "number" && Number.isFinite(value) && (positive ? value > 0 : value >= 0); }
function integer(value: unknown, positive = false): value is number { return finite(value, positive) && Number.isSafeInteger(value); }
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
const FAILURE_CASES = new Set(["plugin_failure", "sql_timeout", "external_timeout"]);

/** Validate externally reviewed measurement data; a hash is integrity, not an attestation of who measured it. */
export function validateCapacityContract(value: unknown, buildIdentity: { sourceSha: string; platform: string }): PublicCapacityContract {
  need(object(value) && value.version === 1, "unsupported version");
  const c = value as PublicCapacityContract;
  need(/^[0-9a-f]{40}$/.test(c.sourceSha) && /^[0-9a-f]{40}$/.test(c.harnessSha), "full source/harness identity required");
  need(c.sourceSha === buildIdentity.sourceSha && c.platform === buildIdentity.platform && /^linux\/(amd64|arm64)$/.test(c.platform), "build identity mismatch");
  need(/^sha256:[0-9a-f]{64}$/.test(c.imageId) && /^[0-9a-f]{64}$/.test(c.reportHash), "immutable image/report identity required");
  need(object(c.resourceEnvelope) && finite(c.resourceEnvelope.cpus, true) && integer(c.resourceEnvelope.memoryBytes, true) && typeof c.resourceEnvelope.database === "string" && c.resourceEnvelope.database.length > 0, "resource envelope required");
  need(object(c.maxima) && object(c.thresholds) && object(c.deadlines), "bounds required");
  for (const key of ["historyCount", "historyBytes", "rekeyCount", "streamCount", "inFlight"] as const) need(integer(c.maxima[key], key === "inFlight"), `invalid maximum ${key}`);
  need(finite(c.maxima.innerAdmissionMs, true) && c.maxima.innerAdmissionMs < 1500, "inner admission has no SQL margin");
  need(c.deadlines.sqlMs === 1500 && c.deadlines.pluginMs === 2000 && c.deadlines.externalMs === 3000, "hard deadlines cannot change");
  need(finite(c.deadlines.observedMaxMs, true) && c.deadlines.observedMaxMs < 3000, "external deadline has no measured margin");
  need(integer(c.maxSampleAgeMs, true) && integer(c.measuredAt, true), "sample freshness required");
  const { warningHistoryCount: warning, pauseHistoryCount: pause, urgentReserve: reserve } = c.thresholds;
  need(integer(warning) && integer(pause, true) && integer(reserve, true) && warning < pause && pause < 4096, "unordered history thresholds");
  need(pause + reserve + c.maxima.inFlight <= c.maxima.historyCount && c.maxima.historyCount < 4096, "pause lacks measured overshoot/rekey reserve");
  const report = c.measurement;
  need(object(report) && report.version === 1 && report.certified === false, "raw measurement report required");
  need(report.sourceSha === c.sourceSha && report.harnessSha === c.harnessSha && report.imageId === c.imageId && report.platform === c.platform, "measurement identity mismatch");
  need(canonical(report.resourceEnvelope) === canonical(c.resourceEnvelope), "measurement resources mismatch");
  need(/^[0-9a-f]{64}$/.test(report.fixtureHash) && /^[0-9a-f]{64}$/.test(report.matrixHash), "fixture/matrix provenance required");
  need(integer(report.startedAt, true) && integer(report.finishedAt, true) && report.startedAt <= report.finishedAt && c.measuredAt === report.finishedAt, "measurement timestamps mismatch");
  need(report.emulated === false && object(report.provenance) && report.provenance.destinationMatched === true && report.provenance.controllerModelVerified === true, "destination/controller assumptions unverified");
  need(Array.isArray(report.cases) && report.cases.length === REQUIRED_CAPACITY_CASES.length, "missing measurement cases");
  need(new Set(report.cases.map((entry) => entry.id)).size === REQUIRED_CAPACITY_CASES.length, "duplicate measurement cases");
  const normal: CapacitySample[] = [];
  let earliestFailure = 4096;
  for (const id of REQUIRED_CAPACITY_CASES) {
    const entry = report.cases.find((candidate) => candidate.id === id);
    need(entry?.status === "measured" && Array.isArray(entry.samples) && entry.samples.length > 0, `unmeasured ${id}`);
    need(!FAILURE_CASES.has(id) || entry.samples.some((sample) => sample.expectedAccept === false), `missing injected refusal ${id}`);
    for (const sample of entry.samples) {
      need(object(sample) && sample.caseId === id, "sample scenario mismatch");
      for (const key of ["historyCount", "historyBytes", "rekeyCount", "streamCount", "inFlight"] as const) need(integer(sample[key], key === "inFlight"), `invalid sample ${key}`);
      need(finite(sample.wallMs) && (finite(sample.innerAdmissionMs) || (FAILURE_CASES.has(id) && sample.innerNotStarted === true && sample.innerAdmissionMs === null && !sample.accepted)), "unmeasured inner/external time");
      need([sample.expectedAccept, sample.accepted, sample.okReceived, sample.persisted, sample.fanout, sample.lateDatabaseWrite, sample.unsafeEffect].every((flag) => typeof flag === "boolean"), "sample outcomes required");
      need(sample.okReceived && !sample.lateDatabaseWrite && !sample.unsafeEffect, "unsafe/uncertain external outcome");
      need(sample.persisted === sample.accepted && sample.fanout === sample.accepted, "relay persistence/fanout mismatch");
      if (sample.expectedAccept && (!sample.accepted || sample.wallMs >= 3000 || sample.innerAdmissionMs! >= 1500)) earliestFailure = Math.min(earliestFailure, sample.historyCount);
      else if (sample.expectedAccept) normal.push(sample);
      else need(!sample.accepted && !sample.persisted && !sample.fanout, "fault injection accepted");
    }
  }
  need(pause + reserve + c.maxima.inFlight < earliestFailure, "pause reaches an observed failure boundary");
  need(normal.length > 0, "no passing capacity envelope");
  for (const key of ["historyCount", "historyBytes", "rekeyCount", "streamCount", "inFlight", "innerAdmissionMs"] as const) {
    need(c.maxima[key] <= Math.max(...normal.map((sample) => sample[key]!)), `unmeasured bound ${key}`);
  }
  need(c.deadlines.observedMaxMs >= Math.max(...normal.filter((s) => s.historyCount <= c.maxima.historyCount).map((sample) => sample.wallMs)), "understated observed latency");
  need(capacityReportHash(report) === c.reportHash, "measurement hash mismatch");
  return c;
}
