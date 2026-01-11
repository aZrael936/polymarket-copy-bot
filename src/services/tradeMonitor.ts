import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!USER_ADDRESSES || USER_ADDRESSES.length === 0) {
    throw new Error('USER_ADDRESSES is not defined or empty');
}

// Create activity and position models for each user
const userModels = USER_ADDRESSES.map((address) => ({
    address,
    UserActivity: getUserActivityModel(address),
    UserPosition: getUserPositionModel(address),
}));

const init = async () => {
    // Fetch all activity counts in parallel
    const counts = await Promise.all(
        userModels.map(({ UserActivity }) => UserActivity.countDocuments())
    );
    Logger.clearLine();
    Logger.dbConnection(USER_ADDRESSES, counts);

    // Show your own positions first
    try {
        const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
        const myPositions = await fetchData(myPositionsUrl);

        // Get current USDC balance
        const getMyBalance = (await import('../utils/getMyBalance')).default;
        const currentBalance = await getMyBalance(ENV.PROXY_WALLET);

        if (Array.isArray(myPositions) && myPositions.length > 0) {
            // Calculate your overall profitability and initial investment
            let totalValue = 0;
            let initialValue = 0;
            let weightedPnl = 0;
            myPositions.forEach((pos: any) => {
                const value = pos.currentValue || 0;
                const initial = pos.initialValue || 0;
                const pnl = pos.percentPnl || 0;
                totalValue += value;
                initialValue += initial;
                weightedPnl += value * pnl;
            });
            const myOverallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;

            // Get top 5 positions by profitability (PnL)
            const myTopPositions = myPositions
                .sort((a: any, b: any) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 5);

            Logger.clearLine();
            Logger.myPositions(
                ENV.PROXY_WALLET,
                myPositions.length,
                myTopPositions,
                myOverallPnl,
                totalValue,
                initialValue,
                currentBalance
            );
        } else {
            Logger.clearLine();
            Logger.myPositions(ENV.PROXY_WALLET, 0, [], 0, 0, 0, currentBalance);
        }
    } catch (error) {
        Logger.error(`Failed to fetch your positions: ${error}`);
    }

    // Show current positions count with details for traders you're copying (in parallel)
    const traderData = await Promise.all(
        userModels.map(async ({ UserPosition }) => {
            const positions = await UserPosition.find().exec();

            // Calculate overall profitability (weighted average by current value)
            let totalValue = 0;
            let weightedPnl = 0;
            positions.forEach((pos) => {
                const value = pos.currentValue || 0;
                const pnl = pos.percentPnl || 0;
                totalValue += value;
                weightedPnl += value * pnl;
            });
            const overallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;

            // Get top 3 positions by profitability (PnL)
            const topPositions = positions
                .sort((a, b) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 3)
                .map((p) => p.toObject());

            return {
                count: positions.length,
                topPositions,
                overallPnl,
            };
        })
    );

    const positionCounts = traderData.map((d) => d.count);
    const positionDetails = traderData.map((d) => d.topPositions);
    const profitabilities = traderData.map((d) => d.overallPnl);

    Logger.clearLine();
    Logger.tradersPositions(USER_ADDRESSES, positionCounts, positionDetails, profitabilities);
};

// Track if this is the first run (to mark historical trades as processed)
let isFirstRun = true;

/**
 * Process a single trader's data (activities and positions)
 * Extracted to enable parallel processing of all traders
 */
