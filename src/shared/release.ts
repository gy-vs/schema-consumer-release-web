// Multi-consumer release model.
//
// A release is ONE producer candidate draft evaluated against a ROSTER of
// consumers, each at its own revision and deploying on its own cadence:
//
//   consumer 甲 (required)  — still on the old closed union
//   consumer 乙 (required)  — already on an intermediate definition
//   consumer 丙 (optional)  — only handles open unions
//
// Compatibility with one consumer never implies compatibility with the set.
// The admission gate is: EVERY consumer marked `required` at PREVIEW time must
// accept data produced by the draft (backward direction only — the deploy
// question is "can each deployed consumer read the new producer's data").
// Non-required consumers still get a verdict and a risk label, but never move
// the gate.
//
// State consistency across preview -> confirm -> later inspection:
//   * A preview pins exact consumer revisions and a hash of the producer
//     definition; the server returns an opaque token.
//   * Publishing sends only the token. The server re-checks that the token is
//     fresh (no consumer definition changed since the preview) and RE-RUNS the
//     gate server-side. The browser result can never authorize itself.
//   * The persisted release record stores the exact producer definition and
//     consumer revisions/verdict snapshots the decision was based on, so
//     reopening the page shows what the server confirmed, not the last thing
//     the browser computed.

import { Issue } from './schema';
import { DirectionResult } from './compat';
import { UnknownPolicy } from './api';

export type ReleaseConsumerDirection = DirectionResult;

export interface ConsumerSummary {
  id: string;
  name: string;
  required: boolean;
  revision: number;
  /** sha256 hex of the canonicalized, parsed schema (policy NOT applied). */
  schemaHash: string;
  updatedAt: string;
}

export interface ConsumerDetail extends ConsumerSummary {
  /** The exact schema JSON the consumer currently accepts. */
  schema: unknown;
  policy: UnknownPolicy;
  lint: Issue[];
}

// ---- Roster mutations ---------------------------------------------------------

export interface ConsumerUpsert {
  name: unknown;
  required: unknown;
  schema: unknown;
  policy: unknown;
  /** Required on PUT (optimistic concurrency); absent on POST creates one. */
  expectedRevision?: unknown;
}

// ---- Preview ------------------------------------------------------------------

export interface PreviewRequest {
  producer: unknown;
  policy: UnknownPolicy;
}

export interface ConsumerVerdict {
  consumerId: string;
  consumerName: string;
  required: boolean;
  consumerRevision: number;
  consumerSchemaHash: string;
  /** producer(draft) -> consumer, from the shared bidirectional engine. */
  result: ReleaseConsumerDirection;
  /** Gate contribution: required consumers failing verdict block release. */
  status: 'pass' | 'required_blocking' | 'risk_non_required';
  /** First failure reasons, for the collapsed roster view. */
  rejectionReasons: string[];
}

export interface PreviewConsumerPin {
  consumerId: string;
  revision: number;
  required: boolean;
  schemaHash: string;
}

export interface Preview {
  token: string;
  createdAt: string;
  /** Hash of the parsed canonical producer definition the token is bound to. */
  producerHash: string;
  policy: UnknownPolicy;
  requiredConsumerIds: string[];
  pins: PreviewConsumerPin[];
  verdicts: ConsumerVerdict[];
  lint: Issue[];
  gate: {
    admissible: boolean;
    blocking: Array<{ consumerId: string; reasons: string[] }>;
    /** Consumers that fail but are outside the admission gate. */
    risks: Array<{ consumerId: string; reasons: string[] }>;
  };
}

// ---- Confirm ------------------------------------------------------------------

export interface ReleaseRecord {
  id: string;
  releasedAt: string;
  producerHash: string;
  policy: UnknownPolicy;
  /** The exact producer definition the decision was taken against. */
  producer: unknown;
  producerLint: Issue[];
  /** Consumer pins + verdict snapshots captured at confirmation time. */
  consumers: Array<{
    consumerId: string;
    consumerName: string;
    required: boolean;
    revision: number;
    schemaHash: string;
    compatible: boolean;
    rejectionReasons: string[];
  }>;
  requiredConsumerIds: string[];
  gate: Preview['gate'];
  previewToken: string;
}

// ---- Error envelope -----------------------------------------------------------

export interface RevisionConflictBody {
  error: 'revision_conflict';
  current: ConsumerDetail;
}

/** Token exists but a pinned consumer moved (or it was already consumed). */
export interface StalePreviewBody {
  error: 'stale_preview';
  /** Fresh preview against the CURRENT roster and the SAME producer draft. */
  fresh: Preview;
  changed: Array<{ consumerId: string; fromRevision: number; toRevision: number }>;
}

export interface GateBlockedBody {
  error: 'gate_blocked';
  preview: Preview;
}
