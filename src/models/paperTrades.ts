import mongoose, { Schema, Document } from 'mongoose';

// Paper Trade Schema - Individual simulated trades
export interface PaperTradeDocument extends Document {
    originalTradeId: mongoose.Types.ObjectId;
    traderAddress: string;
    conditionId: string;
    asset: string;
    side: 'BUY' | 'SELL';
    simulatedSize: number;
    simulatedTokens: number;
    simulatedPrice: number;
    timestamp: number;
    marketTitle: string;
    marketSlug: string;
    outcome: string;
    outcomeIndex: number;
    orderReasoning: string;
    bestAsk?: number;
    bestBid?: number;
    traderUsdcSize: number;
    traderPrice: number;
    skipped: boolean;
    skipReason?: string;
}

const paperTradeSchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    originalTradeId: { type: Schema.Types.ObjectId, required: true },
    traderAddress: { type: String, required: true },
    conditionId: { type: String, required: true },
    asset: { type: String, required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    simulatedSize: { type: Number, required: true },
    simulatedTokens: { type: Number, required: true },
    simulatedPrice: { type: Number, required: true },
    timestamp: { type: Number, required: true },
    marketTitle: { type: String, required: false },
    marketSlug: { type: String, required: false },
    outcome: { type: String, required: false },
    outcomeIndex: { type: Number, required: false },
    orderReasoning: { type: String, required: false },
    bestAsk: { type: Number, required: false },
    bestBid: { type: Number, required: false },
    traderUsdcSize: { type: Number, required: true },
    traderPrice: { type: Number, required: true },
    skipped: { type: Boolean, default: false },
    skipReason: { type: String, required: false },
});

// Paper Position Schema - Simulated holdings
export interface PaperPositionDocument extends Document {
    conditionId: string;
    asset: string;
    size: number;
    avgPrice: number;
    totalInvested: number;
    currentPrice: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    realizedPnl: number;
    marketTitle: string;
    marketSlug: string;
    outcome: string;
    outcomeIndex: number;
    firstTradeAt: number;
    lastUpdateAt: number;
}

const paperPositionSchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    conditionId: { type: String, required: true, unique: true },
    asset: { type: String, required: true },
    size: { type: Number, required: true, default: 0 },
    avgPrice: { type: Number, required: true, default: 0 },
    totalInvested: { type: Number, required: true, default: 0 },
    currentPrice: { type: Number, required: false },
    unrealizedPnl: { type: Number, default: 0 },
    unrealizedPnlPercent: { type: Number, default: 0 },
    realizedPnl: { type: Number, default: 0 },
    marketTitle: { type: String, required: false },
    marketSlug: { type: String, required: false },
    outcome: { type: String, required: false },
    outcomeIndex: { type: Number, required: false },
    firstTradeAt: { type: Number, required: true },
    lastUpdateAt: { type: Number, required: true },
});

// Paper Portfolio Stats Schema - Aggregate statistics
export interface PaperPortfolioStatsDocument extends Document {
    initialBalance: number;
    currentBalance: number;
    totalTrades: number;
    totalBuys: number;
    totalSells: number;
    totalVolumeTraded: number;
    totalRealizedPnl: number;
    totalUnrealizedPnl: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    startedAt: number;
    lastUpdateAt: number;
}

const paperPortfolioStatsSchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    initialBalance: { type: Number, required: true },
    currentBalance: { type: Number, required: true },
    totalTrades: { type: Number, default: 0 },
    totalBuys: { type: Number, default: 0 },
    totalSells: { type: Number, default: 0 },
    totalVolumeTraded: { type: Number, default: 0 },
    totalRealizedPnl: { type: Number, default: 0 },
    totalUnrealizedPnl: { type: Number, default: 0 },
    winningTrades: { type: Number, default: 0 },
    losingTrades: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    startedAt: { type: Number, required: true },
    lastUpdateAt: { type: Number, required: true },
});

// Create models - using fixed collection names for paper trading
export const PaperTrade = mongoose.model<PaperTradeDocument>(
    'paper_trades',
    paperTradeSchema,
    'paper_trades'
);

