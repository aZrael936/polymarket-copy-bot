/**
 * Check Paper Trading Statistics
 *
 * This script displays the current status of paper trading, including:
 * - Portfolio balance and P&L
 * - Open positions
 * - Recent paper trades
 * - Performance metrics
 *
 * Usage: npm run paper-stats
 */

import connectDB, { closeDB } from '../config/db';
import { ENV } from '../config/env';
import { PaperTrade, PaperPosition, PaperPortfolioStats } from '../models/paperTrades';
import axios from 'axios';

const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
};

const formatCurrency = (amount: number): string => {
    const sign = amount >= 0 ? '+' : '';
    return `${sign}$${amount.toFixed(2)}`;
};

const formatPercent = (percent: number): string => {
    const sign = percent >= 0 ? '+' : '';
    return `${sign}${percent.toFixed(2)}%`;
};

const colorPnl = (value: number): string => {
    if (value > 0) return `${colors.green}${formatCurrency(value)}${colors.reset}`;
    if (value < 0) return `${colors.red}${formatCurrency(value)}${colors.reset}`;
    return `${colors.dim}$0.00${colors.reset}`;
};

const colorPercent = (percent: number): string => {
    if (percent > 0) return `${colors.green}${formatPercent(percent)}${colors.reset}`;
    if (percent < 0) return `${colors.red}${formatPercent(percent)}${colors.reset}`;
    return `${colors.dim}0.00%${colors.reset}`;
};

/**
 * Fetch current price for a token from order book
 */
const fetchCurrentPrice = async (tokenId: string): Promise<number | null> => {
    try {
        const response = await axios.get(`${CLOB_HTTP_URL}/book`, {
            params: { token_id: tokenId },
            timeout: 5000,
        });

        const orderBook = response.data;
        if (orderBook.bids && orderBook.bids.length > 0) {
            // Use best bid as current price for paper positions
            const bestBid = orderBook.bids.reduce(
                (max: { price: string }, bid: { price: string }) =>
                    parseFloat(bid.price) > parseFloat(max.price) ? bid : max,
                orderBook.bids[0]
            );
            return parseFloat(bestBid.price);
        }
        return null;
    } catch {
        return null;
    }
};

