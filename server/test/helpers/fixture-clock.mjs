// Events accepted through the API expire `raw_retention_days` (default 30) after captured_at,
// and expired events are excluded from Checkpoints and memory extraction. Hard-coded capture
// dates therefore start failing once they age past the window. This maps fixture timestamps
// onto the recent past while preserving their order and spacing.
export function fixtureClock(anchorIso, { ageMs = 60 * 60 * 1000 } = {}) {
  const minute = 60 * 1000;
  const shift = Math.floor((Date.now() - ageMs - Date.parse(anchorIso)) / minute) * minute;
  return (iso) => new Date(Date.parse(iso) + shift).toISOString();
}
