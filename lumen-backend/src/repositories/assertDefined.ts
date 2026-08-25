/**
 * A successful `.insert(...).returning()` always yields at least one row for a single-row
 * insert; TypeScript's noUncheckedIndexedAccess can't know that statically. This turns the
 * (never-expected-in-practice) undefined case into a loud failure instead of letting every
 * caller carry an unnecessary `| undefined` through the domain.
 */
export function assertDefined<T>(value: T | undefined, context: string): T {
  if (value === undefined) {
    throw new Error(`Expected a row after insert, got none: ${context}`);
  }
  return value;
}