const fetchSingleTraderData = async (traderModel: {
    address: string;
    UserActivity: ReturnType<typeof getUserActivityModel>;
    UserPosition: ReturnType<typeof getUserPositionModel>;
}) => {
    const { address, UserActivity, UserPosition } = traderModel;

    try {
        // Fetch both activities and positions in parallel for this trader
        const [activities, positions] = await Promise.all([
            fetchData(`https://data-api.polymarket.com/activity?user=${address}&type=TRADE`),
            fetchData(`https://data-api.polymarket.com/positions?user=${address}`),
        ]);

        // Process activities
        if (Array.isArray(activities) && activities.length > 0) {
            // Calculate cutoff timestamp (TOO_OLD_TIMESTAMP is in hours)
            const cutoffTimestamp = Date.now() - TOO_OLD_TIMESTAMP * 60 * 60 * 1000;

            for (const activity of activities) {
                // Skip if too old (activity.timestamp is in milliseconds)
                const activityTime =
                    activity.timestamp > 1e12 ? activity.timestamp : activity.timestamp * 1000;
                if (activityTime < cutoffTimestamp) {
                    continue;
                }

                // Check if this trade already exists in database
                const existingActivity = await UserActivity.findOne({
                    transactionHash: activity.transactionHash,
                }).exec();

                if (existingActivity) {
                    continue; // Already processed this trade
                }

                // Save new trade to database
                // On first run, mark historical trades as already processed
                const newActivity = new UserActivity({
                    proxyWallet: activity.proxyWallet,
                    timestamp: activity.timestamp,
                    conditionId: activity.conditionId,
                    type: activity.type,
                    size: activity.size,
                    usdcSize: activity.usdcSize,
                    transactionHash: activity.transactionHash,
                    price: activity.price,
                    asset: activity.asset,
                    side: activity.side,
                    outcomeIndex: activity.outcomeIndex,
                    title: activity.title,
                    slug: activity.slug,
                    icon: activity.icon,
                    eventSlug: activity.eventSlug,
                    outcome: activity.outcome,
                    name: activity.name,
                    pseudonym: activity.pseudonym,
                    bio: activity.bio,
                    profileImage: activity.profileImage,
                    profileImageOptimized: activity.profileImageOptimized,
                    bot: isFirstRun, // Mark as processed on first run
                    botExcutedTime: isFirstRun ? 999 : 0,
                });

                await newActivity.save();
                if (!isFirstRun) {
                    Logger.info(
                        `New trade detected for ${address.slice(0, 6)}...${address.slice(-4)}`
                    );
                }
            }
        }

        // Process positions
        if (Array.isArray(positions) && positions.length > 0) {
            // Use bulkWrite for better performance with multiple positions
            const bulkOps = positions.map((position) => ({
                updateOne: {
                    filter: { asset: position.asset, conditionId: position.conditionId },
                    update: {
                        $set: {
                            proxyWallet: position.proxyWallet,
                            asset: position.asset,
                            conditionId: position.conditionId,
                            size: position.size,
                            avgPrice: position.avgPrice,
                            initialValue: position.initialValue,
                            currentValue: position.currentValue,
                            cashPnl: position.cashPnl,
                            percentPnl: position.percentPnl,
                            totalBought: position.totalBought,
                            realizedPnl: position.realizedPnl,
                            percentRealizedPnl: position.percentRealizedPnl,
                            curPrice: position.curPrice,
                            redeemable: position.redeemable,
                            mergeable: position.mergeable,
                            title: position.title,
                            slug: position.slug,
                            icon: position.icon,
                            eventSlug: position.eventSlug,
                            outcome: position.outcome,
                            outcomeIndex: position.outcomeIndex,
                            oppositeOutcome: position.oppositeOutcome,
                            oppositeAsset: position.oppositeAsset,
                            endDate: position.endDate,
                            negativeRisk: position.negativeRisk,
                        },
                    },
                    upsert: true,
                },
            }));

            await UserPosition.bulkWrite(bulkOps);
        }
    } catch (error) {
        Logger.error(
            `Error fetching data for ${address.slice(0, 6)}...${address.slice(-4)}: ${error}`
        );
        // Don't throw - let other traders continue processing
    }
};

/**
 * Fetch trade data for all traders in PARALLEL
 * This reduces startup time from ~10-13 minutes to ~1-2 minutes
 */
const fetchTradeData = async () => {
    // Process all traders in parallel - each trader's failure won't block others
    await Promise.all(userModels.map((traderModel) => fetchSingleTraderData(traderModel)));
};

// Track if monitor should continue running
let isRunning = true;

/**
 * Stop the trade monitor gracefully
 */
export const stopTradeMonitor = () => {
    isRunning = false;
    Logger.info('Trade monitor shutdown requested...');
};

const tradeMonitor = async () => {
    await init();
    Logger.success(`Monitoring ${USER_ADDRESSES.length} trader(s) every ${FETCH_INTERVAL}s`);
    Logger.separator();

    // First fetch - this will mark historical trades as processed
    if (isFirstRun) {
        Logger.info('First run: fetching and marking historical trades as processed...');
        await fetchTradeData();
        isFirstRun = false;
        Logger.success('Historical trades processed. Now monitoring for new trades only.');
        Logger.separator();
    }

    while (isRunning) {
        await fetchTradeData();
        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }

    Logger.info('Trade monitor stopped');
};

export default tradeMonitor;
