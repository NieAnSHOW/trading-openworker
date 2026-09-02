// Join class names, dropping falsy entries. The upstream pages used clsx +
// tailwind-merge; this app needs neither — the ported components only use
// conditional suffixes, which plain filtering covers.
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(" ");
}
