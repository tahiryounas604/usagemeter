export type PlanName = "free" | "starter" | "pro" | "enterprise";

export interface Plan {
  name: PlanName;
  monthlyQuota: number;
  /** USD charged per unit on this plan (for billing drafts). */
  pricePerUnitUsd: number;
}

export const PLANS: Record<PlanName, Plan> = {
  free: { name: "free", monthlyQuota: 1_000, pricePerUnitUsd: 0 },
  starter: { name: "starter", monthlyQuota: 10_000, pricePerUnitUsd: 0.002 },
  pro: { name: "pro", monthlyQuota: 100_000, pricePerUnitUsd: 0.001 },
  enterprise: { name: "enterprise", monthlyQuota: 1_000_000, pricePerUnitUsd: 0.0005 },
};

export function isPlanName(v: string): v is PlanName {
  return v === "free" || v === "starter" || v === "pro" || v === "enterprise";
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** First chars of the plaintext key, safe to display (never the secret). */
  keyPrefix: string;
  plan: PlanName;
  monthlyQuota: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedKey {
  record: ApiKeyRecord;
  /** Plaintext key — shown exactly once at creation, never stored. */
  apiKey: string;
}

export interface UsageEventInput {
  endpoint: string;
  units: number;
  timestamp?: string;
  idempotencyKey?: string | null;
}

export interface UsageEvent {
  id: string;
  apiKeyId: string;
  endpoint: string;
  units: number;
  timestamp: string;
  day: string;
  month: string;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface IngestResult {
  event: UsageEvent;
  duplicate: boolean;
}

export interface RollupRow {
  apiKeyId: string;
  endpoint: string;
  day: string;
  events: number;
  units: number;
}

export interface UsageSummary {
  apiKeyId: string;
  month: string;
  totalUnits: number;
  totalEvents: number;
  quota: number;
  remaining: number;
  byEndpoint: { endpoint: string; events: number; units: number }[];
  byDay: { day: string; events: number; units: number }[];
}

export interface QuotaCheck {
  allowed: boolean;
  apiKeyId: string;
  month: string;
  used: number;
  quota: number;
  remaining: number;
  requested: number;
}

export interface BillingLine {
  apiKeyId: string;
  keyName: string;
  keyPrefix: string;
  plan: PlanName;
  month: string;
  totalUnits: number;
  totalEvents: number;
  pricePerUnitUsd: number;
  amountUsd: number;
  /** Stripe invoice-item style description. */
  description: string;
}
