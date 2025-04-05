import { AppLogger } from "@quartz-labs/logger";
import { buildTransaction, MARKET_INDEX_SOL, type MarketIndex, QuartzClient, retryWithBackoff, TOKENS } from "@quartz-labs/sdk";
import { Connection, type Keypair, LAMPORTS_PER_SOL, PublicKey, type MessageCompiledInstruction, type VersionedTransactionResponse, SendTransactionError, type TransactionInstruction } from "@solana/web3.js";
import config from "./config/config.js";
import { MIN_LAMPORTS_BALANCE } from "./config/constants.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import { filterOrdersForMissed, hasAta } from "./utilts/helpers.js";

export class FillBot extends AppLogger {
    private connection: Connection;
    private quartzClientPromise: Promise<QuartzClient>;
    private wallet: Keypair;

    constructor() {
        super({
            name: "Fill Bot",
            dailyErrorCacheTimeMs: 1000 * 60 * 15 // 15 minutes
        })

        this.connection = new Connection(config.RPC_URL);
        this.quartzClientPromise = QuartzClient.fetchClient(this.connection);
        this.wallet = config.FILLER_KEYPAIR;
    }

    public async shutdown(): Promise<void> {
        await this.sendEmail(
            'URGENT: Graceful shutdown initiated',
            'Received shutdown signal. This can happen during a new deployment, or if a fatal error occured. Please check the deployment status is this was not manually triggered.'
        );
    }