const main = async () => {
    console.log(`\n${colors.magenta}${colors.bright}===========================================`);
    console.log('         PAPER TRADING STATISTICS');
    console.log(`===========================================${colors.reset}\n`);

    await connectDB();

    // Get portfolio stats
    const stats = await PaperPortfolioStats.findOne();

    if (!stats) {
        console.log(`${colors.yellow}No paper trading data found.${colors.reset}`);
        console.log('Start paper trading by setting PAPER_TRADING_ENABLED=true in .env\n');
        await closeDB();
        return;
    }

    // Display portfolio summary
    console.log(`${colors.cyan}${colors.bright}PORTFOLIO SUMMARY${colors.reset}`);
    console.log('─'.repeat(45));

    const startDate = new Date(stats.startedAt).toLocaleDateString();
    const lastUpdate = new Date(stats.lastUpdateAt).toLocaleString();

    console.log(`Started:           ${colors.dim}${startDate}${colors.reset}`);
    console.log(`Last Update:       ${colors.dim}${lastUpdate}${colors.reset}`);
    console.log('');

    console.log(
        `Initial Balance:   ${colors.white}$${stats.initialBalance.toFixed(2)}${colors.reset}`
    );
    console.log(
        `Current Balance:   ${colors.white}$${stats.currentBalance.toFixed(2)}${colors.reset}`
    );

    // Get all open positions and update their current prices
    const positions = await PaperPosition.find({ size: { $gt: 0 } });

    let totalUnrealizedPnl = 0;
    const updatedPositions: Array<{
        position: (typeof positions)[0];
        currentPrice: number | null;
        unrealizedPnl: number;
    }> = [];

    for (const position of positions) {
        const currentPrice = await fetchCurrentPrice(position.asset);
        let unrealizedPnl = 0;

        if (currentPrice !== null) {
            const currentValue = position.size * currentPrice;
            const costBasis = position.size * position.avgPrice;
            unrealizedPnl = currentValue - costBasis;
        } else {
            // Use stored value if we can't fetch current price
            unrealizedPnl = position.unrealizedPnl;
        }

        totalUnrealizedPnl += unrealizedPnl;
        updatedPositions.push({ position, currentPrice, unrealizedPnl });
    }

    // Calculate position value
    const positionValue = updatedPositions.reduce((sum, p) => {
        const price = p.currentPrice ?? p.position.currentPrice;
        return sum + p.position.size * price;
    }, 0);

    const totalPortfolioValue = stats.currentBalance + positionValue;
    const totalPnl = totalPortfolioValue - stats.initialBalance;
    const totalPnlPercent = (totalPnl / stats.initialBalance) * 100;

    console.log(`Positions Value:   ${colors.white}$${positionValue.toFixed(2)}${colors.reset}`);
    console.log(
        `${colors.bright}Total Value:       $${totalPortfolioValue.toFixed(2)}${colors.reset}`
    );
    console.log('');
    console.log(`Realized P&L:      ${colorPnl(stats.totalRealizedPnl)}`);
    console.log(`Unrealized P&L:    ${colorPnl(totalUnrealizedPnl)}`);
    console.log(
        `${colors.bright}Total P&L:         ${colorPnl(totalPnl)} (${colorPercent(totalPnlPercent)})${colors.reset}`
    );
    console.log('');

    // Display trading stats
    console.log(`${colors.cyan}${colors.bright}TRADING STATISTICS${colors.reset}`);
    console.log('─'.repeat(45));
    console.log(`Total Trades:      ${stats.totalTrades}`);
    console.log(`  Buy Orders:      ${stats.totalBuys}`);
    console.log(`  Sell Orders:     ${stats.totalSells}`);
    console.log(`Total Volume:      $${stats.totalVolumeTraded.toFixed(2)}`);
    console.log('');
    console.log(`Winning Trades:    ${colors.green}${stats.winningTrades}${colors.reset}`);
    console.log(`Losing Trades:     ${colors.red}${stats.losingTrades}${colors.reset}`);
    console.log(`Win Rate:          ${colorPercent(stats.winRate)}`);
    console.log('');

    // Display open positions
    if (updatedPositions.length > 0) {
        console.log(
            `${colors.cyan}${colors.bright}OPEN POSITIONS (${updatedPositions.length})${colors.reset}`
        );
        console.log('─'.repeat(45));

        for (const { position, currentPrice, unrealizedPnl } of updatedPositions) {
            const price = currentPrice ?? position.currentPrice;
            const currentValue = position.size * price;
            const pnlPercent =
                position.avgPrice > 0 ? ((price - position.avgPrice) / position.avgPrice) * 100 : 0;

            console.log(
                `\n${colors.white}${position.marketTitle || position.marketSlug || position.conditionId}${colors.reset}`
            );
            console.log(`  Outcome: ${position.outcome || 'N/A'}`);
            console.log(`  Size: ${position.size.toFixed(2)} tokens`);
            console.log(`  Avg Entry: $${position.avgPrice.toFixed(4)}`);
            console.log(`  Current:   $${price.toFixed(4)}`);
            console.log(`  Value:     $${currentValue.toFixed(2)}`);
            console.log(`  P&L:       ${colorPnl(unrealizedPnl)} (${colorPercent(pnlPercent)})`);
        }
        console.log('');
    } else {
        console.log(`${colors.dim}No open positions${colors.reset}\n`);
    }

    // Display recent trades
    const recentTrades = await PaperTrade.find({ skipped: false })
        .sort({ timestamp: -1 })
        .limit(10);

    if (recentTrades.length > 0) {
        console.log(`${colors.cyan}${colors.bright}RECENT TRADES (Last 10)${colors.reset}`);
        console.log('─'.repeat(45));

        for (const trade of recentTrades) {
            const tradeTime = new Date(trade.timestamp).toLocaleString();
            const sideColor = trade.side === 'BUY' ? colors.green : colors.red;

            console.log(
                `\n${colors.dim}${tradeTime}${colors.reset} ${sideColor}${trade.side}${colors.reset}`
            );
            console.log(`  Market: ${trade.marketTitle || trade.marketSlug || 'Unknown'}`);
            console.log(`  Outcome: ${trade.outcome || 'N/A'}`);
            console.log(
                `  Amount: $${trade.simulatedSize.toFixed(2)} (${trade.simulatedTokens.toFixed(2)} tokens @ $${trade.simulatedPrice.toFixed(4)})`
            );
            console.log(
                `  Trader: $${trade.traderUsdcSize.toFixed(2)} @ $${trade.traderPrice.toFixed(4)}`
            );
        }
        console.log('');
    }

    // Display skipped trades count
    const skippedCount = await PaperTrade.countDocuments({ skipped: true });
    if (skippedCount > 0) {
        console.log(`${colors.dim}Skipped trades: ${skippedCount}${colors.reset}\n`);
    }

    console.log(`${colors.magenta}===========================================${colors.reset}\n`);

    await closeDB();
};

main().catch(console.error);
