import { DEFAULT_COMPUTE_UNIT_LIMIT, getComputeUnitPriceIx, getTokenProgram, retryWithBackoff, type TimeLocked } from "@quartz-labs/sdk";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";

export const filterOrdersForMissed = (
    orders: {
        publicKey: PublicKey,
        account: TimeLocked
    }[], 
    currentSlot: number
): {
    publicKey: PublicKey,
    account: TimeLocked
}[] => {
    const oneMinuteAgo = currentSlot - (60 * 2.5);
    return orders.filter((order) => order.account.timeLock.releaseSlot.toNumber() < oneMinuteAgo);
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

export async function getComputeUnitLimitMinCu(
    connection: Connection,
    instructions: TransactionInstruction[],
    address: PublicKey,
    blockhash: string,
    lookupTables: AddressLookupTableAccount[] = []
) {
    const messageV0 = new TransactionMessage({
        payerKey: address,
        recentBlockhash: blockhash,
        instructions: [...instructions]
    }).compileToV0Message(lookupTables);
    const simulation = await connection.simulateTransaction(
        new VersionedTransaction(messageV0)
    );

    if (simulation.value.err || !simulation.value.unitsConsumed) {
        console.log("Could not simulate for CUs, using default limit");
        return DEFAULT_COMPUTE_UNIT_LIMIT;
    }

    if (simulation.value.unitsConsumed < DEFAULT_COMPUTE_UNIT_LIMIT) {
        return DEFAULT_COMPUTE_UNIT_LIMIT;
    }

    return Math.ceil(simulation.value.unitsConsumed * 1.5); // Add 50% buffer
}

export async function getComputerUnitLimitIxMinCu(
    connection: Connection,
    instructions: TransactionInstruction[],
    address: PublicKey,
    blockhash: string,
    lookupTables: AddressLookupTableAccount[] = []
) {
    const computeUnitLimit = await getComputeUnitLimitMinCu(connection, instructions, address, blockhash, lookupTables);
    return ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnitLimit,
    });
}

export async function buildTransactionMinCU(
    connection: Connection,
    instructions: TransactionInstruction[],
    payer: PublicKey,
    lookupTables: AddressLookupTableAccount[] = []
): Promise<VersionedTransaction> {
    const blockhash = (await connection.getLatestBlockhash()).blockhash;
    const ix_computeLimit = await getComputerUnitLimitIxMinCu(connection, instructions, payer, blockhash, lookupTables);
    const ix_computePrice = await getComputeUnitPriceIx(connection, instructions);

    const messageV0 = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: [
            ix_computeLimit,
            ix_computePrice,
            ...instructions
        ]
    }).compileToV0Message(lookupTables);
    const transaction = new VersionedTransaction(messageV0);
    return transaction;
}
