import { AppLogger } from "@quartz-labs/logger";
import { bs58, buildTransaction, QuartzClient, retryWithBackoff } from "@quartz-labs/sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, type PublicKey, type VersionedTransaction, type MessageCompiledInstruction, type VersionedTransactionResponse } from "@solana/web3.js";
import config from "./config/config.js";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { MIN_LAMPORTS_BALANCE, TIMELOCK_DURATION_MS } from "./config/constants.js";

export class FillBot extends AppLogger {
    private connection: Connection;
    private quartzClientPromise: Promise<QuartzClient>;
    private walletPromise: Promise<Keypair>;

    constructor() {
        super({
            name: "Fill Bot",
            dailyErrorCacheTimeMs: 1000 * 60 * 15 // 15 minutes
        })

        this.connection = new Connection(config.RPC_URL);
        this.quartzClientPromise = QuartzClient.fetchClient(this.connection);
        this.walletPromise = this.initWallet();
    }

    private async initWallet() {
        if (!config.USE_AWS) {
            if (!config.WALLET_KEYPAIR) throw new Error("Wallet keypair is not set");
            const bytes = bs58.decode(config.WALLET_KEYPAIR);
            return Keypair.fromSecretKey(bytes);
        }

        if (!config.AWS_REGION || !config.AWS_SECRET_NAME) throw new Error("AWS credentials are not set");

        const client = new SecretsManagerClient({ region: config.AWS_REGION });

        try {
            const response = await client.send(
                new GetSecretValueCommand({
                    SecretId: config.AWS_SECRET_NAME,
                    VersionStage: "AWSCURRENT",
                })
            );

            const secretString = response.SecretString;
            if (!secretString) throw new Error("Secret string is not set");

            const secret = JSON.parse(secretString).fillBotCredentials;
            if (!secret) throw new Error("fillBotCredentials not set");
;
            return Keypair.fromSecretKey(bs58.decode(secret));
        } catch (error) {
            throw new Error(`Failed to get secret key from AWS: ${error}`);
        }
    }

    public async shutdown() {
        await this.sendEmail(
            'URGENT: Graceful shutdown initiated',
            'Received shutdown signal. This can happen during a new deployment, or if a fatal error occured. Please check the deployment status is this was not manually triggered.'
        );
    }

    public async start() {
        const wallet = await this.walletPromise;

        const balance = await this.connection.getBalance(wallet.publicKey);

        setInterval(() => {
            this.logger.info(`Heartbeat | Bot address: ${wallet.publicKey.toBase58()}`);
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
        this.logger.info(`Wallet Address: ${wallet.publicKey.toBase58()}`);
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
        const wallet = await this.walletPromise;

        try {
            const user = await quartzClient.getQuartzAccount(owner);
            const {
                ixs,
                lookupTables,
                signers
            } = await user.makeFulfilWithdrawIx(order);

            const transaction = await buildTransaction(this.connection, ixs, wallet.publicKey, lookupTables);
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
        const wallet = await this.walletPromise;

        try {
            const user = await quartzClient.getQuartzAccount(owner);
            const {
                ixs,
                lookupTables,
                signers
            } = await user.makeFulfilSpendLimitsIx(order);

            const transaction = await buildTransaction(this.connection, ixs, wallet.publicKey, lookupTables);
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
        const wallet = await this.walletPromise;
        const remainingLamports = await this.connection.getBalance(wallet.publicKey);
        if (remainingLamports < MIN_LAMPORTS_BALANCE) {
            this.sendEmail(
                "FILL_BOT balance is low", 
                `Fill bot balance is ${remainingLamports}, please add more SOL to ${wallet.publicKey.toBase58()}`
            );
        }
    }
}