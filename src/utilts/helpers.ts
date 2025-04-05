import { getTokenProgram, retryWithBackoff, type TimeLocked } from "@quartz-labs/sdk";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import type { Connection, PublicKey } from "@solana/web3.js";

export const filterOrdersForMissed = (
    orders: Record<string, TimeLocked>, 
    currentSlot: number
): Record<string, TimeLocked> => {
    const oneMinuteAgo = currentSlot - (60 * 2.5);
    return Object.fromEntries(
        Object.entries(orders).filter(([_, order]) => (
            order.timeLock.releaseSlot.toNumber() < oneMinuteAgo
        ))
    );
}

export const hasAta = async (
    connection: Connection,
    owner: PublicKey,
    mint: PublicKey
) => {
    const mintTokenProgram = await getTokenProgram(connection, mint);
    const ata = await getAssociatedTokenAddress(mint, owner, true, mintTokenProgram);
    const ataInfo = await retryWithBackoff(
        () => connection.getAccountInfo(ata)
    );
    return ataInfo !== null;
}
