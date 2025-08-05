export interface WithdrawOrderResponse {
    publicKey: string;
    account: WithdrawOrderCacheAccount;
}

export interface SpendLimitsOrderResponse {
    publicKey: string;
    account: SpendLimitsOrderCacheAccount;
}

export interface SpendLimitsOrderCacheAccount {
    time_lock: TimeLockCache;
    spend_limit_per_transaction: number;
    spend_limit_per_timeframe: number;
    timeframe_in_seconds: number;
    next_timeframe_reset_timestamp: number;
}

export interface SpendLimitsOrderCache {
    account: SpendLimitsOrderCacheAccount;
    last_updated_slot: number;
}

export interface WithdrawOrderCacheAccount {
    time_lock: TimeLockCache;
    amount_base_units: number;
    drift_market_index: number;
    reduce_only: boolean;
    destination: string;
}

export interface WithdrawOrderCache {
    account: WithdrawOrderCacheAccount;
    last_updated_slot: number;
}

export interface TimeLockCache {
    owner: string;
    is_owner_payer: boolean;
    release_slot: number;
}