import { AppLogger } from "@quartz-labs/logger";
import {
	BN,
	getMarketIndicesRecord,
	isMarketIndex,
	MARKET_INDEX_SOL,
	MarketIndex,
	QuartzClient,
	type QuartzUser,
	retryWithBackoff,
	type SpendLimitsOrder,
	type SpendLimitsOrderAccount,
	TOKENS,
	type WithdrawOrder,
	type WithdrawOrderAccount,
	ZERO,
} from "@quartz-labs/sdk";
import {
	type Keypair,
	LAMPORTS_PER_SOL,
	type MessageCompiledInstruction,
	PublicKey,
	type VersionedTransactionResponse,
	type TransactionInstruction,
	SendTransactionError,
} from "@solana/web3.js";
import config from "./config/config.js";
import { MIN_LAMPORTS_BALANCE } from "./config/constants.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import {
	buildEndpointURL,
	buildTransactionMinCU,
	fetchAndParse,
	filterOrdersForMissed,
	hasAta,
} from "./utilts/helpers.js";
import AdvancedConnection from "@quartz-labs/connection";
import type {
	SpendLimitsOrderResponse,
	WithdrawOrderResponse,
} from "./types/Orders.interface.js";
import type { VaultResponse } from "./types/Vault.interface.js";

export class FillBot extends AppLogger {
	private connection: AdvancedConnection;
	private quartzClientPromise: Promise<QuartzClient>;
	private wallet: Keypair;

	constructor() {
		super({
			name: "Fill Bot",
			dailyErrorCacheTimeMs: 1000 * 60 * 15, // 15 minutes
		});

		this.connection = new AdvancedConnection(config.RPC_URLS);
		this.quartzClientPromise = QuartzClient.fetchClient({
			connection: this.connection,
		});
		this.wallet = config.FILLER_KEYPAIR;
	}

