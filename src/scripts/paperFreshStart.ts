/**
 * Fresh Start for Paper Trading
 *
 * This script clears all data so paper trading starts fresh
 * and only captures trades from the moment it starts running.
 *
 * Usage: npm run paper-fresh-start
 */

import * as readline from 'readline';
import connectDB, { closeDB } from '../config/db';
import { ENV } from '../config/env';
import mongoose from 'mongoose';
import { PaperTrade, PaperPosition, PaperPortfolioStats } from '../models/paperTrades';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
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
    console.log('       PAPER TRADING - FRESH START');
    console.log(`===========================================${colors.reset}\n`);

    console.log(`${colors.cyan}This will clear ALL data so paper trading only`);
    console.log(`captures trades from the moment you start the bot.${colors.reset}\n`);

    console.log('The following will be deleted:');
    console.log('  - All paper trades');
    console.log('  - All paper positions');
    console.log('  - Paper portfolio stats');
    console.log('  - All trader activity history (for monitored traders)');
    console.log('  - All trader position history\n');

    console.log(
        `${colors.red}${colors.bright}WARNING: This action cannot be undone!${colors.reset}\n`
    );

    const confirmed = await askConfirmation(
        `${colors.yellow}Are you sure you want to start fresh? (y/N): ${colors.reset}`
    );

    if (!confirmed) {
        console.log(`\n${colors.cyan}Fresh start cancelled.${colors.reset}\n`);
        process.exit(0);
    }

    await connectDB();

    console.log(`\n${colors.cyan}Clearing all data...${colors.reset}`);

    // Delete paper trading data
    const tradesDeleted = await PaperTrade.deleteMany({});
    console.log(`  Deleted ${tradesDeleted.deletedCount} paper trades`);

    const positionsDeleted = await PaperPosition.deleteMany({});
    console.log(`  Deleted ${positionsDeleted.deletedCount} paper positions`);

    const statsDeleted = await PaperPortfolioStats.deleteMany({});
    console.log(`  Deleted ${statsDeleted.deletedCount} portfolio stats`);

    // Delete trader activity and position collections
    for (const address of USER_ADDRESSES) {
        const activityCollection = `user_activities_${address.toLowerCase()}`;
        const positionCollection = `user_positions_${address.toLowerCase()}`;

        try {
            await mongoose.connection.collection(activityCollection).drop();
            console.log(`  Dropped collection: ${activityCollection}`);
        } catch (err: unknown) {
            const error = err as { code?: number };
            if (error.code === 26) {
                console.log(`  Collection ${activityCollection} doesn't exist (OK)`);
            } else {
                console.log(`  Error dropping ${activityCollection}: ${err}`);
            }
        }

        try {
            await mongoose.connection.collection(positionCollection).drop();
            console.log(`  Dropped collection: ${positionCollection}`);
        } catch (err: unknown) {
            const error = err as { code?: number };
            if (error.code === 26) {
                console.log(`  Collection ${positionCollection} doesn't exist (OK)`);
            } else {
                console.log(`  Error dropping ${positionCollection}: ${err}`);
            }
        }
    }

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

    console.log(`\n${colors.green}${colors.bright}Fresh start complete!${colors.reset}`);
    console.log(
        `\nYour starting balance: ${colors.green}$${PAPER_INITIAL_BALANCE.toFixed(2)}${colors.reset}`
    );
    console.log(`\n${colors.cyan}When you run 'npm run dev', the bot will:`);
    console.log(`  1. Fetch current trades and mark them as "already processed"`);
    console.log(`  2. Only execute paper trades for NEW trades after that${colors.reset}`);
    console.log(`\n${colors.magenta}===========================================${colors.reset}\n`);

    await closeDB();
};

main().catch(console.error);
