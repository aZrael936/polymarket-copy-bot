import { Telegraf, Context } from 'telegraf';
import { ENV } from '../config/env';
import { UserPositionInterface } from '../interfaces/User';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import Logger from '../utils/logger';

const TELEGRAM_BOT_TOKEN = ENV.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = ENV.TELEGRAM_CHAT_ID;
const PROXY_WALLET = ENV.PROXY_WALLET;
const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PAPER_TRADING_ENABLED = ENV.PAPER_TRADING_ENABLED;

let bot: Telegraf | null = null;

/**
 * Format address for display (0x1234...5678)
 */
const formatAddress = (address: string): string => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

/**
 * Escape special markdown characters for Telegram
 */
const escapeMarkdown = (text: string): string => {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

/**
 * Check if user is authorized (matches the configured chat ID)
 */
const isAuthorized = (ctx: Context): boolean => {
    const chatId = ctx.chat?.id?.toString();
    return chatId === TELEGRAM_CHAT_ID;
};

/**
 * Handle /start command
 */
const handleStart = async (ctx: Context) => {
    if (!isAuthorized(ctx)) {
        await ctx.reply(
            'Unauthorized. Your chat ID does not match the configured TELEGRAM_CHAT_ID.'
        );
        return;
    }

    const mode = PAPER_TRADING_ENABLED ? 'PAPER TRADING' : 'LIVE TRADING';
    const message = `
*Polymarket Copy Bot*

Mode: ${mode}
Tracking: ${USER_ADDRESSES.length} trader(s)

*Available Commands:*
/balance - Show your current USDC balance
/positions - Show your open positions
/pnl - Show profit/loss summary
/status - Show bot status
/help - Show this help message
    `.trim();

    await ctx.reply(message, { parse_mode: 'Markdown' });
};

/**
 * Handle /help command
 */
const handleHelp = async (ctx: Context) => {
    if (!isAuthorized(ctx)) {
        await ctx.reply('Unauthorized.');
        return;
    }

    const message = `
*Available Commands:*

/balance - Show your current USDC balance and portfolio value
/positions - Show all your open positions with P&L
/pnl - Show profit/loss summary
/status - Show bot status and tracked traders
/help - Show this help message
    `.trim();

    await ctx.reply(message, { parse_mode: 'Markdown' });
};

/**
 * Handle /balance command
 */
const handleBalance = async (ctx: Context) => {
    if (!isAuthorized(ctx)) {
        await ctx.reply('Unauthorized.');
        return;
    }

    try {
        if (PAPER_TRADING_ENABLED) {
            await ctx.reply('Paper trading mode - use /positions to see simulated portfolio.');
            return;
        }

        await ctx.reply('Fetching balance...');

        // Get USDC balance
        const usdcBalance = await getMyBalance(PROXY_WALLET);

        // Get positions for total portfolio value
        const positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );

        const positionsValue = positions.reduce((total, pos) => total + (pos.currentValue || 0), 0);
        const totalPortfolio = usdcBalance + positionsValue;

        const message = `
*Your Balance*

Wallet: \`${formatAddress(PROXY_WALLET)}\`

Available USDC: *$${usdcBalance.toFixed(2)}*
Positions Value: *$${positionsValue.toFixed(2)}*
Total Portfolio: *$${totalPortfolio.toFixed(2)}*

Open Positions: ${positions.length}
        `.trim();

        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
        Logger.error(`Telegram /balance error: ${error}`);
        await ctx.reply(
            `Error fetching balance: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
};

/**
 * Handle /positions command
 */
const handlePositions = async (ctx: Context) => {
    if (!isAuthorized(ctx)) {
        await ctx.reply('Unauthorized.');
        return;
    }

    try {
        if (PAPER_TRADING_ENABLED) {
            await ctx.reply('Paper trading mode - positions are simulated.');
            return;
        }

        await ctx.reply('Fetching positions...');

        // Get positions
        const positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );

        if (positions.length === 0) {
            await ctx.reply('No open positions.');
            return;
        }

        // Sort by current value (descending)
        const sortedPositions = positions.sort(
            (a, b) => (b.currentValue || 0) - (a.currentValue || 0)
        );

        // Calculate totals
        const totalValue = sortedPositions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
        const totalInitial = sortedPositions.reduce((sum, p) => sum + (p.initialValue || 0), 0);
        const totalPnl = totalValue - totalInitial;
        const totalPnlPercent = totalInitial > 0 ? (totalPnl / totalInitial) * 100 : 0;

        let message = `*Your Positions (${positions.length})*\n\n`;
        message += `Total Value: *$${totalValue.toFixed(2)}*\n`;
        message += `Total P&L: *${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}* (${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(1)}%)\n\n`;

        // Show top 10 positions
        const topPositions = sortedPositions.slice(0, 10);
        for (const pos of topPositions) {
            const pnl = (pos.currentValue || 0) - (pos.initialValue || 0);
            const pnlPercent = pos.percentPnl || 0;
            const pnlSign = pnl >= 0 ? '+' : '';
            const title = pos.title
                ? pos.title.slice(0, 35) + (pos.title.length > 35 ? '...' : '')
                : 'Unknown';

            message += `*${escapeMarkdown(pos.outcome || 'Unknown')}*\n`;
            message += `${escapeMarkdown(title)}\n`;
            message += `Value: $${(pos.currentValue || 0).toFixed(2)} | P&L: ${pnlSign}${pnlPercent.toFixed(1)}%\n\n`;
        }

        if (sortedPositions.length > 10) {
            message += `_...and ${sortedPositions.length - 10} more positions_`;
        }

        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
        Logger.error(`Telegram /positions error: ${error}`);
        await ctx.reply(
            `Error fetching positions: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
};

/**
 * Handle /pnl command
 */
const handlePnl = async (ctx: Context) => {
    if (!isAuthorized(ctx)) {
        await ctx.reply('Unauthorized.');
        return;
    }

    try {
        if (PAPER_TRADING_ENABLED) {
            await ctx.reply('Paper trading mode - P&L is simulated.');
            return;
        }

        await ctx.reply('Calculating P&L...');

        // Get positions
        const positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );

        // Get USDC balance
        const usdcBalance = await getMyBalance(PROXY_WALLET);

        // Calculate P&L
        const totalCurrentValue = positions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
        const totalInitialValue = positions.reduce((sum, p) => sum + (p.initialValue || 0), 0);
        const unrealizedPnl = totalCurrentValue - totalInitialValue;
        const unrealizedPnlPercent =
            totalInitialValue > 0 ? (unrealizedPnl / totalInitialValue) * 100 : 0;

        // Calculate realized P&L from positions
        const realizedPnl = positions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);

        // Separate winning and losing positions
        const winningPositions = positions.filter((p) => (p.percentPnl || 0) > 0);
        const losingPositions = positions.filter((p) => (p.percentPnl || 0) < 0);

        const totalPortfolio = usdcBalance + totalCurrentValue;

        const message = `
*Profit & Loss Summary*

*Portfolio Overview:*
Available USDC: $${usdcBalance.toFixed(2)}
Positions Value: $${totalCurrentValue.toFixed(2)}
Total Portfolio: *$${totalPortfolio.toFixed(2)}*

*Unrealized P&L:*
Amount: ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}
Percent: ${unrealizedPnlPercent >= 0 ? '+' : ''}${unrealizedPnlPercent.toFixed(2)}%

*Realized P&L:*
Amount: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}

*Position Stats:*
Total Positions: ${positions.length}
Winning: ${winningPositions.length} (${positions.length > 0 ? ((winningPositions.length / positions.length) * 100).toFixed(0) : 0}%)
Losing: ${losingPositions.length} (${positions.length > 0 ? ((losingPositions.length / positions.length) * 100).toFixed(0) : 0}%)
        `.trim();

        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
        Logger.error(`Telegram /pnl error: ${error}`);
        await ctx.reply(
            `Error calculating P&L: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
};

/**
 * Handle /status command
 */
const handleStatus = async (ctx: Context) => {
    if (!isAuthorized(ctx)) {
        await ctx.reply('Unauthorized.');
        return;
    }

    const mode = PAPER_TRADING_ENABLED ? 'PAPER TRADING' : 'LIVE TRADING';
    const tradersInfo = USER_ADDRESSES.map(
        (addr, i) => `  ${i + 1}. \`${formatAddress(addr)}\``
    ).join('\n');

    const message = `
*Bot Status*

Mode: *${mode}*
Status: Running

*Tracked Traders (${USER_ADDRESSES.length}):*
${tradersInfo}

Your Wallet: \`${formatAddress(PROXY_WALLET || 'Not configured')}\`
    `.trim();

    await ctx.reply(message, { parse_mode: 'Markdown' });
};

/**
 * Initialize and start the Telegram bot
 */
export const startTelegramBot = async (): Promise<Telegraf | null> => {
    if (!ENV.TELEGRAM_ENABLED) {
        Logger.info('Telegram bot is disabled');
        return null;
    }

    if (!TELEGRAM_BOT_TOKEN) {
        Logger.warning('TELEGRAM_BOT_TOKEN not configured, skipping Telegram bot');
        return null;
    }

    if (!TELEGRAM_CHAT_ID) {
        Logger.warning('TELEGRAM_CHAT_ID not configured, skipping Telegram bot');
        return null;
    }

    try {
        bot = new Telegraf(TELEGRAM_BOT_TOKEN);

        // Register command handlers
        bot.start(handleStart);
        bot.help(handleHelp);
        bot.command('balance', handleBalance);
        bot.command('positions', handlePositions);
        bot.command('pnl', handlePnl);
        bot.command('status', handleStatus);

        // Start the bot
        await bot.launch();
        Logger.success('Telegram bot started successfully');

        // Send startup notification
        const mode = PAPER_TRADING_ENABLED ? 'PAPER TRADING' : 'LIVE TRADING';
        await sendMessage(
            `*Polymarket Copy Bot Started*\n\nMode: ${mode}\nTracking ${USER_ADDRESSES.length} trader(s)`
        );

        return bot;
    } catch (error) {
        Logger.error(`Failed to start Telegram bot: ${error}`);
        return null;
    }
};

/**
 * Stop the Telegram bot gracefully
 */
export const stopTelegramBot = async () => {
    if (bot) {
        try {
            await sendMessage('*Polymarket Copy Bot Stopped*');
            bot.stop('SIGTERM');
            Logger.info('Telegram bot stopped');
        } catch (error) {
            Logger.error(`Error stopping Telegram bot: ${error}`);
        }
    }
};

/**
 * Send a message to the configured chat
 */
export const sendMessage = async (
    message: string,
    parseMode: 'Markdown' | 'HTML' = 'Markdown'
): Promise<boolean> => {
    if (!bot || !TELEGRAM_CHAT_ID) {
        return false;
    }

    try {
        await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: parseMode });
        return true;
    } catch (error) {
        Logger.error(`Failed to send Telegram message: ${error}`);
        return false;
    }
};

/**
 * Get the Telegram bot instance
 */
export const getTelegramBot = (): Telegraf | null => {
    return bot;
};

export default {
    startTelegramBot,
    stopTelegramBot,
    sendMessage,
    getTelegramBot,
};