	public async start(): Promise<void> {
		const balance = await this.connection.getBalance(this.wallet.publicKey);

		setInterval(
			() => {
				this.logger.info(
					`Heartbeat | Bot address: ${this.wallet.publicKey.toBase58()}`,
				);
			},
			1000 * 60 * 60 * 24,
		);

		await this.listenForOrder("InitiateWithdraw", this.scheduleWithdraw);

		await this.listenForOrder("InitiateSpendLimit", this.scheduleSpendLimit);

		this.logger.info("Fill Bot Initialized");
		this.logger.info(`Wallet Address: ${this.wallet.publicKey.toBase58()}`);
		this.logger.info(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

		this.checkOpenOrders(false);
		setInterval(this.checkOpenOrders, 1000 * 60 * 3); // 3 minutes

		this.processDepositAddresses();
		setInterval(this.processDepositAddresses, 1000 * 60 * 3); // 3 minutes
	}

	private processDepositAddresses = async (): Promise<void> => {
		try {
			const quartzClient = await this.quartzClientPromise;

			let depositAddresses: {
				owner: PublicKey;
				balances: Record<MarketIndex, BN>;
			}[] = [];
			try {
				depositAddresses = await this.getAllDepositAddressesAPI();
			} catch {
				depositAddresses = await this.getAllDepositAddressesRPC();
			}

			this.logger.info(
				`Processing deposit addresses for ${depositAddresses.length} users`,
			);

			for (const depositAddress of depositAddresses) {
				for (const marketIndex of MarketIndex) {
					const balance: BN = depositAddress.balances[marketIndex];
					if (balance.lte(ZERO)) {
						continue;
					}

					const user = await quartzClient.getQuartzAccount(
						depositAddress.owner,
					);
					this.fulfilDeposit(user, marketIndex);
				}
			}
		} catch (error) {
			this.logger.error(
				`Error processing deposit addresses: ${error} - ${JSON.stringify(error)}`,
			);
		}
	};

	private getAllDepositAddressesAPI = async (): Promise<
		{
			owner: PublicKey;
			balances: Record<MarketIndex, BN>;
		}[]
	> => {
		const response = await fetchAndParse<{
			users: VaultResponse[];
		}>(`${config.INTERNAL_API_URL}/data/all-open-orders`);

		const depositAddresses: {
			owner: PublicKey;
			balances: Record<MarketIndex, BN>;
		}[] = [];

		for (const user of response.users) {
			const owner = new PublicKey(user.vault.owner);
			const balances = getMarketIndicesRecord(ZERO);

			const LAMPORTS_RENT = 890880;
			balances[MARKET_INDEX_SOL] = new BN(
				Math.max(0, user.depositAddress.lamports - LAMPORTS_RENT),
			);

			for (const splAccount of user.depositAddress.splAccounts) {
				const mint = new PublicKey(splAccount.mint);
				const token = Object.entries(TOKENS).find(
					(value) => value[1].mint === mint,
				);

				if (!token || !isMarketIndex(Number(token[0]))) continue;
				const marketIndex = Number(token[0]) as MarketIndex;

				balances[marketIndex] = new BN(splAccount.amount);
			}

			depositAddresses.push({
				owner,
				balances,
			});
		}

		return depositAddresses;
	};

	private getAllDepositAddressesRPC = async (): Promise<
		{
			owner: PublicKey;
			balances: Record<MarketIndex, BN>;
		}[]
	> => {
		const quartzClient = await this.quartzClientPromise;
		const owners = await retryWithBackoff(
			async () => await quartzClient.getAllQuartzAccountOwnerPubkeys(),
		);
		const users = await retryWithBackoff(async () => {
			return await quartzClient.getMultipleQuartzAccounts(owners);
		});

		const depositAddresses: {
			owner: PublicKey;
			balances: Record<MarketIndex, number>;
		}[] = [];

		for (const user of users) {
			if (!user) continue;
			const balances = await user.getAllDepositAddressBalances();
			depositAddresses.push({
				owner: user.pubkey,
				balances,
			});
		}

		return depositAddresses;
	};

	private fulfilDeposit = async (
		user: QuartzUser,
		marketIndex: MarketIndex,
	): Promise<void> => {
		try {
			const { ixs, lookupTables, signers } = await user.makeFulfilDepositIxs(
				marketIndex,
				this.wallet.publicKey,
			);
			const signature = await this.buildSendAndConfirm(ixs, lookupTables, [
				this.wallet,
				...signers,
			]);

			this.logger.info(
				`Deposit filled for user ${user.pubkey.toBase58()} (market index ${marketIndex}) confirmed: ${signature}`,
			);
		} catch (error) {
			if (error instanceof SendTransactionError) {
				const logs = await error.getLogs(this.connection).catch(() => [error]);
				const logsString = logs.join("\n");
				const SPOT_POSITION_UNAVAILABLE_ERROR =
					"Program log: AnchorError occurred. Error Code: NoSpotPositionAvailable. Error Number: 6084. Error Message: NoSpotPositionAvailable.";
				const INSUFFICIENT_DEPOSIT_ERROR =
					"Program log: AnchorError occurred. Error Code: InsufficientDeposit. Error Number: 6002. Error Message: Insufficient deposit.";

				if (logsString.includes(SPOT_POSITION_UNAVAILABLE_ERROR)) {
					return;
				}

				if (logsString.includes(INSUFFICIENT_DEPOSIT_ERROR)) {
					return;
				}
			}

			this.logger.error(
				`Error fulfilling deposit for user ${user.pubkey.toBase58()} (market index ${marketIndex}): ${error} - ${JSON.stringify(error)}`,
			);
		}
	};

	private checkOpenOrders = async (onlyMissedOrders = true): Promise<void> => {
		try {
			await this.checkOpenOrdersAPI(onlyMissedOrders);
			return;
		} catch (error) {
			this.logger.warn(
				`Error checking open orders via API, falling back to RPC: ${error} - ${JSON.stringify(error)}`,
			);
		}

		try {
			await this.checkOpenOrdersRPC(onlyMissedOrders);
		} catch (error) {
			this.logger.error(
				`Error checking open orders: ${error} - ${JSON.stringify(error)}`,
			);
		}
	};

	private checkOpenOrdersAPI = async (
		onlyMissedOrders = true,
	): Promise<void> => {
		const orders = await fetchAndParse<{
			withdrawOrders: WithdrawOrderResponse[];
			spendLimitsOrders: SpendLimitsOrderResponse[];
		}>(`${config.INTERNAL_API_URL}/data/all-open-orders`);

		const withdrawOrders: WithdrawOrderAccount[] = orders.withdrawOrders.map(
			(order) => ({
				publicKey: new PublicKey(order.publicKey),
				account: {
					timeLock: {
						owner: new PublicKey(order.account.time_lock.owner),
						isOwnerPayer: order.account.time_lock.is_owner_payer,
						releaseSlot: new BN(order.account.time_lock.release_slot),
					},
					amountBaseUnits: new BN(order.account.amount_base_units),
					driftMarketIndex: new BN(order.account.drift_market_index),
					reduceOnly: order.account.reduce_only,
					destination: new PublicKey(order.account.destination),
				},
			}),
		);

		const spendLimitsOrders: SpendLimitsOrderAccount[] =
			orders.spendLimitsOrders.map((order) => ({
				publicKey: new PublicKey(order.publicKey),
				account: {
					timeLock: {
						owner: new PublicKey(order.account.time_lock.owner),
						isOwnerPayer: order.account.time_lock.is_owner_payer,
						releaseSlot: new BN(order.account.time_lock.release_slot),
					},
					spendLimitPerTransaction: new BN(
						order.account.spend_limit_per_transaction,
					),
					spendLimitPerTimeframe: new BN(
						order.account.spend_limit_per_timeframe,
					),
					timeframeInSeconds: new BN(order.account.timeframe_in_seconds),
					nextTimeframeResetTimestamp: new BN(
						order.account.next_timeframe_reset_timestamp,
					),
				},
			}));

		this.scheduleOrders(withdrawOrders, spendLimitsOrders, onlyMissedOrders);
	};

	private checkOpenOrdersRPC = async (
		onlyMissedOrders = true,
	): Promise<void> => {
		const quartzClient = await this.quartzClientPromise;

		const withdrawOrders = await retryWithBackoff(
			async () => await quartzClient.getOpenWithdrawOrders(),
			10,
		);

		const spendLimitsOrders = await retryWithBackoff(
			async () => await quartzClient.getOpenSpendLimitsOrders(),
			10,
		);

		this.scheduleOrders(withdrawOrders, spendLimitsOrders, onlyMissedOrders);
	};

	private scheduleOrders = async (
		withdrawOrders: WithdrawOrderAccount[],
		spendLimitsOrders: SpendLimitsOrderAccount[],
		onlyMissedOrders = true,
	): Promise<void> => {
		const currentSlot = await this.connection.getSlot();
		const withdrawOrdersFiltered = onlyMissedOrders
			? filterOrdersForMissed(withdrawOrders, currentSlot)
			: withdrawOrders;
		const spendLimitsOrdersFiltered = onlyMissedOrders
			? filterOrdersForMissed(spendLimitsOrders, currentSlot)
			: spendLimitsOrders;

		const orderCount =
			Object.keys(withdrawOrdersFiltered).length +
			Object.keys(spendLimitsOrdersFiltered).length;

		this.logger.info(
			`[${new Date().toISOString()}] Checking for ${onlyMissedOrders ? "missed" : "open"} orders... Found ${orderCount}`,
		);
		if (orderCount <= 0) return;

		for (const [, order] of Object.entries(withdrawOrdersFiltered)) {
			this.scheduleWithdraw(order.publicKey, order.account);
		}

		for (const [, order] of Object.entries(spendLimitsOrdersFiltered)) {
			this.scheduleSpendLimit(order.publicKey, order.account);
		}
	};

	private listenForOrder = async <T extends WithdrawOrder | SpendLimitsOrder>(
		instructionName: "InitiateWithdraw" | "InitiateSpendLimit",
		scheduleOrderFill: (orderPubkey: PublicKey, order: T) => Promise<void>,
	): Promise<void> => {
		const quartzClient = await this.quartzClientPromise;

		const ORDER_INDEX = 2;

		quartzClient.listenForInstruction(
			instructionName,
			async (
				_tx: VersionedTransactionResponse,
				ix: MessageCompiledInstruction,
				accountKeys: PublicKey[],
			) => {
				let orderPubkey: PublicKey;
				try {
					const orderIndex = ix.accountKeyIndexes?.[ORDER_INDEX];
					if (orderIndex === undefined || accountKeys[orderIndex] === undefined)
						throw new Error("Order index not found");
					orderPubkey = accountKeys[orderIndex];
				} catch (error) {
					this.logger.error(`Error finding order index: ${error}`);
					return;
				}

				try {
					let order: T;
					if (instructionName === "InitiateWithdraw") {
						order = (await quartzClient.parseOpenWithdrawOrder(
							orderPubkey,
							10,
						)) as T;
					} else {
						order = (await quartzClient.parseOpenSpendLimitsOrder(
							orderPubkey,
							10,
						)) as T;
					}

					scheduleOrderFill(orderPubkey, order);
				} catch (error) {
					if (
						error instanceof Error &&
						error.message.includes(
							`Account does not exist or has no data ${orderPubkey.toBase58()}`,
						)
					) {
						// Order already processed
						return;
					}

					this.logger.error(`Error processing order instruction: ${error}`);
				}
			},
		);
	};

	private scheduleWithdraw = async (
		orderPubkey: PublicKey,
		order: WithdrawOrder,
	): Promise<void> => {
		try {
			this.logger.info(
				`Scheduling withdraw fill for order ${orderPubkey.toBase58()}`,
			);
			await this.waitForRelease(order.timeLock.releaseSlot.toNumber());
		} catch (error) {
			this.logger.error(
				`Error waiting for release for order ${orderPubkey.toBase58()}: ${error}`,
			);
			return;
		}

		try {
			await retryWithBackoff(async () => {
				await this.fillWithdraw(orderPubkey, order);
			}, 3);
		} catch (error) {
			this.logger.error(
				`Error scheduling withdraw fill for order ${orderPubkey.toBase58()}: ${error}`,
			);
		}
	};

	private fillWithdraw = async (
		orderPubkey: PublicKey,
		order: WithdrawOrder,
	): Promise<void> => {
		const quartzClient = await this.quartzClientPromise;

		try {
			const accountExists = await this.checkOrderExists(
				orderPubkey,
				"withdraw",
			);
			if (!accountExists) {
				this.logger.info(
					`Withdraw order ${orderPubkey.toBase58()} no longer exists on chain, skipping...`,
				);
				return;
			}
		} catch (error) {
			this.logger.warn(
				`Error checking if withdraw order ${orderPubkey.toBase58()} exists, assuming it does...: ${error} - ${JSON.stringify(error)}`,
			);
		}

		try {
			const marketIndex = order.driftMarketIndex.toNumber() as MarketIndex;
			const doesAtaExist = await hasAta(
				this.connection,
				order.destination,
				TOKENS[marketIndex].mint,
			);
			if (marketIndex !== MARKET_INDEX_SOL && !doesAtaExist) {
				// this.logger.info(
				// 	`No ATA found for withdraw order, skipping... {account: ${orderPubkey.toBase58()}, owner: ${order.timeLock.owner.toBase58()}, marketIndex: ${marketIndex}}`,
				// );
				return;
			}

			const user = await quartzClient.getQuartzAccount(order.timeLock.owner);

			const maxWithdraw = await user
				.getWithdrawalLimit(
					order.driftMarketIndex,
					order.reduceOnly,
					[], // Ignore other open orders
				)
				.then((bn) => bn.toNumber() as number);
			if (maxWithdraw < order.amountBaseUnits * 0.8) {
				return; // Skip withdraw orders with insufficient balance to be filled
			}
			// const amountToWithdraw = Math.min(maxWithdraw, order.amountBaseUnits);

			const ixData = await user.makeFulfilWithdrawIxs(
				orderPubkey,
				this.wallet.publicKey,
				undefined,
				// amountToWithdraw, // TODO: Add back in
			);

			const signature = await this.buildSendAndConfirm(
				ixData.ixs,
				ixData.lookupTables,
				[this.wallet, ...ixData.signers],
			);

			if (signature) {
				this.logger.info(
					`Withdraw fill for order ${orderPubkey.toBase58()} confirmed: ${signature}`,
				);
			}
		} catch (error) {
			const ACCOUNT_DOES_NOT_EXIST_ERROR = `Account does not exist or has no data ${orderPubkey.toBase58()}`;

			if (error instanceof SendTransactionError) {
				const logs = await error.getLogs(this.connection).catch(() => [error]);

				const logsString = logs.join("\n");
				const INSUFFICIENT_COLLATERAL_ERROR =
					"Program log: Error Insufficient collateral thrown at programs/drift/src/state/user.rs";
				const INSUFFICIENT_DEPOSIT_ERROR =
					"Program log: AnchorError occurred. Error Code: InsufficientDeposit. Error Number: 6002. Error Message: Insufficient deposit.";
				const DAILY_WITHDRAW_LIMIT_ERROR =
					"Program log: AnchorError occurred. Error Code: DailyWithdrawLimit. Error Number: 6128. Error Message: DailyWithdrawLimit.";

				if (
					logsString.includes(INSUFFICIENT_COLLATERAL_ERROR) ||
					logsString.includes(INSUFFICIENT_DEPOSIT_ERROR)
				) {
					this.logger.info(
						`Insufficient collateral error for order ${orderPubkey.toBase58()}, skipping...`,
					);
					return;
				}

				if (logsString.includes(DAILY_WITHDRAW_LIMIT_ERROR)) {
					this.logger.warn(
						`Daily withdraw limit error for order ${orderPubkey.toBase58()}, skipping...`,
					);
					return;
				}

				if (logsString.includes(ACCOUNT_DOES_NOT_EXIST_ERROR)) {
					// Order already processed
					return;
				}

				throw new Error(logs.join("\n"));
			}

			if (
				error instanceof Error &&
				error.message.includes(ACCOUNT_DOES_NOT_EXIST_ERROR)
			) {
				// Order already processed
				return;
			}

			throw error;
		}
	};

	private scheduleSpendLimit = async (
		orderPubkey: PublicKey,
		order: SpendLimitsOrder,
	): Promise<void> => {
		try {
			this.logger.info(
				`Scheduling spend limit fill for order ${orderPubkey.toBase58()}`,
			);
			await this.waitForRelease(order.timeLock.releaseSlot.toNumber());
		} catch (error) {
			this.logger.error(
				`Error waiting for release for order ${orderPubkey.toBase58()}: ${error}`,
			);
			return;
		}

		try {
			await retryWithBackoff(async () => {
				await this.fillSpendLimit(orderPubkey, order);
			}, 3);
		} catch (error) {
			this.logger.error(
				`Error scheduling spend limit fill for order ${orderPubkey.toBase58()}: ${error}`,
			);
		}
	};

	private fillSpendLimit = async (
		orderPubkey: PublicKey,
		order: SpendLimitsOrder,
	): Promise<void> => {
		const quartzClient = await this.quartzClientPromise;

		try {
			const accountExists = await this.checkOrderExists(
				orderPubkey,
				"spend-limits",
			);
			if (!accountExists) {
				this.logger.info(
					`Spend limit order ${orderPubkey.toBase58()} no longer exists on chain, skipping...`,
				);
				return;
			}
		} catch (error) {
			this.logger.warn(
				`Error checking if spend limit order ${orderPubkey.toBase58()} exists, assuming it does...: ${error} - ${JSON.stringify(error)}`,
			);
		}

		try {
			const user = await quartzClient.getQuartzAccount(order.timeLock.owner);
			const ixData = await user.makeFulfilSpendLimitsIxs(
				orderPubkey,
				this.wallet.publicKey,
			);
			const signature = await this.buildSendAndConfirm(
				ixData.ixs,
				ixData.lookupTables,
				[this.wallet, ...ixData.signers],
			);

			if (signature) {
				this.logger.info(
					`Spend limit fill for order ${orderPubkey.toBase58()} confirmed: ${signature}`,
				);
			}
		} catch (error) {
			const ACCOUNT_DOES_NOT_EXIST_ERROR = `Account does not exist or has no data ${orderPubkey.toBase58()}`;

			if (error instanceof SendTransactionError) {
				const logs = await error.getLogs(this.connection).catch(() => [error]);

				const logsString = logs.join("\n");
				if (logsString.includes(ACCOUNT_DOES_NOT_EXIST_ERROR)) {
					// Order already processed
					return;
				}

				throw new Error(logs.join("\n"));
			}

			if (
				error instanceof Error &&
				error.message.includes(ACCOUNT_DOES_NOT_EXIST_ERROR)
			) {
				// Order already processed
				return;
			}

			throw new Error(`${orderPubkey.toBase58()}: ${JSON.stringify(error)}`);
		}
	};

	private waitForRelease = async (releaseSlot: number): Promise<void> => {
		try {
			const currentSlot = await this.connection.getSlot();
			if (currentSlot <= releaseSlot) {
				const msToRelease = (releaseSlot - currentSlot + 1) * 400; // Add one to land after the release slot
				await new Promise((resolve) => setTimeout(resolve, msToRelease));
			}
		} catch (error) {
			this.logger.error(`Error waiting for release: ${error}`);
			throw error;
		}
	};

	private checkOrderExists = async (
		orderPubkey: PublicKey,
		orderType: "withdraw" | "spend-limits",
	): Promise<boolean> => {
		const endpoint = buildEndpointURL(
			`${config.INTERNAL_API_URL}/data/order/${orderType}`,
			{
				publicKey: orderPubkey.toBase58(),
			},
		);
		const orderResponse = await fetchAndParse<{
			order: WithdrawOrderResponse | null;
		}>(endpoint);

		return orderResponse.order !== null;
	};

	private buildSendAndConfirm = async (
		instructions: TransactionInstruction[],
		lookupTables: AddressLookupTableAccount[],
		signers: Keypair[],
		orderAccount?: PublicKey,
	): Promise<string | null> => {
		return await retryWithBackoff(async () => {
			if (orderAccount) {
				const accountInfo = await this.connection.getAccountInfo(orderAccount);
				if (!accountInfo) {
					this.logger.info(
						`Order ${orderAccount.toBase58()} no longer exists on chain, skipping...`,
					);
					return null;
				}
			}

			const transaction = await buildTransactionMinCU(
				this.connection,
				instructions,
				this.wallet.publicKey,
				lookupTables,
			);
			transaction.sign(signers);

			const signature = await retryWithBackoff(
				async () => await this.connection.sendTransaction(transaction),
				0,
			);

			await retryWithBackoff(async () => {
				const latestBlockhash = await this.connection.getLatestBlockhash();
				const tx = await this.connection.confirmTransaction(
					{ signature, ...latestBlockhash },
					"confirmed",
				);

				await this.checkRemainingBalance();

				if (tx.value.err)
					throw new Error(
						`Tx passed preflight but failed on-chain: ${signature}`,
					);
			}, 1);

			return signature;
		}, 3);
	};

	private checkRemainingBalance = async (): Promise<void> => {
		const remainingLamports = await this.connection.getBalance(
			this.wallet.publicKey,
		);
		if (remainingLamports < MIN_LAMPORTS_BALANCE) {
			this.sendEmail(
				"FILL_BOT balance is low",
				`Fill bot balance is ${remainingLamports}, please add more SOL to ${this.wallet.publicKey.toBase58()}`,
			);
		}
	};

	private async checkRequiresUpgrade(user: QuartzUser): Promise<boolean> {
		const vaultPdaAccount = await this.connection.getAccountInfo(
			user.vaultPubkey,
		);
		if (vaultPdaAccount === null) return true;

		const OLD_VAULT_SIZE = 41;
		return vaultPdaAccount.data.length <= OLD_VAULT_SIZE;
	}
}
