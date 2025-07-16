import { AppLogger } from "@quartz-labs/logger";
import { type BN, MARKET_INDEX_SOL, MarketIndex, QuartzClient, type QuartzUser, retryWithBackoff, type SpendLimitsOrder, TOKENS, type WithdrawOrder, ZERO } from "@quartz-labs/sdk";
import { type Keypair, LAMPORTS_PER_SOL, type PublicKey, type MessageCompiledInstruction, type VersionedTransactionResponse, type TransactionInstruction, SendTransactionError } from "@solana/web3.js";
import config from "./config/config.js";
import { MIN_LAMPORTS_BALANCE } from "./config/constants.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import { buildTransactionMinCU, filterOrdersForMissed, hasAta } from "./utilts/helpers.js";
import AdvancedConnection from "@quartz-labs/connection";

export class FillBot extends AppLogger {
    private connection: AdvancedConnection;
    private quartzClientPromise: Promise<QuartzClient>;
    private wallet: Keypair;

    constructor() {
        super({
            name: "Fill Bot",
            dailyErrorCacheTimeMs: 1000 * 60 * 15 // 15 minutes
        })

        this.connection = new AdvancedConnection(config.RPC_URLS);
        this.quartzClientPromise = QuartzClient.fetchClient({
            connection: this.connection
        });
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
        setInterval(this.checkOpenOrders, 1000 * 60); // 1 minute

        this.processDepositAddresses();
        setInterval(this.processDepositAddresses, 1000 * 60 * 3); // 3 minutes
    }

    private processDepositAddresses = async (): Promise<void> => {
        try {
            const quartzClient = await this.quartzClientPromise;
            const owners = await retryWithBackoff(
                async () => await quartzClient.getAllQuartzAccountOwnerPubkeys()
            );
            const users = await retryWithBackoff(
                async () => {
                    const users = await quartzClient.getMultipleQuartzAccounts(owners);
                    return users
                        .filter(user => user !== null); // Skip users without a Drift account
                }
            );

            this.logger.info(`Processing deposit addresses for ${users.length} users`);

            for (const user of users) {
                if (await this.checkRequiresUpgrade(this.connection, user)) { 
                    continue; // TODO: Remove once all users are upgraded
                }

                const depositAddressBalances = await user.getAllDepositAddressBalances();
                for (const marketIndex of MarketIndex) {
                    const balance: BN = depositAddressBalances[marketIndex];
                    if (balance.lte(ZERO)) {
                        continue;
                    }

                    this.fulfilDeposit(user, marketIndex);
                }
            }
        } catch (error) {
            this.logger.error(`Error processing deposit addresses: ${error} - ${JSON.stringify(error)}`);
        }
    }

    private fulfilDeposit = async (
        user: QuartzUser, 
        marketIndex: MarketIndex
    ): Promise<void> => {
        try {
            const {
                ixs,
                lookupTables,
                signers
            } = await user.makeFulfilDepositIxs(marketIndex, this.wallet.publicKey);
            const signature = await this.buildSendAndConfirm(
                ixs,
                lookupTables,
                [this.wallet, ...signers]
            );

            this.logger.info(`Deposit filled for user ${user.pubkey.toBase58()} (market index ${marketIndex}) confirmed: ${signature}`);
        } catch (error) {
            this.logger.error(`Error fulfilling deposit for user ${user.pubkey.toBase58()} (market index ${marketIndex}): ${error} - ${JSON.stringify(error)}`);
        }
    }

