import type { BN, MarketIndex } from "@quartz-labs/sdk";
import type { PublicKey } from "@solana/web3.js";

export interface DepositAddressInfo {
	owner: PublicKey;
	pdaBalances: Record<MarketIndex, BN>;
	privyWalletBalances: Record<MarketIndex, BN>;
}

export interface VaultResponse {
	vaultAddress: string;
	vaultAccount: VaultData;
	depositAddress: {
		lamports: number;
		splAccounts: DepositAddressSplAccount[];
	};
	privyWallet?: {
		lamports: number;
		splAccounts: DepositAddressSplAccount[];
	};
}

export interface VaultData {
	owner: string;
	bump: number;
	spend_limit_per_transaction: number;
	spend_limit_per_timeframe: number;
	remaining_spend_limit_per_timeframe: number;
	next_timeframe_reset_timestamp: number;
	timeframe_in_seconds: number;
}

export interface DepositAddressSplAccount {
	mint: string;
	owner: string;
	amount: number;
	delegate: string | null;
	state: number;
	is_native: number | null;
	delegated_amount: number;
	close_authority: string | null;
}