    public async start(): Promise<void> {
        const balance = await this.connection.getBalance(this.wallet.publicKey);

        setInterval(() => {
            this.logger.info(`Heartbeat | Bot address: ${this.wallet.publicKey.toBase58()}`);
        }, 1000 * 60 * 60 * 24);

        await this.listenForOrder(
            "InitiateWithdraw",
            this.scheduleWithdraw
        );

        await this.listenForOrder(
            "InitiateSpendLimit",
            this.scheduleSpendLimit
        );
        
        this.logger.info("Fill Bot Initialized");
        this.logger.info(`Wallet Address: ${this.wallet.publicKey.toBase58()}`);
        this.logger.info(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
        
        this.checkOpenOrders(false);
        setInterval(this.checkOpenOrders, 1000 * 60);
    }

    private checkOpenOrders = async (onlyMissedOrders = true): Promise<void> => {
        const quartzClient = await this.quartzClientPromise;
        const currentSlot = await this.connection.getSlot();
        
        const withdrawOrders = onlyMissedOrders ? filterOrdersForMissed(
            await quartzClient.getOpenWithdrawOrders(),
            currentSlot
        ) : await quartzClient.getOpenWithdrawOrders();

        const spendLimitsOrders = onlyMissedOrders ? filterOrdersForMissed(
            await quartzClient.getOpenSpendLimitsOrders(),
            currentSlot
        ) : await quartzClient.getOpenSpendLimitsOrders();

        const orderCount = Object.keys(withdrawOrders).length + Object.keys(spendLimitsOrders).length;
        
        this.logger.info(`[${new Date().toISOString()}] Checking for ${onlyMissedOrders ? "missed" : "open"} orders... Found ${orderCount}`);
        if (orderCount <= 0) return;

        for (const [pubkey, _] of Object.entries(withdrawOrders)) {
            this.scheduleWithdraw(new PublicKey(pubkey));
        }

        for (const [pubkey, _] of Object.entries(spendLimitsOrders)) {
            this.scheduleSpendLimit(new PublicKey(pubkey));
        }
    }

    private listenForOrder = async (
        instructionName: string,
        scheduleOrderFill: (order: PublicKey) => Promise<void>
    ): Promise<void> => {
        const quartzClient = await this.quartzClientPromise;

        const ORDER_INDEX = 2;

        quartzClient.listenForInstruction(
            instructionName,
            async (_tx: VersionedTransactionResponse, ix: MessageCompiledInstruction, accountKeys: PublicKey[]) => {
                try {
                    const orderIndex = ix.accountKeyIndexes?.[ORDER_INDEX];
                    if (orderIndex === undefined || accountKeys[orderIndex] === undefined) throw new Error("Order index not found");
                    const order = accountKeys[orderIndex];

                    scheduleOrderFill(order);
                } catch (error) {
                    this.logger.error(`Error processing order instruction: ${error}`);
                }
            }
        )
    }

    private scheduleWithdraw = async (
        orderPubkey: PublicKey
    ): Promise<void> => {
        try {
            const quartzClient = await this.quartzClientPromise;
            this.logger.info(`Scheduling withdraw fill for order ${orderPubkey.toBase58()}`);

            const order = await quartzClient.parseOpenWithdrawOrder(orderPubkey);

            await this.waitForRelease(order.timeLock.releaseSlot.toNumber());

            const marketIndex = order.driftMarketIndex.toNumber() as MarketIndex;
            const doesAtaExist = await hasAta(
                this.connection, 
                order.timeLock.owner, 
                TOKENS[marketIndex].mint
            );
            if (marketIndex !== MARKET_INDEX_SOL && !doesAtaExist) {
                this.logger.info(`No ATA found for withdraw order, skipping... {account: ${orderPubkey.toBase58()}, owner: ${order.timeLock.owner.toBase58()}, marketIndex: ${marketIndex}}`);
                return;
            }
            
            const user = await quartzClient.getQuartzAccount(order.timeLock.owner);
            const ixData = await user.makeFulfilWithdrawIx(orderPubkey, this.wallet.publicKey);
            const signature = await this.buildSendAndConfirm(
                ixData.ixs,
                ixData.lookupTables,
                [this.wallet, ...ixData.signers]
            );

            this.logger.info(`Withdraw fill for order ${orderPubkey.toBase58()} confirmed: ${signature}`);
        } catch (error) {
            this.logger.error(`Error building transaction: ${error}`);
            return;
        }
    }

    private scheduleSpendLimit = async (
        orderPubkey: PublicKey
    ): Promise<void> => {
        try {
            const quartzClient = await this.quartzClientPromise;
            this.logger.info(`Scheduling spend limit fill for order ${orderPubkey.toBase58()}`);

            const order = await quartzClient.parseOpenSpendLimitsOrder(orderPubkey);
            await this.waitForRelease(order.timeLock.releaseSlot.toNumber());

            const user = await quartzClient.getQuartzAccount(order.timeLock.owner);
            const ixData = await user.makeFulfilSpendLimitsIx(orderPubkey, this.wallet.publicKey);
            const signature = await this.buildSendAndConfirm(
                ixData.ixs,
                ixData.lookupTables,
                [this.wallet, ...ixData.signers]
            );

            this.logger.info(`Spend limit fill for order ${orderPubkey.toBase58()} confirmed: ${signature}`);
        } catch (error) {
            this.logger.error(`Error building transaction: ${error}`);
            return;
        }
    }

    private waitForRelease = async (
        releaseSlot: number
    ): Promise<void> => {
        try {
            const currentSlot = await this.connection.getSlot();
            if (currentSlot < releaseSlot) {
                const msToRelease = (releaseSlot - currentSlot) * 400;
                await new Promise(resolve => setTimeout(resolve, msToRelease));
            }
        } catch (error) {
            this.logger.error(`Error waiting for release: ${error}`);
            throw error;
        }
    }

    private buildSendAndConfirm = async (
        instructions: TransactionInstruction[],
        lookupTables: AddressLookupTableAccount[],
        signers: Keypair[]
    ): Promise<string> => {
        try {
            const transaction = await buildTransaction(
                this.connection,
                instructions,
                this.wallet.publicKey,
                lookupTables
            );  
            transaction.sign(signers);

            return await retryWithBackoff(
                async () => {
                    const signature = await retryWithBackoff(
                        async () => await this.connection.sendTransaction(transaction),
                        3
                    );

                    await retryWithBackoff(
                        async () => {
                            const latestBlockhash = await this.connection.getLatestBlockhash();
                            const tx = await this.connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");

                            await this.checkRemainingBalance();

                            if (tx.value.err) throw new Error(`Tx passed preflight but failed on-chain: ${signature}`);
                        },
                        1
                    )

                    return signature;
                },
                0
            );
        } catch (error) {
            if (error instanceof SendTransactionError) {
                const logs = await error.getLogs(this.connection)
                    .catch(() => [error]);

                this.logger.error(`Error sending transaction: ${logs.join("\n")}`);
            }
            this.logger.error(`Error sending transaction: ${error}`);
            throw error;
        }
    }

    private checkRemainingBalance = async (): Promise<void> => {
        const remainingLamports = await this.connection.getBalance(this.wallet.publicKey);
        if (remainingLamports < MIN_LAMPORTS_BALANCE) {
            this.sendEmail(
                "FILL_BOT balance is low", 
                `Fill bot balance is ${remainingLamports}, please add more SOL to ${this.wallet.publicKey.toBase58()}`
            );
        }
    }
}