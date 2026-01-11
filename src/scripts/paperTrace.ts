/**
 * Paper Trade Trace
 *
 * This script shows the complete trade history for a specific position,
 * allowing you to trace back which traders triggered which trades.
 *
 * Usage:
 *   npm run paper-trace <conditionId or marketSlug>
 *   npm run paper-trace -- --list   (list all positions with trades)
 *
 * Examples:
 *   npm run paper-trace 0x1234...
 *   npm run paper-trace portsmouth-fc-vs-bolton
 *   npm run paper-trace -- --list
 */

import connectDB, { closeDB } from '../config/db';
import { PaperTrade, PaperPosition } from '../models/paperTrades';

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
    return `$${amount.toFixed(2)}`;
};

const formatAddress = (address: string): string => {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const formatTxHash = (hash: string | undefined): string => {
    if (!hash) return 'N/A';
    if (hash.length <= 12) return hash;
    return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
};

const listAllPositions = async () => {
    console.log(`\n${colors.cyan}${colors.bright}POSITIONS WITH TRADE HISTORY${colors.reset}`);
    console.log('─'.repeat(80));

    // Get all positions that have trades
    const positions = await PaperPosition.find().sort({ lastUpdateAt: -1 });

    if (positions.length === 0) {
        console.log(`${colors.yellow}No positions found.${colors.reset}\n`);
        return;
    }

    for (const pos of positions) {
        const tradeCount = await PaperTrade.countDocuments({
            conditionId: pos.conditionId,
            skipped: false,
        });

        const status =
            pos.size > 0
                ? `${colors.green}OPEN${colors.reset}`
                : `${colors.dim}CLOSED${colors.reset}`;

        const pnlColor = pos.realizedPnl >= 0 ? colors.green : colors.red;
        const pnlStr = pos.realizedPnl >= 0 ? `+$${pos.realizedPnl.toFixed(2)}` : `-$${Math.abs(pos.realizedPnl).toFixed(2)}`;

        console.log(`\n${colors.white}${pos.marketTitle || pos.marketSlug || 'Unknown'}${colors.reset}`);
        console.log(`  Outcome:     ${pos.outcome || 'N/A'}`);
        console.log(`  Status:      ${status} (${pos.size.toFixed(2)} tokens)`);
        console.log(`  Realized:    ${pnlColor}${pnlStr}${colors.reset}`);
        console.log(`  Trades:      ${tradeCount}`);
        console.log(`  ConditionId: ${colors.dim}${pos.conditionId}${colors.reset}`);
    }

    console.log(`\n${colors.dim}Use: npm run paper-trace <conditionId> to see trade details${colors.reset}\n`);
};

const tracePosition = async (searchTerm: string) => {
    // Try to find by conditionId first, then by marketSlug
    let trades = await PaperTrade.find({ conditionId: searchTerm }).sort({ timestamp: 1 });

    if (trades.length === 0) {
        // Try searching by marketSlug (partial match)
        trades = await PaperTrade.find({
            marketSlug: { $regex: searchTerm, $options: 'i' },
        }).sort({ timestamp: 1 });
    }

    if (trades.length === 0) {
        // Try searching by marketTitle (partial match)
        trades = await PaperTrade.find({
            marketTitle: { $regex: searchTerm, $options: 'i' },
        }).sort({ timestamp: 1 });
    }

    if (trades.length === 0) {
        console.log(`\n${colors.yellow}No trades found for: ${searchTerm}${colors.reset}`);
        console.log(`${colors.dim}Try using --list to see all positions with trades${colors.reset}\n`);
        return;
    }

    // Get the position for this conditionId
    const conditionId = trades[0].conditionId;
    const position = await PaperPosition.findOne({ conditionId });

    const marketTitle = trades[0].marketTitle || trades[0].marketSlug || 'Unknown Market';
    const outcome = trades[0].outcome || 'N/A';

    console.log(`\n${colors.magenta}${colors.bright}===========================================`);
    console.log('         TRADE HISTORY TRACE');
    console.log(`===========================================${colors.reset}\n`);

    console.log(`${colors.cyan}${colors.bright}MARKET${colors.reset}`);
    console.log('─'.repeat(80));
    console.log(`Title:       ${colors.white}${marketTitle}${colors.reset}`);
    console.log(`Outcome:     ${outcome}`);
    console.log(`ConditionId: ${colors.dim}${conditionId}${colors.reset}`);

    if (position) {
        const status =
            position.size > 0
                ? `${colors.green}OPEN${colors.reset}`
                : `${colors.dim}CLOSED${colors.reset}`;

        console.log(`\nCurrent Position:`);
        console.log(`  Status:       ${status}`);
        console.log(`  Size:         ${position.size.toFixed(2)} tokens`);
        console.log(`  Avg Price:    $${position.avgPrice.toFixed(4)}`);

        const realizedColor = position.realizedPnl >= 0 ? colors.green : colors.red;
        const realizedSign = position.realizedPnl >= 0 ? '+' : '';
        console.log(`  Realized P&L: ${realizedColor}${realizedSign}$${position.realizedPnl.toFixed(2)}${colors.reset}`);

        if (position.size > 0) {
            const unrealizedColor = position.unrealizedPnl >= 0 ? colors.green : colors.red;
            const unrealizedSign = position.unrealizedPnl >= 0 ? '+' : '';
            console.log(`  Unrealized:   ${unrealizedColor}${unrealizedSign}$${position.unrealizedPnl.toFixed(2)}${colors.reset}`);
        }
    }

    // Separate executed and skipped trades
    const executedTrades = trades.filter((t) => !t.skipped);
    const skippedTrades = trades.filter((t) => t.skipped);

    console.log(`\n${colors.cyan}${colors.bright}EXECUTED TRADES (${executedTrades.length})${colors.reset}`);
    console.log('─'.repeat(80));

    if (executedTrades.length === 0) {
        console.log(`${colors.dim}No executed trades${colors.reset}`);
    } else {
        // Track running totals
        let runningTokens = 0;
        let runningCost = 0;

        for (const trade of executedTrades) {
            const tradeTime = new Date(trade.timestamp).toLocaleString();
            const sideColor = trade.side === 'BUY' ? colors.green : colors.red;
            const sideSymbol = trade.side === 'BUY' ? '+' : '-';

            // Update running totals
            if (trade.side === 'BUY') {
                runningTokens += trade.simulatedTokens;
                runningCost += trade.simulatedSize;
            } else {
                runningTokens -= trade.simulatedTokens;
                runningCost -= trade.simulatedTokens * (runningCost / (runningTokens + trade.simulatedTokens));
            }

            console.log(`\n${colors.dim}${tradeTime}${colors.reset}`);
            console.log(
                `  ${sideColor}${trade.side}${colors.reset} ${sideSymbol}${trade.simulatedTokens.toFixed(2)} tokens @ $${trade.simulatedPrice.toFixed(4)} = ${formatCurrency(trade.simulatedSize)}`
            );
            console.log(`  Trader:    ${formatAddress(trade.traderAddress)} (${formatCurrency(trade.traderUsdcSize)} @ $${trade.traderPrice.toFixed(4)})`);
            console.log(`  TX Hash:   ${colors.dim}${formatTxHash(trade.originalTxHash)}${colors.reset}`);
            console.log(`  Position:  ${runningTokens.toFixed(2)} tokens (${formatCurrency(runningCost)} invested)`);

            if (trade.orderReasoning) {
                console.log(`  Reasoning: ${colors.dim}${trade.orderReasoning}${colors.reset}`);
            }
        }
    }

    // Show skipped trades summary
    if (skippedTrades.length > 0) {
        console.log(`\n${colors.yellow}${colors.bright}SKIPPED TRADES (${skippedTrades.length})${colors.reset}`);
        console.log('─'.repeat(80));

        // Group by skip reason
        const skipReasons = new Map<string, number>();
        for (const trade of skippedTrades) {
            const reason = trade.skipReason || 'Unknown';
            skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
        }

        for (const [reason, count] of skipReasons) {
            console.log(`  ${count}x ${reason}`);
        }

        // Show last few skipped trades
        console.log(`\n${colors.dim}Last 3 skipped:${colors.reset}`);
        const lastSkipped = skippedTrades.slice(-3);
        for (const trade of lastSkipped) {
            const tradeTime = new Date(trade.timestamp).toLocaleString();
            console.log(
                `  ${colors.dim}${tradeTime}${colors.reset} ${trade.side} ${trade.simulatedTokens.toFixed(2)} tokens - ${trade.skipReason || 'Unknown'}`
            );
        }
    }

    // Summary statistics
    console.log(`\n${colors.cyan}${colors.bright}SUMMARY${colors.reset}`);
    console.log('─'.repeat(80));

    const buyTrades = executedTrades.filter((t) => t.side === 'BUY');
    const sellTrades = executedTrades.filter((t) => t.side === 'SELL');

    const totalBought = buyTrades.reduce((sum, t) => sum + t.simulatedTokens, 0);
    const totalBoughtValue = buyTrades.reduce((sum, t) => sum + t.simulatedSize, 0);
    const totalSold = sellTrades.reduce((sum, t) => sum + t.simulatedTokens, 0);
    const totalSoldValue = sellTrades.reduce((sum, t) => sum + t.simulatedSize, 0);

    console.log(`Total Buys:  ${buyTrades.length} trades, ${totalBought.toFixed(2)} tokens, ${formatCurrency(totalBoughtValue)}`);
    console.log(`Total Sells: ${sellTrades.length} trades, ${totalSold.toFixed(2)} tokens, ${formatCurrency(totalSoldValue)}`);

    // Unique traders
    const uniqueTraders = new Set(executedTrades.map((t) => t.traderAddress));
    console.log(`\nTraders involved: ${uniqueTraders.size}`);
    for (const trader of uniqueTraders) {
        const traderTrades = executedTrades.filter((t) => t.traderAddress === trader);
        const traderBuys = traderTrades.filter((t) => t.side === 'BUY').length;
        const traderSells = traderTrades.filter((t) => t.side === 'SELL').length;
        console.log(`  ${trader}`);
        console.log(`    ${colors.green}${traderBuys} buys${colors.reset}, ${colors.red}${traderSells} sells${colors.reset}`);
    }

    console.log(`\n${colors.magenta}===========================================${colors.reset}\n`);
};

const main = async () => {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log(`\n${colors.yellow}Usage:${colors.reset}`);
        console.log('  npm run paper-trace <conditionId or marketSlug>');
        console.log('  npm run paper-trace -- --list\n');
        console.log('Examples:');
        console.log('  npm run paper-trace 0x1234...');
        console.log('  npm run paper-trace portsmouth');
        console.log('  npm run paper-trace -- --list\n');
        return;
    }

    await connectDB();

    if (args[0] === '--list' || args[0] === '-l') {
        await listAllPositions();
    } else {
        await tracePosition(args[0]);
    }

    await closeDB();
};

main().catch(console.error);
