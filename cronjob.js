import {CronJob} from "cron";
import _ from "lodash";
import {acquireNewSteamClient, followingPlayers, getSteamClient, notifyPlayerInGame,} from "./app.js";

// Cron schedule: Every minute at 0 seconds
const CRON_SCHEDULE = "0 * * * * *";
const TIMEZONE = "Asia/Ho_Chi_Minh";
const PARTY_SEARCH_TIMEOUT_MS = 60000;
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_STEAM_FAILS = 30;

// Record of { steamId: lastNotifyTimestamp }
const lastNotifyTimestampMap = {};

let consecutiveFailCount = 0;
let isAcquiringSteamClient = false;

/**
 * Initializes the background cron job to monitor party search and notify Discord.
 * @returns {Promise<void>}
 */
export async function initCronJob() {
    console.log("Initializing Party Search Cron...");

    const cronJob = new CronJob(
        CRON_SCHEDULE,
        async () => {
            try {
                await partySearchAndNotify();
            } catch (err) {
                console.error("Error in party search cron:", err);
            }
        },
        null,
        true,
        TIMEZONE
    );
    cronJob.start();
}

/**
 * Main logic executed on each cron event: searches party, checks for watched players,
 * sends notifications if needed, and manages Steam client failover.
 */
async function partySearchAndNotify() {
    const steamClient = getSteamClient();
    if (!steamClient || isAcquiringSteamClient) return;

    // If too many failures, reacquire a new SteamClient
    if (consecutiveFailCount > MAX_STEAM_FAILS) {
        console.warn("Too many failures. Re-acquiring Steam client.");
        consecutiveFailCount = 0;
        isAcquiringSteamClient = true;
        try {
            await acquireNewSteamClient();
        } catch (error) {
            console.error("Steam client reacquisition failed:", error);
        } finally {
            isAcquiringSteamClient = false;
        }
        return;
    }

    steamClient.log("Starting party search");

    let primePlayers = [];
    let nonPrimePlayers = [];
    try {
        primePlayers = (await steamClient.partySearch({
            prime: true,
            rank: "Gold Nova I",
            game_type: "Competitive",
            timeout: PARTY_SEARCH_TIMEOUT_MS,
        })) || [];
        nonPrimePlayers = (await steamClient.partySearch({
            prime: false,
            rank: "Gold Nova I",
            game_type: "Competitive",
            timeout: PARTY_SEARCH_TIMEOUT_MS,
        })) || [];
    } catch (err) {
        console.error("Party search error:", err);
        consecutiveFailCount++;
        return;
    }

    // Merge and deduplicate players by steamId
    const uniquePlayers = _.uniqBy([...primePlayers, ...nonPrimePlayers], "steamId");
    if (!uniquePlayers.length) {
        console.warn("No players found in party search.");
        consecutiveFailCount++;
        return;
    }

    steamClient.log(`Party search found ${uniquePlayers.length} players.`);

    // Filter for those being followed and not recently notified
    const now = Date.now();
    const playersToNotify = uniquePlayers.filter(player => {
        if (!followingPlayers.has(player.steamId)) return false;
        const lastNotified = lastNotifyTimestampMap[player.steamId] || 0;
        if (now - lastNotified < NOTIFY_COOLDOWN_MS) return false;
        lastNotifyTimestampMap[player.steamId] = now;
        return true;
    });

    if (!playersToNotify.length) return;

    await notifyPlayerInGame(playersToNotify);
    // Optionally, sendDiscordMessage(playersToNotify) if that's your use-case
}