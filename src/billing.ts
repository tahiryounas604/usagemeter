import type { BillingLine } from "./types.ts";

/** Stripe-ready invoice draft (JSON shape mirrors Stripe invoice items). */
export interface InvoiceDraft {
  currency: "usd";
  month: string;
  totalAmountUsd: number;
  lines: {
    customerRef: string;
    description: string;
    quantity: number;
    unitAmountUsd: number;
    amountUsd: number;
    metadata: { apiKeyId: string; keyPrefix: string; plan: string; month: string };
  }[];
}

export function toInvoiceDraft(lines: BillingLine[], month: string): InvoiceDraft {
  const billed = lines.filter((l) => l.totalUnits > 0);
  return {
    currency: "usd",
    month,
    totalAmountUsd: Math.round(billed.reduce((s, l) => s + l.amountUsd, 0) * 100) / 100,
    lines: billed.map((l) => ({
      customerRef: l.keyName,
      description: l.description,
      quantity: l.totalUnits,
      unitAmountUsd: l.pricePerUnitUsd,
      amountUsd: l.amountUsd,
      metadata: { apiKeyId: l.apiKeyId, keyPrefix: l.keyPrefix, plan: l.plan, month: l.month },
    })),
  };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(lines: BillingLine[]): string {
  const header = "api_key_id,key_name,key_prefix,plan,month,total_units,total_events,price_per_unit_usd,amount_usd,description";
  const rows = lines.map((l) => [
    l.apiKeyId, l.keyName, l.keyPrefix, l.plan, l.month, l.totalUnits, l.totalEvents,
    l.pricePerUnitUsd, l.amountUsd.toFixed(2), l.description,
  ].map(csvCell).join(","));
  return [header, ...rows].join("\n") + "\n";
}
