export interface SequentialDiscountInput {
  subtotal: number;
  doctorLessPercent?: number | null;
  flatDiscountAmount?: number | null;
  legacyDiscountType?: 'percent' | 'flat';
  legacyDiscountValue?: number | null;
}

export interface SequentialDiscountResult {
  subtotal: number;
  doctorLessPercent: number;
  doctorLessAmount: number;
  afterDoctorLess: number;
  flatDiscountAmount: number;
  discountAmount: number;
  discountPct: number;
  netBeforeAdjustment: number;
  legacyDiscountType: 'percent' | 'flat';
  legacyDiscountValue: number;
}

export function roundDiscountCurrency(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export function computeSequentialDiscounts(input: SequentialDiscountInput): SequentialDiscountResult {
  const subtotal = Math.max(0, roundDiscountCurrency(Number(input.subtotal || 0)));

  const hasSplitFields =
    (input.doctorLessPercent !== undefined && input.doctorLessPercent !== null) ||
    (input.flatDiscountAmount !== undefined && input.flatDiscountAmount !== null);

  let doctorLessPercent = 0;
  let doctorLessAmount = 0;
  let afterDoctorLess = subtotal;
  let flatDiscountAmount = 0;

  if (hasSplitFields) {
    const rawPct = Number(input.doctorLessPercent ?? 0);
    doctorLessPercent = Number.isFinite(rawPct)
      ? Math.min(100, Math.max(0, roundDiscountCurrency(rawPct)))
      : 0;
    doctorLessAmount = Math.min(
      subtotal,
      Math.max(0, roundDiscountCurrency((subtotal * doctorLessPercent) / 100))
    );
    afterDoctorLess = Math.max(0, roundDiscountCurrency(subtotal - doctorLessAmount));

    const rawFlat = Number(input.flatDiscountAmount ?? 0);
    const sanitizedFlat = Number.isFinite(rawFlat) ? Math.max(0, roundDiscountCurrency(rawFlat)) : 0;
    flatDiscountAmount = Math.min(afterDoctorLess, sanitizedFlat);
  } else if (input.legacyDiscountType === 'percent') {
    const rawPct = Number(input.legacyDiscountValue ?? 0);
    doctorLessPercent = Number.isFinite(rawPct)
      ? Math.min(100, Math.max(0, roundDiscountCurrency(rawPct)))
      : 0;
    doctorLessAmount = Math.min(
      subtotal,
      Math.max(0, roundDiscountCurrency((subtotal * doctorLessPercent) / 100))
    );
    afterDoctorLess = Math.max(0, roundDiscountCurrency(subtotal - doctorLessAmount));
    flatDiscountAmount = 0;
  } else {
    const rawFlat = Number(input.legacyDiscountValue ?? 0);
    const sanitizedFlat = Number.isFinite(rawFlat) ? Math.max(0, roundDiscountCurrency(rawFlat)) : 0;
    doctorLessPercent = 0;
    doctorLessAmount = 0;
    afterDoctorLess = subtotal;
    flatDiscountAmount = Math.min(subtotal, sanitizedFlat);
  }

  const discountAmount = Math.min(subtotal, roundDiscountCurrency(doctorLessAmount + flatDiscountAmount));
  const discountPct = subtotal > 0 ? roundDiscountCurrency((discountAmount / subtotal) * 100) : 0;
  const netBeforeAdjustment = Math.max(
    0,
    roundDiscountCurrency(subtotal - doctorLessAmount - flatDiscountAmount)
  );

  const legacyDiscountType: 'percent' | 'flat' =
    doctorLessPercent > 0 && flatDiscountAmount <= 0 ? 'percent' : 'flat';
  const legacyDiscountValue =
    legacyDiscountType === 'percent' ? doctorLessPercent : discountAmount;

  return {
    subtotal,
    doctorLessPercent,
    doctorLessAmount,
    afterDoctorLess,
    flatDiscountAmount,
    discountAmount,
    discountPct,
    netBeforeAdjustment,
    legacyDiscountType,
    legacyDiscountValue,
  };
}

export interface StoredInvoiceDiscountLike {
  subtotal?: number;
  discount_type?: 'percent' | 'flat' | string;
  discount_value?: number;
  discount_amount?: number;
  doctor_less_percent?: number | null;
  doctor_less_amount?: number | null;
  flat_discount_amount?: number | null;
}

export function resolveInvoiceDiscountBreakdown(inv: StoredInvoiceDiscountLike | null | undefined): {
  doctorLessPercent: number;
  doctorLessAmount: number;
  flatDiscountAmount: number;
} {
  if (!inv) {
    return { doctorLessPercent: 0, doctorLessAmount: 0, flatDiscountAmount: 0 };
  }

  const hasExplicit =
    (inv.doctor_less_percent !== undefined && inv.doctor_less_percent !== null) ||
    (inv.doctor_less_amount !== undefined && inv.doctor_less_amount !== null) ||
    (inv.flat_discount_amount !== undefined && inv.flat_discount_amount !== null);

  if (hasExplicit) {
    const subtotal = Math.max(0, roundDiscountCurrency(Number(inv.subtotal || 0)));
    const doctorLessPercent = Math.min(
      100,
      Math.max(0, roundDiscountCurrency(Number(inv.doctor_less_percent || 0)))
    );
    const doctorLessAmount =
      inv.doctor_less_amount !== undefined && inv.doctor_less_amount !== null
        ? Math.min(subtotal, Math.max(0, roundDiscountCurrency(Number(inv.doctor_less_amount || 0))))
        : Math.min(subtotal, Math.max(0, roundDiscountCurrency((subtotal * doctorLessPercent) / 100)));
    const afterDoctorLess = Math.max(0, roundDiscountCurrency(subtotal - doctorLessAmount));
    const flatDiscountAmount = Math.min(
      afterDoctorLess,
      Math.max(0, roundDiscountCurrency(Number(inv.flat_discount_amount || 0)))
    );

    // Handle pre-backfill SQLite rows where DEFAULT 0 columns exist while legacy discount_amount > 0
    const legacyTotal = Math.max(0, roundDiscountCurrency(Number(inv.discount_amount || 0)));
    if (doctorLessPercent === 0 && doctorLessAmount === 0 && flatDiscountAmount === 0 && legacyTotal > 0) {
      if (inv.discount_type === 'percent') {
        const pct = Math.min(100, Math.max(0, roundDiscountCurrency(Number(inv.discount_value || 0))));
        return {
          doctorLessPercent: pct,
          doctorLessAmount: Math.min(subtotal, roundDiscountCurrency((subtotal * pct) / 100)),
          flatDiscountAmount: 0,
        };
      }
      return {
        doctorLessPercent: 0,
        doctorLessAmount: 0,
        flatDiscountAmount: Math.min(subtotal, legacyTotal),
      };
    }

    return { doctorLessPercent, doctorLessAmount, flatDiscountAmount };
  }

  const subtotal = Math.max(0, roundDiscountCurrency(Number(inv.subtotal || 0)));
  if (inv.discount_type === 'percent') {
    const doctorLessPercent = Math.min(
      100,
      Math.max(0, roundDiscountCurrency(Number(inv.discount_value || 0)))
    );
    const doctorLessAmount = Math.min(
      subtotal,
      Math.max(0, roundDiscountCurrency((subtotal * doctorLessPercent) / 100))
    );
    return {
      doctorLessPercent,
      doctorLessAmount,
      flatDiscountAmount: 0,
    };
  }

  return {
    doctorLessPercent: 0,
    doctorLessAmount: 0,
    flatDiscountAmount: Math.min(
      subtotal,
      Math.max(0, roundDiscountCurrency(Number(inv.discount_amount ?? inv.discount_value ?? 0)))
    ),
  };
}
