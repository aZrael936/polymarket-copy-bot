import axios from 'axios';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import {
    PaperTrade,
    PaperPosition,
    PaperPortfolioStats,
    updatePaperPosition,
    getOrCreatePortfolioStats,
} from '../models/paperTrades';
import Logger from './logger';
import { calculateOrderSize, getTradeMultiplier } from '../config/copyStrategy';
import fetchData from './fetchData';

const COPY_STRATEGY_CONFIG = ENV.COPY_STRATEGY_CONFIG;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const PAPER_INITIAL_BALANCE = ENV.PAPER_INITIAL_BALANCE;

// Position limits for paper trading
const MAX_OPEN_POSITIONS = parseInt(process.env.PAPER_MAX_POSITIONS || '50', 10);
const MAX_POSITION_VALUE_USD = parseFloat(process.env.PAPER_MAX_POSITION_VALUE || '500');

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_USD = 1.0;
const MIN_ORDER_SIZE_TOKENS = 1.0;

interface OrderBook {
    asks: Array<{ price: string; size: string }>;
    bids: Array<{ price: string; size: string }>;
}

/**
 * Fetch order book data from Polymarket CLOB API
 */
const fetchOrderBook = async (tokenId: string): Promise<OrderBook | null> => {
    try {
        // Ensure no trailing slash on base URL
        const baseUrl = CLOB_HTTP_URL.replace(/\/$/, '');
        const response = await axios.get(`${baseUrl}/book`, {
            params: { token_id: tokenId },
            timeout: ENV.REQUEST_TIMEOUT_MS,
        });
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const message = error.response?.data?.message || error.message;
            Logger.warning(`Failed to fetch order book (${status || 'network error'}): ${message}`);
        } else {
            Logger.warning(`Failed to fetch order book for ${tokenId}`);
        }
        return null;
    }
};

/**
 * Get current paper trading balance
 */
const getPaperBalance = async (): Promise<number> => {
    const stats = await getOrCreatePortfolioStats(PAPER_INITIAL_BALANCE);
    return stats.currentBalance;
};

/**
 * Get current paper position for a market
 */
const getPaperPosition = async (conditionId: string) => {
    return await PaperPosition.findOne({ conditionId });
};

/**
 * Get count of open paper positions
 */
const getOpenPositionCount = async (): Promise<number> => {
    return await PaperPosition.countDocuments({ size: { $gt: 0 } });
};

/**
 * Fetch trader's current position from Polymarket API
 */
