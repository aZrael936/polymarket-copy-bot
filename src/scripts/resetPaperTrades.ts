/**
 * Reset Paper Trading Data
 *
 * This script resets all paper trading data to start fresh:
 * - Clears all paper trades
 * - Clears all paper positions
 * - Resets portfolio stats to initial balance
 *
 * Usage: npm run paper-reset
 */

import * as readline from 'readline';
import connectDB, { closeDB } from '../config/db';
import { ENV } from '../config/env';
import { PaperTrade, PaperPosition, PaperPortfolioStats } from '../models/paperTrades';

const PAPER_INITIAL_BALANCE = ENV.PAPER_INITIAL_BALANCE;

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};

const askConfirmation = (question: string): Promise<boolean> => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
    });
};

const main = async () => {
    console.log(`\n${colors.magenta}${colors.bright}===========================================`);
    console.log('         RESET PAPER TRADING DATA');
    console.log(`===========================================${colors.reset}\n`);

    await connectDB();

    // Get current stats
    const stats = await PaperPortfolioStats.findOne();
    const tradeCount = await PaperTrade.countDocuments();
    const positionCount = await PaperPosition.countDocuments();

    if (!stats && tradeCount === 0 && positionCount === 0) {
        console.log(
            `${colors.yellow}No paper trading data found. Nothing to reset.${colors.reset}\n`
        );
        await closeDB();
        return;
    }

    // Display current stats
    console.log(`${colors.cyan}Current Paper Trading Data:${colors.reset}`);
    console.log('─'.repeat(45));

    if (stats) {
        const totalPnl = stats.currentBalance - stats.initialBalance + stats.totalRealizedPnl;
        console.log(`Initial Balance:   $${stats.initialBalance.toFixed(2)}`);
        console.log(`Current Balance:   $${stats.currentBalance.toFixed(2)}`);
        console.log(`Realized P&L:      $${stats.totalRealizedPnl.toFixed(2)}`);
        console.log(`Total Trades:      ${stats.totalTrades}`);
    }

    console.log(`Paper Trades:      ${tradeCount}`);
    console.log(`Open Positions:    ${positionCount}`);
    console.log('');

    console.log(
        `${colors.red}${colors.bright}WARNING: This action cannot be undone!${colors.reset}`
    );
    console.log(
        `${colors.yellow}All paper trading data will be permanently deleted.${colors.reset}\n`
    );

    const confirmed = await askConfirmation(
        `${colors.yellow}Are you sure you want to reset? (y/N): ${colors.reset}`
    );

    if (!confirmed) {
        console.log(`\n${colors.cyan}Reset cancelled.${colors.reset}\n`);
        await closeDB();
        return;
    }

    console.log(`\n${colors.cyan}Resetting paper trading data...${colors.reset}`);

    // Delete all paper trades
    const tradesDeleted = await PaperTrade.deleteMany({});
    console.log(`  Deleted ${tradesDeleted.deletedCount} paper trades`);

    // Delete all paper positions
    const positionsDeleted = await PaperPosition.deleteMany({});
    console.log(`  Deleted ${positionsDeleted.deletedCount} paper positions`);

    // Delete portfolio stats
    const statsDeleted = await PaperPortfolioStats.deleteMany({});
    console.log(`  Deleted ${statsDeleted.deletedCount} portfolio stats`);

    // Create fresh portfolio stats
    const now = Date.now();
    await PaperPortfolioStats.create({
        initialBalance: PAPER_INITIAL_BALANCE,
        currentBalance: PAPER_INITIAL_BALANCE,
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
    console.log(
        `  Created fresh portfolio stats with $${PAPER_INITIAL_BALANCE.toFixed(2)} balance`
    );

    console.log(
        `\n${colors.green}${colors.bright}Paper trading data has been reset!${colors.reset}`
    );
    console.log(
        `\nYour new starting balance: ${colors.green}$${PAPER_INITIAL_BALANCE.toFixed(2)}${colors.reset}`
    );
    console.log(`\n${colors.magenta}===========================================${colors.reset}\n`);

    await closeDB();
};

main().catch(console.error);
