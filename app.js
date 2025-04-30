import express from "express";
import cookieParser from "cookie-parser";
import logger from "morgan";
import axios from "axios";
import indexRouter from "./routes/index.js";
import {initCronJob} from "./cronjob.js";
import SteamClient from "steamutils/SteamClient.js";
import {decryptData} from "./crypto_db.js";

const app = express();

// --------- Middleware ---------
app.use(logger("dev"));
app.use(express.json());
app.use(express.urlencoded({extended: false}));
app.use(cookieParser());

// --------- Routes ---------
app.use("/", indexRouter);

// --------- SteamClient State & Following Players ---------
/** @type {SteamClient|null} */
let steamClient = null;

/** @type {Set<string>} */
export const followingPlayers = new Set();

/** Get the current usable SteamClient instance */
export function getSteamClient() {
    return steamClient;
}

// --------- Data Refresh Logic ---------
const RELOAD_PLAYERS_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function loadFollowingPlayers() {
    try {
        const {data: {result: steamIds}} = await axios.get(`${process.env.API_URL}/getFollowingPlayers`);
        if (Array.isArray(steamIds) && steamIds.length) {
            followingPlayers.clear();
            steamIds.forEach(id => followingPlayers.add(id));
            console.log(`[${new Date().toISOString()}] Reloaded followingPlayers: ${followingPlayers.size} players`);
        }
    } catch (error) {
        console.error("Failed to reload followingPlayers:", error.message);
    }
}

/** Get an array of non-prime store accounts */
async function getNonprimeStoreAccounts() {
    try {
        const {data: {result: accounts}} = await axios.get(`${process.env.API_URL}/getRandomStoreMyAccount?limit=20`);
        return Array.isArray(accounts) ? accounts.map(function (account) {
            return {
                cookie: decryptData(account.cookie)
            }
        }) : [];
    } catch (err) {
        console.error("Could not fetch non-prime store accounts:", err.message);
        return [];
    }
}

/** Notify API that given players are in game */
export async function notifyPlayerInGame(players) {
    try {
        await axios.post(`${process.env.API_URL}/notifyPlayersInGame`, players);
    } catch (err) {
        console.error("Failed to notify players in game:", err.message);
    }
}

// --------- Steam Client Acquisition ---------
/**
 * Try to acquire and return a usable SteamClient. Logs in using available accounts.
 * If an existing SteamClient is running, logs it off before replacing.
 * @returns {Promise<SteamClient|null>}
 */
export async function acquireNewSteamClient() {
    try {
        const accounts = await getNonprimeStoreAccounts();
        console.log("Searching for usable Steam client...");

        for (const account of accounts) {
            const client = new SteamClient({cookie: account.cookie});
            const playable = await client.playCSGOSilent();

            if (playable) {
                client.offAllEvent();
                if (steamClient) steamClient.logOff();
                steamClient = client;
                console.log(`New Steam client logged in.`);
                return client;
            }
            client.logOff();
        }
        console.warn("No usable Steam client found.");
    } catch (err) {
        console.error("Failed to acquire new Steam client:", err.message);
    }
    return null;
}

// --------- Initialization ---------
async function initialize() {
    try {
        await loadFollowingPlayers();
        setInterval(loadFollowingPlayers, RELOAD_PLAYERS_INTERVAL_MS);

        await getNonprimeStoreAccounts(); // Side effect, possibly cache/warmup
        await acquireNewSteamClient();
        await initCronJob();
    } catch (error) {
        console.error("Error during initialization:", error.message);
    }
}

// Delay initialization so all modules are loaded
setTimeout(initialize, 5000);

export default app;