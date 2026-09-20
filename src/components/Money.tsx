export function Money({
  amount,
  currency = "GBP",
  muted,
}: {
  amount: number | null;
  currency?: string;
  muted?: boolean;
}) {
  if (amount === null) {
    return <span style={{ color: "var(--text-tertiary)" }}>—</span>;
  }
  const formatted = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);

  return (
    <span
      style={{
        color: muted ? "var(--text-tertiary)" : "var(--accent-gold)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {formatted}
    </span>
  );
}
