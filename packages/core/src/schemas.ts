import { z } from 'zod';

export const MarginSchema = z.number().int().min(0).max(1_000_000);

export const OverlayPositionSchema = z.enum(['top_left', 'top_right', 'bottom_left', 'bottom_right']);
export type OverlayPosition = z.infer<typeof OverlayPositionSchema>;

export const WhatsAppSessionSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const SupplierProfileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  sourceGroupId: z.string().min(1).max(128),
  priceMarginCop: MarginSchema.optional(),
  boxMarginCop: MarginSchema.optional(),
  // Accept the previous local API shape during upgrades; new clients send both explicit margins.
  marginCop: MarginSchema.optional(),
  markerText: z.string().trim().min(1).max(32)
    .refine((value) => /[🌎🌍🌏🌐]/u.test(value), 'La marca debe incluir un emoji de mundo.')
    .refine((value) => /^[\s.\-🌎🌍🌏🌐⭐\uFE0F]+$/u.test(value), 'Usa un mundo, una estrella, espacios, punto o guion.'),
  defaultPosition: OverlayPositionSchema,
}).transform(({ marginCop, priceMarginCop, boxMarginCop, ...profile }) => ({
  ...profile,
  priceMarginCop: priceMarginCop ?? marginCop ?? 10000,
  boxMarginCop: boxMarginCop ?? 5000,
}));

export const ProductImageOptionsSchema = z.object({
  shoeCode: z.string().trim().max(32).regex(/^[\p{L}\p{N}-]*$/u).nullable(),
  position: OverlayPositionSchema,
});

export const TargetGroupSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(80),
});

export const SettingsSchema = z.object({
  // Legacy global default remains constrained by the original settings table; provider profiles use MarginSchema and accept zero.
  marginCop: z.union([z.literal(5000), z.literal(10000)]).default(10000),
  targetGroups: z.array(TargetGroupSchema).max(5).default([]),
});

export const ProductUploadSchema = z.object({
  rawText: z.string().trim().min(1).max(10000),
  title: z.string().trim().max(160).transform((value) => value || undefined).optional(),
});

export const ApprovalSchema = z.object({
  sourcePriceCop: z.number().int().positive().max(1000000).optional(),
  sourcePricesCop: z.array(z.number().int().positive().max(1000000)).min(1).max(20).optional(),
  outputText: z.string().trim().min(1).max(12000),
}).superRefine((approval, context) => {
  if (approval.sourcePriceCop === undefined && approval.sourcePricesCop === undefined) {
    context.addIssue({ code: 'custom', path: ['sourcePricesCop'], message: 'Indica el precio original o la lista de precios originales.' });
  }
});

export const WhatsAppGroupSelectionSchema = z.object({
  sourceGroupId: z.string().min(1).max(128).nullable(),
  targetGroupIds: z.array(z.string().min(1).max(128)).max(5),
}).superRefine((selection, context) => {
  if (new Set(selection.targetGroupIds).size !== selection.targetGroupIds.length) {
    context.addIssue({ code: 'custom', path: ['targetGroupIds'], message: 'Los grupos de destino deben ser distintos.' });
  }
  if (selection.sourceGroupId && selection.targetGroupIds.includes(selection.sourceGroupId)) {
    context.addIssue({ code: 'custom', path: ['targetGroupIds'], message: 'El grupo proveedor no puede ser un destino.' });
  }
});

export type WhatsAppGroupSelection = z.infer<typeof WhatsAppGroupSelectionSchema>;

export type Settings = z.infer<typeof SettingsSchema>;
export type TargetGroup = z.infer<typeof TargetGroupSchema>;
