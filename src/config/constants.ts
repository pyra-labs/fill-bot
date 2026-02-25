import { LAMPORTS_PER_SOL } from "@solana/web3.js";

export const MIN_LAMPORTS_BALANCE = 0.3 * LAMPORTS_PER_SOL;
/** Minimum lamports for rent exemption on a 0-byte account */
export const LAMPORTS_RENT = 890880;
