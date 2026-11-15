/**
 * Types for `muxpad pay` (scripts/browser-pay.mjs).
 *
 * The script is plain JavaScript because it runs as a CLI with no build step.
 * This file exists so the tests can import it under `strict` rather than
 * reaching for `any`, and it doubles as the statement of what the script's
 * public surface IS — everything not listed here is internal.
 */

/** One card field, and every way a checkout might name it. */
export interface PayField {
  key: 'num' | 'exp' | 'cvc' | 'name' | 'zip' | 'expMonth' | 'expYear';
  /** Tried in order, in every frame. The autocomplete attribute leads. */
  selectors: string[];
}

export interface PayArgs {
  error?: string;
  help?: boolean;
  verb?: 'checkout' | 'fill' | 'submit' | 'show' | null;
  url?: string | null;
  shot?: string | null;
  selector?: string | null;
  timeoutMs?: number;
}

export declare const FIELDS: PayField[];
/** How the pay button is found when you have not named one — by its words. */
export declare const SUBMIT_SELECTORS: string[];
/** This chat's own session browser. Null outside a pane. */
export declare function cdpUrl(env: Record<string, string | undefined>): string | null;
export declare function parseArgs(argv: string[]): PayArgs;
/** The stored card. Throws when the file is missing or incomplete. */
export declare function readCard(path?: string): {
  num: string;
  exp: string;
  cvc: string;
  name?: string;
  zip?: string;
};

/** The month/year pair, tried only when the combined MM/YY box is absent. */
export declare const EXP_PARTS: PayField[];
/** `07/31` → every spelling a control might want. Null if it is not a date. */
export declare function splitExp(
  exp: string | undefined | null,
): { month: string; monthShort: string; year4: string; year2: string } | null;
/** Is the cardholder name obviously not a name? Empty counts. */
export declare function looksPlaceholder(name: string | undefined | null): boolean;
/** Did a field keep only the front of what was typed? Digits only; a prefix. */
export declare function keptOnlyPart(want: string, got: string | null | undefined): boolean;
/** Is this button another payment rail (PayPal, Apple Pay, Klarna…)? */
export declare function isWalletButton(text: string | null | undefined): boolean;