export const PaperPosition = mongoose.model<PaperPositionDocument>(
    'paper_positions',
    paperPositionSchema,
    'paper_positions'
);

export const PaperPortfolioStats = mongoose.model<PaperPortfolioStatsDocument>(
    'paper_portfolio_stats',
    paperPortfolioStatsSchema,
    'paper_portfolio_stats'
);

// Helper function to get or create portfolio stats
export const getOrCreatePortfolioStats = async (
    initialBalance: number
): Promise<PaperPortfolioStatsDocument> => {
    let stats = await PaperPortfolioStats.findOne();

    if (!stats) {
        const now = Date.now();
        stats = await PaperPortfolioStats.create({
            initialBalance,
            currentBalance: initialBalance,
            totalTrades: 0,
            totalBuys: 0,
            totalSells: 0,
            totalVolumeTraded: 0,
            totalRealizedPnl: 0,
            totalUnrealizedPnl: 0,
            winningTrades: 0,
            losingTrades: 0,
            winRate: 0,
            startedAt: now,
            lastUpdateAt: now,
        });
    }

    return stats;
};

// Helper function to update position after a trade
export const updatePaperPosition = async (
    conditionId: string,
    asset: string,
    side: 'BUY' | 'SELL',
    tokens: number,
    price: number,
    usdAmount: number,
    metadata: {
        marketTitle?: string;
        marketSlug?: string;
        outcome?: string;
        outcomeIndex?: number;
    }
): Promise<{ position: PaperPositionDocument; realizedPnl: number }> => {
    const now = Date.now();
    let realizedPnl = 0;

    let position = await PaperPosition.findOne({ conditionId });

    if (!position) {
        // Create new position for BUY
        if (side === 'BUY') {
            position = await PaperPosition.create({
                conditionId,
                asset,
                size: tokens,
                avgPrice: price,
                totalInvested: usdAmount,
                currentPrice: price,
                unrealizedPnl: 0,
                unrealizedPnlPercent: 0,
                realizedPnl: 0,
                marketTitle: metadata.marketTitle,
                marketSlug: metadata.marketSlug,
                outcome: metadata.outcome,
                outcomeIndex: metadata.outcomeIndex,
                firstTradeAt: now,
                lastUpdateAt: now,
            });
        } else {
            // Can't sell what we don't have
            throw new Error(`No position found for ${conditionId} to sell`);
        }
    } else {
        if (side === 'BUY') {
            // Update average price and size
            const totalCost = position.size * position.avgPrice + usdAmount;
            const newSize = position.size + tokens;
            const newAvgPrice = totalCost / newSize;

            position.size = newSize;
            position.avgPrice = newAvgPrice;
            position.totalInvested += usdAmount;
            position.currentPrice = price;
            position.lastUpdateAt = now;
        } else {
            // SELL - calculate realized P&L
            const sellValue = tokens * price;
            const costBasis = tokens * position.avgPrice;
            realizedPnl = sellValue - costBasis;

            position.size -= tokens;
            position.realizedPnl += realizedPnl;
            position.currentPrice = price;
            position.lastUpdateAt = now;

            // If position is closed, reset invested amount proportionally
            if (position.size <= 0) {
                position.size = 0;
                position.totalInvested = 0;
                position.avgPrice = 0;
            } else {
                // Reduce invested amount proportionally
                const sellRatio = tokens / (position.size + tokens);
                position.totalInvested *= 1 - sellRatio;
            }
        }

        // Update unrealized P&L
        if (position.size > 0) {
            const currentValue = position.size * position.currentPrice;
            const costBasis = position.size * position.avgPrice;
            position.unrealizedPnl = currentValue - costBasis;
            position.unrealizedPnlPercent =
                costBasis > 0 ? (position.unrealizedPnl / costBasis) * 100 : 0;
        } else {
            position.unrealizedPnl = 0;
            position.unrealizedPnlPercent = 0;
        }

        await position.save();
    }

    return { position, realizedPnl };
};
