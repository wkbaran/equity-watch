/**
 * A caught value as text.
 *
 * `catch (err)` types `err` as `unknown`, and dropping that straight into a
 * template prints "[object Object]" for anything thrown that isn't an Error —
 * which is the case where you most need to read what happened.
 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
