import { AppLogger } from "@quartz-labs/logger";
import { buildTransaction, QuartzClient, retryWithBackoff } from "@quartz-labs/sdk";
import { Connection, type Keypair, LAMPORTS_PER_SOL, type PublicKey, type VersionedTransaction, type MessageCompiledInstruction, type VersionedTransactionResponse } from "@solana/web3.js";
import config from "./config/config.js";
import { MIN_LAMPORTS_BALANCE, TIMELOCK_DURATION_MS } from "./config/constants.js";

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

    public async shutdown() {
        await this.sendEmail(
            'URGENT: Graceful shutdown initiated',
            'Received shutdown signal. This can happen during a new deployment, or if a fatal error occured. Please check the deployment status is this was not manually triggered.'
        );
    }

    public async start() {
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
        this.logger.info(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);
    }

    private async listenForOrder(
        instructionName: string,
        scheduleFill: (owner: PublicKey, order: PublicKey) => Promise<void>
    ) {
        const quartzClient = await this.quartzClientPromise;

        const OWNER_INDEX = 1;
        const ORDER_INDEX = 2;

        quartzClient.listenForInstruction(
            instructionName,
            async (_tx: VersionedTransactionResponse, ix: MessageCompiledInstruction, accountKeys: PublicKey[]) => {
                try {
                    const ownerIndex = ix.accountKeyIndexes?.[OWNER_INDEX];
                    if (ownerIndex === undefined || accountKeys[ownerIndex] === undefined) throw new Error("Owner index not found");
                    const owner = accountKeys[ownerIndex];

                    const orderIndex = ix.accountKeyIndexes?.[ORDER_INDEX];
                    if (orderIndex === undefined || accountKeys[orderIndex] === undefined) throw new Error("Order index not found");
                    const order = accountKeys[orderIndex];

                    scheduleFill(owner, order);
                } catch (error) {
                    this.logger.error(`Error processing order instruction: ${error}`);
                }
            }
        )
    }

    private async scheduleWithdraw(
        owner: PublicKey,
        order: PublicKey
    ) {
        const quartzClient = await this.quartzClientPromise;

        try {
            const user = await quartzClient.getQuartzAccount(owner);
            const {
                ixs,
                lookupTables,
                signers
            } = await user.makeFulfilWithdrawIx(order);

            const transaction = await buildTransaction(this.connection, ixs, this.wallet.publicKey, lookupTables);
            transaction.sign(signers);
            
            this.scheduleFill(transaction);
        } catch (error) {
            this.logger.error(`Error building transaction: ${error}`);
            return;
        }
    }

    private async scheduleSpendLimit(
        owner: PublicKey,
        order: PublicKey
    ) {
        const quartzClient = await this.quartzClientPromise;

        try {
            const user = await quartzClient.getQuartzAccount(owner);
            const {
                ixs,
                lookupTables,
                signers
            } = await user.makeFulfilSpendLimitsIx(order);

            const transaction = await buildTransaction(this.connection, ixs, this.wallet.publicKey, lookupTables);
            transaction.sign(signers);
            
            this.scheduleFill(transaction);
        } catch (error) {
            this.logger.error(`Error building transaction: ${error}`);
            return;
        }
    }

    private async scheduleFill(
        transaction: VersionedTransaction
    ) {
        await new Promise(resolve => setTimeout(resolve, TIMELOCK_DURATION_MS));
        
        try {
            const signature = await retryWithBackoff(
                async () => {
                    const signature = await retryWithBackoff(
                        async () => this.connection.sendTransaction(transaction),
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
                }
            );

            this.logger.info(`Filled order: ${signature}`);
        } catch (error) {
            this.logger.error(`Error sending transaction: ${error}`);
        }
    }

    private async checkRemainingBalance(): Promise<void> {
        const remainingLamports = await this.connection.getBalance(this.wallet.publicKey);
        if (remainingLamports < MIN_LAMPORTS_BALANCE) {
            this.sendEmail(
                "FILL_BOT balance is low", 
                `Fill bot balance is ${remainingLamports}, please add more SOL to ${this.wallet.publicKey.toBase58()}`
            );
        }
    }
}