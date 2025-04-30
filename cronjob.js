import {CronJob} from "cron";
import _ from "lodash";
import {acquireNewSteamClient, followingPlayers, getSteamClient, notifyPlayerInGame,} from "./app.js";

// Cron schedule: Every hour at minute 0
const CRON_SCHEDULE = "0 * * * *";
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
    if (!steamClient || isAcquiringSteamClient) {
        if (!steamClient) {
            console.warn("Steam client unavailable.");
        }
        if (isAcquiringSteamClient) {
            console.warn("Steam client is currently being acquired.");
        }
        return;
    }


    if (consecutiveFailCount > MAX_STEAM_FAILS) {
        console.warn("Too many failures. Re-acquiring Steam client.");
        consecutiveFailCount = 0;
        isAcquiringSteamClient = true;
        try {
            console.log("Attempting to acquire new Steam client...");
            await acquireNewSteamClient();
            console.log("New Steam client successfully acquired.");
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
        console.log("Searching for prime players...");
        primePlayers = (await steamClient.partySearch({
            prime: true,
            rank: "Gold Nova I",
            game_type: "Competitive",
            timeout: PARTY_SEARCH_TIMEOUT_MS,
        })) || [];
        console.log(`Found ${primePlayers.length} prime players.`);

        console.log("Searching for non-prime players...");
        nonPrimePlayers = (await steamClient.partySearch({
            prime: false,
            rank: "Gold Nova I",
            game_type: "Competitive",
            timeout: PARTY_SEARCH_TIMEOUT_MS,
        })) || [];
        console.log(`Found ${nonPrimePlayers.length} non-prime players.`);
    } catch (err) {
        console.error("Party search error:", err);
        consecutiveFailCount++;
        return;
    }

    const totalPlayers = [...primePlayers, ...nonPrimePlayers];
    console.log(`Total players before deduplication: ${totalPlayers.length}`);
    const uniquePlayers = _.uniqBy(totalPlayers, "steamId");
    console.log(`Total unique players after deduplication: ${uniquePlayers.length}`);

    if (!uniquePlayers.length) {
        console.warn("No players found in party search.");
        consecutiveFailCount++;
        return;
    }

    steamClient.log(`Party search found ${uniquePlayers.length} players.`);

    const now = Date.now();
    const playersToNotify = uniquePlayers.filter(player => {
        if (!followingPlayers.has(player.steamId)) {
            console.log(`Skipping ${player.steamId} - not followed.`);
            return false;
        }
        const lastNotified = lastNotifyTimestampMap[player.steamId] || 0;
        if (now - lastNotified < NOTIFY_COOLDOWN_MS) {
            console.log(`Skipping ${player.steamId} - notified recently.`);
            return false;
        }
        lastNotifyTimestampMap[player.steamId] = now;
        console.log(`Player ${player.steamId} added to notify list.`);
        return true;
    });

    if (!playersToNotify.length) {
        console.log("No players to notify.");
        return;
    }

    console.log(`Notifying ${playersToNotify.length} players.`);
    await notifyPlayerInGame(playersToNotify);
    // Optionally: sendDiscordMessage(playersToNotify);
}
