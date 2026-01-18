import { sendMessage } from '../services/telegramBot';
import { ENV } from '../config/env';
import { UserActivityInterface } from '../interfaces/User';
import Logger from './logger';

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
 * Send notification when a new trade is detected from a tracked trader
 */
export const notifyTradeDetected = async (
    traderAddress: string,
    trade: UserActivityInterface
): Promise<void> => {
    if (!ENV.TELEGRAM_ENABLED) return;

    try {
        const side = trade.side || 'UNKNOWN';
        const sideEmoji = side === 'BUY' ? '🟢' : '🔴';
        const marketTitle = trade.title
            ? escapeMarkdown(trade.title.slice(0, 50))
            : 'Unknown Market';
        const outcome = trade.outcome ? escapeMarkdown(trade.outcome) : '';

        const message = `
${sideEmoji} *New Trade Detected*

Trader: \`${formatAddress(traderAddress)}\`
Action: *${side}*
Amount: *$${trade.usdcSize?.toFixed(2) || '0.00'}*
Price: ${(trade.price * 100).toFixed(1)}c

Market: ${marketTitle}
${outcome ? `Outcome: ${outcome}` : ''}
        `.trim();

        await sendMessage(message);
    } catch (error) {
        Logger.error(`Failed to send trade detected notification: ${error}`);
    }
};

/**
 * Send notification when a trade is successfully executed
 */
export const notifyTradeExecuted = async (
    side: 'BUY' | 'SELL' | 'MERGE',
    tokensBought: number,
    price: number,
    usdcAmount: number,
    marketTitle?: string,
    outcome?: string
): Promise<void> => {
    if (!ENV.TELEGRAM_ENABLED) return;

    try {
        const sideEmoji = side === 'BUY' ? '🟢' : '🔴';
        const actionVerb = side === 'BUY' ? 'Bought' : side === 'SELL' ? 'Sold' : 'Merged';
        const title = marketTitle ? escapeMarkdown(marketTitle.slice(0, 50)) : 'Unknown Market';
        const outcomeText = outcome ? escapeMarkdown(outcome) : '';

        const message = `
${sideEmoji} *Trade Executed*

${actionVerb}: *${tokensBought.toFixed(2)} tokens*
Price: ${(price * 100).toFixed(1)}c
Value: *$${usdcAmount.toFixed(2)}*

Market: ${title}
${outcomeText ? `Outcome: ${outcomeText}` : ''}
        `.trim();

        await sendMessage(message);
    } catch (error) {
        Logger.error(`Failed to send trade executed notification: ${error}`);
    }
};

/**
 * Send notification when a trade fails
 */
export const notifyTradeFailed = async (
    side: 'BUY' | 'SELL' | 'MERGE',
    reason: string,
    marketTitle?: string
): Promise<void> => {
    if (!ENV.TELEGRAM_ENABLED) return;

    try {
        const title = marketTitle ? escapeMarkdown(marketTitle.slice(0, 50)) : 'Unknown Market';

        const message = `
*Trade Failed*

Action: ${side}
Market: ${title}
Reason: ${escapeMarkdown(reason)}
        `.trim();

        await sendMessage(message);
    } catch (error) {
        Logger.error(`Failed to send trade failed notification: ${error}`);
    }
};

/**
 * Send notification when a trade is skipped
 */
export const notifyTradeSkipped = async (
    side: string,
    reason: string,
    marketTitle?: string
): Promise<void> => {
    if (!ENV.TELEGRAM_ENABLED) return;

    try {
        const title = marketTitle ? escapeMarkdown(marketTitle.slice(0, 50)) : 'Unknown Market';

        const message = `
*Trade Skipped*

Action: ${side}
Market: ${title}
Reason: ${escapeMarkdown(reason)}
        `.trim();

        await sendMessage(message);
    } catch (error) {
        Logger.error(`Failed to send trade skipped notification: ${error}`);
    }
};

/**
 * Send a daily summary notification
 */
export const notifyDailySummary = async (
    totalTrades: number,
    totalVolume: number,
    realizedPnl: number,
    unrealizedPnl: number,
    winRate: number
): Promise<void> => {
    if (!ENV.TELEGRAM_ENABLED) return;

    try {
        const pnlEmoji = realizedPnl >= 0 ? '📈' : '📉';

        const message = `
${pnlEmoji} *Daily Summary*

Trades Today: ${totalTrades}
Volume: $${totalVolume.toFixed(2)}

Realized P&L: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}
Unrealized P&L: ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}
Win Rate: ${winRate.toFixed(1)}%
        `.trim();

        await sendMessage(message);
    } catch (error) {
        Logger.error(`Failed to send daily summary notification: ${error}`);
    }
};

/**
 * Send a custom notification message
 */
export const notifyCustom = async (message: string): Promise<void> => {
    if (!ENV.TELEGRAM_ENABLED) return;

    try {
        await sendMessage(message);
    } catch (error) {
        Logger.error(`Failed to send custom notification: ${error}`);
    }
};

export default {
    notifyTradeDetected,
    notifyTradeExecuted,
    notifyTradeFailed,
    notifyTradeSkipped,
    notifyDailySummary,
    notifyCustom,
};
