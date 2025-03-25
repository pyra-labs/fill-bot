import { getComputerUnitLimitIx, getComputeUnitPriceIx } from "@quartz-labs/sdk";
import { TransactionMessage, type PublicKey } from "@solana/web3.js";
import { VersionedTransaction } from "@solana/web3.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import type { TransactionInstruction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";

export async function buildTransaction(
    connection: Connection,
    instructions: TransactionInstruction[], 
    payer: PublicKey,
    lookupTables: AddressLookupTableAccount[] = []
): Promise<VersionedTransaction> {
    const blockhash = (await connection.getLatestBlockhash()).blockhash;
    const ix_computeLimit = await getComputerUnitLimitIx(connection, instructions, payer, blockhash, lookupTables);
    const ix_computePrice = await getComputeUnitPriceIx(connection, instructions);
    instructions.unshift(ix_computeLimit, ix_computePrice);

    const messageV0 = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: instructions
    }).compileToV0Message(lookupTables);
    const transaction = new VersionedTransaction(messageV0);
    return transaction;
}