const fetchTraderPosition = async (
    traderAddress: string,
    conditionId: string
): Promise<UserPositionInterface | null> => {
    try {
        const positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${traderAddress}`
        );
        if (Array.isArray(positions)) {
            return positions.find((p) => p.conditionId === conditionId) || null;
        }
        return null;
    } catch (error) {
        Logger.warning(`[PAPER] Failed to fetch trader position: ${error}`);
        return null;
    }
};

/**
 * Record a paper trade and update positions/stats
 */
const recordPaperTrade = async (
    trade: UserActivityInterface,
    userAddress: string,
    side: 'BUY' | 'SELL',
    simulatedSize: number,
    simulatedTokens: number,
    simulatedPrice: number,
    orderReasoning: string,
    orderBookData: { bestAsk?: number; bestBid?: number }
) => {
    const now = Date.now();

    // Create paper trade record
    await PaperTrade.create({
        originalTradeId: trade._id,
        originalTxHash: trade.transactionHash, // For traceability
        traderAddress: userAddress,
        conditionId: trade.conditionId,
        asset: trade.asset,
        side,
        simulatedSize,
        simulatedTokens,
        simulatedPrice,
        timestamp: now,
        marketTitle: trade.title,
        marketSlug: trade.slug,
        outcome: trade.outcome,
        outcomeIndex: trade.outcomeIndex,
        orderReasoning,
        bestAsk: orderBookData.bestAsk,
        bestBid: orderBookData.bestBid,
        traderUsdcSize: trade.usdcSize,
        traderPrice: trade.price,
        skipped: false,
    });

    // Update paper position
    const { realizedPnl } = await updatePaperPosition(
        trade.conditionId,
        trade.asset,
        side,
        simulatedTokens,
        simulatedPrice,
        simulatedSize,
        {
            marketTitle: trade.title,
            marketSlug: trade.slug,
            outcome: trade.outcome,
            outcomeIndex: trade.outcomeIndex,
        }
    );

    // Update portfolio stats
    const stats = await getOrCreatePortfolioStats(PAPER_INITIAL_BALANCE);

    if (side === 'BUY') {
        stats.currentBalance -= simulatedSize;
        stats.totalBuys += 1;
    } else {
        stats.currentBalance += simulatedSize;
        stats.totalSells += 1;

        // Track winning/losing trades
        if (realizedPnl > 0) {
            stats.winningTrades += 1;
        } else if (realizedPnl < 0) {
            stats.losingTrades += 1;
        }
        stats.totalRealizedPnl += realizedPnl;
    }

    stats.totalTrades += 1;
    stats.totalVolumeTraded += simulatedSize;
    stats.winRate =
        stats.totalSells > 0
            ? (stats.winningTrades / stats.totalSells) * 100
            : 0;
    stats.lastUpdateAt = now;

    await stats.save();

    return { realizedPnl };
};

/**
 * Record a skipped paper trade
 */
const recordSkippedTrade = async (
    trade: UserActivityInterface,
    userAddress: string,
    side: 'BUY' | 'SELL',
    skipReason: string
) => {
    await PaperTrade.create({
        originalTradeId: trade._id,
        originalTxHash: trade.transactionHash, // For traceability
        traderAddress: userAddress,
        conditionId: trade.conditionId,
        asset: trade.asset,
        side,
        simulatedSize: 0,
        simulatedTokens: 0,
        simulatedPrice: trade.price,
        timestamp: Date.now(),
        marketTitle: trade.title,
        marketSlug: trade.slug,
        outcome: trade.outcome,
        outcomeIndex: trade.outcomeIndex,
        orderReasoning: skipReason,
        traderUsdcSize: trade.usdcSize,
        traderPrice: trade.price,
        skipped: true,
        skipReason,
    });
};

/**
 * Simulate a paper trade (no actual execution)
 */
const postPaperOrder = async (
    condition: string,
    trade: UserActivityInterface,
    userAddress: string
) => {
    const UserActivity = getUserActivityModel(userAddress);

    if (condition === 'buy') {
        Logger.info('[PAPER] Simulating BUY strategy...');

        // Check position limits FIRST
        const openPositionCount = await getOpenPositionCount();
        const paperPosition = await getPaperPosition(trade.conditionId);
        const isNewPosition = !paperPosition || paperPosition.size <= 0;

        // Check max positions limit (only for NEW positions)
        if (isNewPosition && openPositionCount >= MAX_OPEN_POSITIONS) {
            Logger.warning(
                `[PAPER] Max positions reached (${openPositionCount}/${MAX_OPEN_POSITIONS}) - skipping new position`
            );
            await recordSkippedTrade(
                trade,
                userAddress,
                'BUY',
                `Max positions limit reached (${openPositionCount}/${MAX_OPEN_POSITIONS})`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Check max position value limit
        const currentPositionValue = paperPosition
            ? paperPosition.size * paperPosition.avgPrice
            : 0;

        if (currentPositionValue >= MAX_POSITION_VALUE_USD) {
            Logger.warning(
                `[PAPER] Position value limit reached ($${currentPositionValue.toFixed(2)}/$${MAX_POSITION_VALUE_USD}) - skipping`
            );
            await recordSkippedTrade(
                trade,
                userAddress,
                'BUY',
                `Position value limit reached ($${currentPositionValue.toFixed(2)}/$${MAX_POSITION_VALUE_USD})`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Get paper balance
        const paperBalance = await getPaperBalance();
        Logger.info(`[PAPER] Your simulated balance: $${paperBalance.toFixed(2)}`);
        Logger.info(`[PAPER] Trader bought: $${trade.usdcSize.toFixed(2)}`);
        Logger.info(`[PAPER] Open positions: ${openPositionCount}/${MAX_OPEN_POSITIONS}`);

        // Calculate order size using the same strategy as real trading
        const orderCalc = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            paperBalance,
            currentPositionValue
        );

        Logger.info(`[PAPER] ${orderCalc.reasoning}`);

        // Check if order should be executed
        if (orderCalc.finalAmount === 0) {
            Logger.warning(`[PAPER] Cannot execute: ${orderCalc.reasoning}`);
            await recordSkippedTrade(trade, userAddress, 'BUY', orderCalc.reasoning);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Fetch order book to get realistic price
        const orderBook = await fetchOrderBook(trade.asset);
        let executionPrice: number;
        let priceSource: string;

        if (orderBook && orderBook.asks && orderBook.asks.length > 0) {
            const minPriceAsk = orderBook.asks.reduce((min, ask) => {
                return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
            }, orderBook.asks[0]);

            const bestAskPrice = parseFloat(minPriceAsk.price);
            Logger.info(`[PAPER] Best ask: ${minPriceAsk.size} @ $${bestAskPrice.toFixed(4)}`);

            // Check slippage
            if (bestAskPrice - 0.05 > trade.price) {
                Logger.warning('[PAPER] Price slippage too high - skipping trade');
                await recordSkippedTrade(
                    trade,
                    userAddress,
                    'BUY',
                    `Slippage too high: ask $${bestAskPrice.toFixed(4)} vs trader $${trade.price.toFixed(4)}`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return;
            }

            executionPrice = bestAskPrice;
            priceSource = 'order book';
        } else {
            // Fall back to trader's execution price if order book unavailable
            // This can happen for resolved markets or markets with no liquidity
            Logger.info(`[PAPER] Order book unavailable, using trader's price: $${trade.price.toFixed(4)}`);
            executionPrice = trade.price;
            priceSource = 'trader price (order book unavailable)';
        }

        // Simulate the purchase
        const simulatedTokens = orderCalc.finalAmount / executionPrice;

        Logger.orderResult(
            true,
            `[PAPER] Would buy $${orderCalc.finalAmount.toFixed(2)} at $${executionPrice.toFixed(4)} (${simulatedTokens.toFixed(2)} tokens) [${priceSource}]`
        );

        // Record the paper trade
        await recordPaperTrade(
            trade,
            userAddress,
            'BUY',
            orderCalc.finalAmount,
            simulatedTokens,
            executionPrice,
            `${orderCalc.reasoning} [${priceSource}]`,
            { bestAsk: executionPrice }
        );

        // Mark original trade as processed
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    } else if (condition === 'sell') {
        Logger.info('[PAPER] Simulating SELL strategy...');

        // Get paper position
        const paperPosition = await getPaperPosition(trade.conditionId);

        if (!paperPosition || paperPosition.size <= 0) {
            Logger.warning('[PAPER] No position to sell');
            await recordSkippedTrade(trade, userAddress, 'SELL', 'No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        Logger.info(
            `[PAPER] Your simulated position: ${paperPosition.size.toFixed(2)} tokens @ avg $${paperPosition.avgPrice.toFixed(4)}`
        );

        // Fetch TRADER's actual position to calculate correct sell percentage
        const traderPosition = await fetchTraderPosition(userAddress, trade.conditionId);

        let sellTokens: number;
        let traderSellPercent: number;

        if (traderPosition) {
            // Trader's position AFTER the sell = traderPosition.size
            // Trader's position BEFORE the sell = traderPosition.size + trade.size
            const traderPositionBefore = traderPosition.size + trade.size;
            traderSellPercent = trade.size / traderPositionBefore;

            Logger.info(
                `[PAPER] Trader position: ${traderPositionBefore.toFixed(2)} tokens -> selling ${trade.size.toFixed(2)} (${(traderSellPercent * 100).toFixed(2)}%)`
            );
        } else if (!traderPosition && trade.size > 0) {
            // Trader sold entire position (position is now 0 or not found)
            traderSellPercent = 1.0;
            Logger.info('[PAPER] Trader closed entire position -> selling all');
        } else {
            // Fallback: estimate based on trade size vs our position
            traderSellPercent = Math.min(1.0, trade.size / (trade.size + paperPosition.size));
            Logger.warning(
                `[PAPER] Could not fetch trader position, estimating sell %: ${(traderSellPercent * 100).toFixed(2)}%`
            );
        }

        // Apply sell percentage to OUR position
        sellTokens = paperPosition.size * traderSellPercent;
        Logger.info(
            `[PAPER] Selling ${(traderSellPercent * 100).toFixed(2)}% of our position: ${paperPosition.size.toFixed(2)} x ${(traderSellPercent * 100).toFixed(2)}% = ${sellTokens.toFixed(2)} tokens`
        );

        // Apply multiplier
        const multiplier = getTradeMultiplier(COPY_STRATEGY_CONFIG, trade.usdcSize);
        sellTokens = sellTokens * multiplier;

        if (multiplier !== 1.0) {
            Logger.info(`[PAPER] Applying ${multiplier}x multiplier`);
        }

        // Check minimum
        if (sellTokens < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `[PAPER] Sell amount ${sellTokens.toFixed(2)} tokens below minimum`
            );
            await recordSkippedTrade(
                trade,
                userAddress,
                'SELL',
                `Sell amount ${sellTokens.toFixed(2)} below minimum ${MIN_ORDER_SIZE_TOKENS}`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Cap to available position
        if (sellTokens > paperPosition.size) {
            Logger.warning(
                `[PAPER] Capping sell to available position: ${paperPosition.size.toFixed(2)} tokens`
            );
            sellTokens = paperPosition.size;
        }

        // Fetch order book to get realistic price
        const orderBook = await fetchOrderBook(trade.asset);
        let sellPrice: number;
        let sellPriceSource: string;

        if (orderBook && orderBook.bids && orderBook.bids.length > 0) {
            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            sellPrice = parseFloat(maxPriceBid.price);
            sellPriceSource = 'order book';
            Logger.info(`[PAPER] Best bid: ${maxPriceBid.size} @ $${sellPrice.toFixed(4)}`);
        } else {
            // Fall back to trader's execution price if order book unavailable
            Logger.info(`[PAPER] Order book unavailable, using trader's price: $${trade.price.toFixed(4)}`);
            sellPrice = trade.price;
            sellPriceSource = 'trader price (order book unavailable)';
        }

        // Calculate USD value
        const sellValue = sellTokens * sellPrice;

        Logger.orderResult(
            true,
            `[PAPER] Would sell ${sellTokens.toFixed(2)} tokens at $${sellPrice.toFixed(4)} ($${sellValue.toFixed(2)}) [${sellPriceSource}]`
        );

        // Record the paper trade
        const { realizedPnl } = await recordPaperTrade(
            trade,
            userAddress,
            'SELL',
            sellValue,
            sellTokens,
            sellPrice,
            `Sold ${(traderSellPercent * 100).toFixed(2)}% of position [${sellPriceSource}]`,
            { bestBid: sellPrice }
        );

        if (realizedPnl !== 0) {
            const pnlSign = realizedPnl >= 0 ? '+' : '';
            Logger.info(
                `[PAPER] Realized P&L: ${pnlSign}$${realizedPnl.toFixed(2)}`
            );
        }

        // Mark original trade as processed
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    } else if (condition === 'merge') {
        Logger.info('[PAPER] Simulating MERGE strategy...');

        const paperPosition = await getPaperPosition(trade.conditionId);

        if (!paperPosition || paperPosition.size <= 0) {
            Logger.warning('[PAPER] No position to merge');
            await recordSkippedTrade(trade, userAddress, 'SELL', 'No position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Fetch order book for merge price
        const orderBook = await fetchOrderBook(trade.asset);
        let mergePrice: number;

        if (orderBook && orderBook.bids && orderBook.bids.length > 0) {
            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);
            mergePrice = parseFloat(maxPriceBid.price);
        } else {
            // Fall back to trader's price
            Logger.info(`[PAPER] Order book unavailable for merge, using trader's price: $${trade.price.toFixed(4)}`);
            mergePrice = trade.price;
        }

        const sellValue = paperPosition.size * mergePrice;

        Logger.orderResult(
            true,
            `[PAPER] Would merge (sell all) ${paperPosition.size.toFixed(2)} tokens at $${mergePrice.toFixed(4)} ($${sellValue.toFixed(2)})`
        );

        // Record the merge as a sell
        await recordPaperTrade(
            trade,
            userAddress,
            'SELL',
            sellValue,
            paperPosition.size,
            mergePrice,
            'Merge: Sold entire position',
            { bestBid: mergePrice }
        );

        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    } else {
        Logger.error(`[PAPER] Unknown condition: ${condition}`);
    }
};

export default postPaperOrder;