    private checkOpenOrders = async (onlyMissedOrders = true): Promise<void> => {
        try {
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

            for (const [, order] of Object.entries(withdrawOrders)) {
                this.scheduleWithdraw(order.publicKey);
            }

            for (const [, order] of Object.entries(spendLimitsOrders)) {
                this.scheduleSpendLimit(order.publicKey);
            }
        } catch (error) {
            this.logger.error(`Error checking open orders: ${error} - ${JSON.stringify(error)}`);
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
        const quartzClient = await this.quartzClientPromise;
        let order: WithdrawOrder;

        try {
            this.logger.info(`Scheduling withdraw fill for order ${orderPubkey.toBase58()}`);

            order = await quartzClient.parseOpenWithdrawOrder(orderPubkey, 10);

            await this.waitForRelease(order.timeLock.releaseSlot.toNumber());
        } catch (error) {
            this.logger.error(`Error waiting for release for order ${orderPubkey.toBase58()}: ${error}`);
            return;
        }

        try {
            const marketIndex = order.driftMarketIndex.toNumber() as MarketIndex;
            const doesAtaExist = await hasAta(
                this.connection, 
                order.destination, 
                TOKENS[marketIndex].mint
            );
            if (marketIndex !== MARKET_INDEX_SOL && !doesAtaExist) {
                this.logger.info(`No ATA found for withdraw order, skipping... {account: ${orderPubkey.toBase58()}, owner: ${order.timeLock.owner.toBase58()}, marketIndex: ${marketIndex}}`);
                return;
            }
            
            const user = await quartzClient.getQuartzAccount(order.timeLock.owner);
            const ixData = await user.makeFulfilWithdrawIxs(orderPubkey, this.wallet.publicKey);
            const signature = await this.buildSendAndConfirm(
                ixData.ixs,
                ixData.lookupTables,
                [this.wallet, ...ixData.signers]
            );

            if (signature) {
                this.logger.info(`Withdraw fill for order ${orderPubkey.toBase58()} confirmed: ${signature}`);
            }
        } catch (error) {
            if (error instanceof SendTransactionError) {
                const logs = await error.getLogs(this.connection)
                    .catch(() => [error]);

                const logsString = logs.join("\n");
                const INSUFFICIENT_COLLATERAL_ERROR = "Program log: Error Insufficient collateral thrown at programs/drift/src/state/user.rs:596\nProgram log: User attempting to withdraw where total_collateral";

                if (logsString.includes(INSUFFICIENT_COLLATERAL_ERROR)) {
                    this.logger.info(`Insufficient collateral error for order ${orderPubkey.toBase58()}, skipping...`);
                    return;
                }

                this.logger.error(`Error sending transaction for order ${orderPubkey.toBase58()}: ${logs.join("\n")}`);
                return;
            }
            this.logger.error(`Error sending transaction for order ${orderPubkey.toBase58()}: ${JSON.stringify(error)}`);
            return;
        }
    }

    private scheduleSpendLimit = async (
        orderPubkey: PublicKey
    ): Promise<void> => {
        const quartzClient = await this.quartzClientPromise;
        let order: SpendLimitsOrder;

        try {
            this.logger.info(`Scheduling spend limit fill for order ${orderPubkey.toBase58()}`);

            order = await quartzClient.parseOpenSpendLimitsOrder(orderPubkey, 10);
            await this.waitForRelease(order.timeLock.releaseSlot.toNumber());
        } catch (error) {
            this.logger.error(`Error waiting for release for order ${orderPubkey.toBase58()}: ${error}`);
            return;
        }

        try {
            const user = await quartzClient.getQuartzAccount(order.timeLock.owner);
            const ixData = await user.makeFulfilSpendLimitsIxs(orderPubkey, this.wallet.publicKey);
            const signature = await this.buildSendAndConfirm(
                ixData.ixs,
                ixData.lookupTables,
                [this.wallet, ...ixData.signers]
            );

            if (signature) {
                this.logger.info(`Spend limit fill for order ${orderPubkey.toBase58()} confirmed: ${signature}`);
            }
        } catch (error) {
            if (error instanceof SendTransactionError) {
                const logs = await error.getLogs(this.connection)
                    .catch(() => [error]);

                this.logger.error(`Error sending transaction for order ${orderPubkey.toBase58()}: ${logs.join("\n")}`);
                return;
            }
            this.logger.error(`Error sending transaction for order ${orderPubkey.toBase58()}: ${JSON.stringify(error)}`);
            return;
        }
    }

    private waitForRelease = async (
        releaseSlot: number
    ): Promise<void> => {
        try {
            const currentSlot = await this.connection.getSlot();
            if (currentSlot <= releaseSlot) {
                const msToRelease = (releaseSlot - currentSlot + 1) * 400; // Add one to land after the release slot
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
        signers: Keypair[],
        orderAccount?: PublicKey
    ): Promise<string | null> => {
        return await retryWithBackoff(
            async () => {
                if (orderAccount) {
                    const accountInfo = await this.connection.getAccountInfo(orderAccount);
                    if (!accountInfo) {
                        this.logger.info(`Order ${orderAccount.toBase58()} no longer exists on chain, skipping...`);
                        return null;
                    }
                }

                const transaction = await buildTransactionMinCU(
                    this.connection,
                    instructions,
                    this.wallet.publicKey,
                    lookupTables
                );  
                transaction.sign(signers);

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
            3
        );
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

    private async checkRequiresUpgrade(user: QuartzUser): Promise<boolean> {
        const vaultPdaAccount = await this.connection.getAccountInfo(user.vaultPubkey);
        if (vaultPdaAccount === null) return true;
    
        const OLD_VAULT_SIZE = 41;
        return (vaultPdaAccount.data.length <= OLD_VAULT_SIZE);
    }
}