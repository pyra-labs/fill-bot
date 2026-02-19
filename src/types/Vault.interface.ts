import type { BN, MarketIndex } from "@quartz-labs/sdk";
import type { PublicKey } from "@solana/web3.js";

export interface DepositAddressInfo {
	owner: PublicKey;
	pdaBalances: Record<MarketIndex, BN>;
	privyWalletBalances: Record<MarketIndex, BN>;
}

export interface WalletBalances {
	address: string;
	lamports: number;
	splAccounts: SplAccount[];
}

export interface VaultResponse {
	vaultAddress: string;
	vaultAccount: VaultData;
	depositAddress: WalletBalances;
	privyWallet?: WalletBalances;
}

export interface VaultData {
	owner: string;
	bump: number;
	spendLimitPerTransaction: number;
	spendLimitPerTimeframe: number;
	remainingSpendLimitPerTimeframe: number;
	nextTimeframeResetTimestamp: number;
	timeframeInSeconds: number;
}

export interface SplAccount {
	mint: string;
	owner: string;
	amount: number;
	delegate: string | null;
	state: number;
	isNative: number | null;
	delegatedAmount: number;
	closeAuthority: string | null;
}
