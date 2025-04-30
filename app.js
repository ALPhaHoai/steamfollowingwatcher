import express from "express";
import cookieParser from "cookie-parser";
import logger from "morgan";
import axios from "axios";
import indexRouter from "./routes/index.js";
import { initCronJob } from "./cronjob.js";
import SteamClient from "steamutils/SteamClient.js";
import { decryptData } from "./crypto_db.js";

const app = express();

// --------- Middleware ---------
app.use(logger("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// --------- Routes ---------
app.use("/", indexRouter);

// --------- SteamClient State & Following Players ---------
/** @type {SteamClient|null} */
let steamClient = null;

/** @type {Set<string>} */
export const followingPlayers = new Set();

/** @type {{ cookie: string }[] | null} */
const cachedStoreAccounts = [];

/** Get the current usable SteamClient instance */
export function getSteamClient() {
  return steamClient;
}

// --------- Data Refresh Logic ---------
const RELOAD_PLAYERS_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function loadFollowingPlayers() {
  try {
    const {
      data: { result: steamIds },
    } = await axios.get(`${process.env.API_URL}/getFollowingPlayers`);
    if (Array.isArray(steamIds) && steamIds.length) {
      followingPlayers.clear();
      steamIds.forEach((id) => followingPlayers.add(id));
      console.log(
        `[${new Date().toISOString()}] Reloaded followingPlayers: ${followingPlayers.size} players`,
      );
    }
  } catch (error) {
    console.error("Failed to reload followingPlayers:", error.message);
  }
}

/** Get an array of non-prime store accounts */
async function getNonprimeStoreAccounts() {
  console.log(
    `[${new Date().toISOString()}] Fetching non-prime store accounts...`,
  );
  try {
    const {
      data: { result: accounts },
    } = await axios.get(
      `${process.env.API_URL}/getRandomStoreMyAccount?limit=20`,
    );

    if (!Array.isArray(accounts)) {
      console.warn("Expected array of accounts, got:", typeof accounts);
      return [];
    }

    const decrypted = accounts.map((account) => ({
      cookie: decryptData(account.cookie),
    }));

    console.log(`Fetched ${decrypted.length} non-prime store accounts.`);
    return decrypted;
  } catch (err) {
    console.error("Failed to fetch non-prime store accounts:", err.message);
    return [];
  }
}

/** Notify API that given players are in game */
export async function notifyPlayerInGame(players) {
  const timestamp = new Date().toISOString();
  console.log(
    `[${timestamp}] Notifying API: ${players.length} player(s) in game...`,
  );

  try {
    await axios.post(`${process.env.API_URL}/notifyPlayersInGame`, players);
    console.log(
      `[${timestamp}] Successfully notified API for ${players.length} player(s).`,
    );
  } catch (err) {
    console.error(
      `[${timestamp}] Failed to notify players in game:`,
      err.message,
    );
  }
}

// --------- Steam Client Acquisition ---------
/**
 * Try to acquire and return a usable SteamClient. Logs in using available accounts.
 * If an existing SteamClient is running, logs it off before replacing.
 * @returns {Promise<SteamClient|null>}
 */
export async function acquireNewSteamClient() {
  console.log(
    `[${new Date().toISOString()}] 🔍 Searching for usable Steam client...`,
  );

  try {
    // Try with cached accounts first
    if (cachedStoreAccounts?.length) {
      const client = await tryLoginWithAccounts(cachedStoreAccounts);
      if (client) return client;
    }

    // Fetch new accounts if cache failed or was empty
    const freshAccounts = await getNonprimeStoreAccounts();
    cachedStoreAccounts.length = 0;
    cachedStoreAccounts.push(...freshAccounts);

    const client = await tryLoginWithAccounts(freshAccounts);
    if (client) return client;

    console.warn("⚠️ No usable Steam client found after retry.");
  } catch (err) {
    console.error("🔥 Failed to acquire new Steam client:", err.message);
  }

  return null;
}

/** Attempt to log in using provided store accounts */
async function tryLoginWithAccounts(accounts) {
  for (const account of accounts) {
    try {
      const client = new SteamClient({ cookie: account.cookie });
      const playable = await client.playCSGOSilent();

      if (playable) {
        client.offAllEvent();
        if (steamClient) steamClient.logOff();
        steamClient = client;
        console.log("✅ New Steam client logged in.");
        return client;
      }

      await client.logOff();
    } catch (err) {
      console.error("❌ Error during client login attempt:", err.message);
    }
  }
  return null;
}

// --------- Initialization ---------
async function initialize() {
  try {
    cachedStoreAccounts.length = 0;
    cachedStoreAccounts.push(...(await getNonprimeStoreAccounts()));

    await loadFollowingPlayers();
    setInterval(loadFollowingPlayers, RELOAD_PLAYERS_INTERVAL_MS);

    await acquireNewSteamClient();
    await initCronJob();
  } catch (error) {
    console.error("Error during initialization:", error.message);
  }
}

// Delay initialization so all modules are loaded
setTimeout(initialize, 5000);

export default app;
