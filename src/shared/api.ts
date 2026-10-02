import {Issue, Schema} from './schema';
import {CompatibilityReport, Direction, DirectionResult} from './compat';

export type UnknownPolicy = 'fail' | 'passthrough';

export interface CompareInput {
  v1: unknown;
  v2: unknown;
  policy: UnknownPolicy;
}

export interface CompareResponse {
  policy: UnknownPolicy;
  lint: { v1: Issue[]; v2: Issue[] };
  report: CompatibilityReport;
  cache: {
    keys: { backward: string; forward: string };
    hits: { backward: boolean; forward: boolean };
    totalMs: number;
  };
}

export type {CompatibilityReport, Counterexample, DirectionResult, Direction, UnionHop} from './compat';

// ---- Multi-consumer release governance --------------------------------------
//
// One producer draft is evaluated against a NAMED SET of consumers, each on its
// own deployed revision. Previews pin the revisions they were computed from;
// the publish endpoint re-checks those revisions server-side and recomputes
// every verdict, so a stale browser preview can never approve a changed world.

export interface ConsumerSummary {
  id: string;
  name: string;
  revision: number;
  required: boolean;
  updatedAt: string;
}

export interface Consumer extends ConsumerSummary {
  schema: Schema;
}

// Per-consumer directional verdicts, kept independent — never folded into one
// sourceless traffic light. `backward` answers the release question: can THIS
// consumer read data produced by the draft? `forward` is shown as risk.
export interface ConsumerVerdict {
  consumerId: string;
  name: string;
  required: boolean;
  revision: number;
  backward: DirectionResult; // draft producer -> this consumer (admission gate)
  forward: DirectionResult;  // this consumer's producer -> draft consumer (risk)
}

export interface PreviewResponse {
  previewToken: string;
  fingerprint: string;
  policy: UnknownPolicy;
  producer: Schema;
  producerLint: Issue[];
  consumers: ConsumerVerdict[];
  pinned: { id: string; revision: number; required: boolean }[];
  gate: {
    passes: boolean;
    rule: string;
    requiredChecked: number;
    requiredBlocked: { consumerId: string; revision: number }[];
  };
  computedAt: string;
}

export interface ReleaseRecord {
  id: string;
  publishedAt: string;
  policy: UnknownPolicy;
  producer: Schema;
  producerFingerprint: string;
  gateRule: string;
  consumers: Array<{
    consumerId: string;
    name: string;
    required: boolean;
    revision: number;
    schema: Schema;
    backward: DirectionResult;
    forward: DirectionResult;
  }>;
  previewFingerprint: string;
}

export interface ConfirmResponse {
  release: ReleaseRecord;
}

export const GATE_RULE =
  'every required consumer reads every producer instance: backward-compatible for all required consumers';
