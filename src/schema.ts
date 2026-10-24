import { z } from "zod";

export const nonEmpty = z.string().trim().min(1);
export const amount = z.number().finite().nonnegative();

// Addresses are opaque strings (wallet, IBAN, account number): no format checks here.
export const RecipientBody = z.object({
  address: nonEmpty, label: nonEmpty, category: nonEmpty, rail: nonEmpty.optional(),
});

// What a new mandate must look like, from the REST API or a drafted one.
export const NewMandateBody = z.object({
  name: nonEmpty,
  task: nonEmpty,
  currency: nonEmpty,
  autoApproveMax: amount,
  hardMax: amount,
  monthlyCap: amount,
  allowlist: z.array(RecipientBody),
  expiresAt: z.string().nullable(),
});
