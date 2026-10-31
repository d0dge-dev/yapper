import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// Same as T3 Code's apps/web/src/lib/utils.ts: register the extra font sizes so
// tailwind-merge does not read text-2xs as a colour.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["2xs", "3xs", "4xs", "5xs"] } } });

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
