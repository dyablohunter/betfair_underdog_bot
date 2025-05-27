const tls = require("tls");
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config();

// Sanity check for environment variables
if (
  !process.env.LOGIN_APP_KEY ||
  !process.env.STREAM_APP_KEY ||
  !process.env.betfairUsername ||
  !process.env.password
) {
  console.error(
    chalk.red(
      "Missing required environment variables: LOGIN_APP_KEY, STREAM_APP_KEY, betfairUsername, or password"
    )
  );
  console.error(
    chalk.red(
      "Please update your .env file and verify appKeys in the Betfair Developer Portal: https://developer.betfair.com/"
    )
  );
  process.exit(1);
}

// Setup file logging
const logFile = "bot.log";
const logStream = fs.createWriteStream(logFile, { flags: "a" });

// Override console.log to include file logging
const originalConsoleLog = console.log;
console.log = (...args) => {
  const timestamp = new Date().toISOString();
  const message = args
    .map((arg) =>
      typeof arg === "object" ? JSON.stringify(arg, null, 2) : arg
    )
    .join(" ");
  originalConsoleLog(...args);
  logStream.write(`[${timestamp}] LOG: ${message}\n`);
};

// Configuration variables
const fixedBalance = 100;
const simulationBalance = 100;
const betPercentage = 10;
let multiplier = 1;
const useImpossibleOdds = true;
const enableSimulation = true;
const loginAppKey = process.env.LOGIN_APP_KEY;
const streamAppKey = process.env.STREAM_APP_KEY;
const username = process.env.betfairUsername;
const password = process.env.password;
const loginEndpoint = "https://identitysso.betfair.ro/api/login";
const apiEndpoint = "https://api.betfair.com/exchange/betting/rest/v1.0/";
const streamHost = "stream-api.betfair.com";
const streamPort = 443;
const maxMarketsPerSubscription = 10;
// New test betting variables
const testBetEnabled = true;
const testBetOdds = 1.5;
const testBetOddsTolerance = 1;

// Global state
let sessionToken;
const gameHistoricalData = {};
let hasOpenBet = false;
const orderIds = {};
let simBalance = simulationBalance;
let ws;
let isSubscribed = false;
let isAuthenticated = false;
let startTime = new Date();
let hasPlacedBet = false;
let totalMarketsTracked = 0;
let totalSetsCompleted = 0;
let totalConditionsMet = 0;
let totalBetsPlaced = 0;
let testBetPlaced = false;
let buffer = "";

// Append market data to .ndjson file
function appendToNdjson(eventId, entry) {
  const filePath = path.join("games", `${eventId}.ndjson`);
  const line = JSON.stringify(entry) + "\n";
  fs.appendFile(filePath, line, (err) => {
    if (err)
      console.error(
        chalk.red(`Failed to write to ${filePath}: ${err.message}`)
      );
  });
}

// Setup historical data collection directory
function setupHistoricalDataCollection() {
  fs.mkdir("games", { recursive: true }, (err) => {
    if (err)
      console.error(
        chalk.red(`Failed to create games directory: ${err.message}`)
      );
    else
      console.log(
        chalk.green('Historical data folder "games" created or already exists')
      );
  });
}

// Authenticate with Betfair API
async function login() {
  try {
    console.log(chalk.cyan(`Attempting login to ${loginEndpoint}`));
    const response = await fetch(loginEndpoint, {
      method: "POST",
      headers: {
        "X-Application": loginAppKey,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ username, password }),
    });
    if (!response.ok)
      throw new Error(
        `Login failed: ${response.status} ${await response.text()}`
      );
    const data = await response.json();
    sessionToken = data.token;
    console.log(chalk.green("Logged in successfully"));
    return true;
  } catch (error) {
    console.error(chalk.red(`Login error: ${error.message}`));
    return false;
  }
}

// Fetch open tennis markets
async function fetchOpenTennisMarkets() {
  let retries = 3;
  while (retries > 0) {
    try {
      console.log(chalk.cyan(`Fetching open tennis markets`));
      const response = await fetch(`${apiEndpoint}listMarketCatalogue/`, {
        method: "POST",
        headers: {
          "X-Application": loginAppKey,
          "X-Authentication": sessionToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          filter: {
            eventTypeIds: ["2"],
            marketTypeCodes: ["MATCH_ODDS"],
          },
          maxResults: 200,
          marketProjection: [
            "RUNNER_DESCRIPTION",
            "MARKET_START_TIME",
            "EVENT",
            "MARKET_DESCRIPTION",
          ],
        }),
      });
      if (!response.ok)
        throw new Error(`Fetch failed: ${await response.text()}`);
      const data = await response.json();
      console.log(chalk.cyan(`Raw markets fetched: ${data.length}`));
      return data;
    } catch (error) {
      console.error(chalk.red(`Failed to fetch markets: ${error.message}`));
      retries--;
      if (retries > 0)
        await new Promise((resolve) => setTimeout(resolve, 5000));
      else return [];
    }
  }
}

// Subscribe to open markets
function subscribeToOpenMarkets() {
  if (isSubscribed) {
    return;
  }
  const openMarketIds = Object.values(gameHistoricalData)
    .filter((game) => game.isOpen)
    .map((game) => game.marketId);
  if (!ws || openMarketIds.length === 0) {
    console.log(
      chalk.yellow(
        `No markets to subscribe to (ws: ${!!ws}, open markets: ${
          openMarketIds.length
        })`
      )
    );
    return;
  }
  console.log(
    chalk.cyan(
      `Subscribing to ${openMarketIds.length} markets in ${Math.ceil(
        openMarketIds.length / maxMarketsPerSubscription
      )} batches`
    )
  );
  for (let i = 0; i < openMarketIds.length; i += maxMarketsPerSubscription) {
    const batch = openMarketIds.slice(i, i + maxMarketsPerSubscription);
    const subscriptionMessage = {
      op: "marketSubscription",
      id: 1 + Math.floor(i / maxMarketsPerSubscription),
      marketFilter: { marketIds: batch },
      marketDataFilter: { fields: ["EX_BEST_OFFERS", "EX_MARKET_DEF"] },
    };
    ws.write(JSON.stringify(subscriptionMessage) + "\r\n");
  }
  const orderSubscriptionMessage = { op: "orderSubscription", id: 999 };
  ws.write(JSON.stringify(orderSubscriptionMessage) + "\r\n");
  isSubscribed = true;
}

// Place a bet
async function placeBet(marketId, selectionId, price, isTestBet = false) {
  let betSize;
  if (enableSimulation) {
    betSize = (betPercentage / 100) * simBalance * multiplier;
  } else if (useImpossibleOdds) {
    betSize = 2;
  } else {
    betSize = (betPercentage / 100) * fixedBalance * multiplier;
  }

  const eventId = gameHistoricalData[marketId].eventId || marketId;

  if (enableSimulation) {
    console.log(
      chalk.cyan(
        `Simulated ${
          isTestBet ? "test " : ""
        }bet on market ${marketId}: ${betSize.toFixed(2)} euros at ${price}`
      )
    );
    orderIds[marketId] = `sim_${marketId}`;
    simBalance -= betSize;
    gameHistoricalData[marketId].bet = { selectionId, size: betSize, price };
    appendToNdjson(eventId, {
      type: "bet_placed",
      mode: "simulated",
      marketId,
      selectionId,
      size: betSize,
      price,
      timestamp: new Date().toISOString(),
      isTestBet,
    });
    hasPlacedBet = true;
    hasOpenBet = true;
    if (isTestBet) testBetPlaced = true;
  } else {
    try {
      let betPrice = useImpossibleOdds ? 1000 : price;
      console.log(
        chalk.cyan(
          `Placing ${
            isTestBet ? "test " : ""
          }bet on market ${marketId}: ${betSize.toFixed(
            2
          )} euros at ${betPrice}`
        )
      );
      const response = await fetch(`${apiEndpoint}placeOrders/`, {
        method: "POST",
        headers: {
          "X-Application": loginAppKey,
          "X-Authentication": sessionToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          marketId,
          instructions: [
            {
              selectionId,
              side: "BACK",
              orderType: "LIMIT",
              limitOrder: {
                size: betSize,
                price: betPrice,
                persistenceType: "LAPSE",
              },
            },
          ],
        }),
      });
      if (!response.ok)
        throw new Error(`Bet placement failed: ${await response.text()}`);
      const data = await response.json();
      const betId = data.instructionReports[0].betId;
      console.log(
        chalk.green(`Bet placed on market ${marketId}, betId: ${betId}`)
      );
      orderIds[marketId] = betId;
      gameHistoricalData[marketId].bet = {
        selectionId,
        size: betSize,
        price: betPrice,
      };
      appendToNdjson(eventId, {
        type: "bet_placed",
        mode: "live",
        marketId,
        selectionId,
        size: betSize,
        price: betPrice,
        betId,
        timestamp: new Date().toISOString(),
        isTestBet,
      });
      if (useImpossibleOdds) {
        await editBet(marketId, betId, 0.05, price);
      } else {
        hasOpenBet = true;
      }
      hasPlacedBet = true;
      if (isTestBet) testBetPlaced = true;
    } catch (error) {
      console.error(chalk.red(`Bet placement failed: ${error.message}`));
    }
  }
}

// Edit a live bet
async function editBet(marketId, betId, newSize, price) {
  if (!enableSimulation) {
    try {
      console.log(
        chalk.cyan(
          `Editing bet ${betId} on market ${marketId} to size ${newSize} at price ${price}`
        )
      );
      const response = await fetch(`${apiEndpoint}replaceOrders/`, {
        method: "POST",
        headers: {
          "X-Application": loginAppKey,
          "X-Authentication": sessionToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          marketId,
          instructions: [{ betId, newPrice: price, newSize }],
        }),
      });
      if (!response.ok)
        throw new Error(`Bet edit failed: ${await response.text()}`);
      console.log(
        chalk.blue(
          `Bet ${betId} edited to size ${newSize} euros at price ${price}`
        )
      );
      gameHistoricalData[marketId].bet.size = newSize;
      gameHistoricalData[marketId].bet.price = price;
      appendToNdjson(gameHistoricalData[marketId].eventId || marketId, {
        type: "bet_edited",
        betId,
        newSize,
        newPrice: price,
        timestamp: new Date().toISOString(),
      });
      hasOpenBet = true;
    } catch (error) {
      console.error(chalk.red(`Bet edit failed: ${error.message}`));
    }
  }
}

// Connect to Stream API
function connectStreamAPI() {
  if (ws) {
    ws.destroy();
    ws = null;
  }
  isSubscribed = false;
  isAuthenticated = false;
  ws = tls.connect({
    host: streamHost,
    port: streamPort,
    rejectUnauthorized: true,
  });
  ws.on("connect", () => {
    console.log(
      chalk.green(`Connected to Stream API at ${streamHost}:${streamPort}`)
    );
    ws.write(
      JSON.stringify({
        op: "authentication",
        appKey: streamAppKey,
        session: sessionToken,
      }) + "\r\n"
    );
  });
  ws.on("data", (data) => {
    buffer += data.toString();
    while (true) {
      const index = buffer.indexOf("\r\n");
      if (index === -1) break;
      const message = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      try {
        handleStreamMessage(JSON.parse(message));
      } catch (error) {
        console.error(
          chalk.red(
            `Failed to parse stream message of length ${message.length}: ${error.message}`
          )
        );
      }
    }
  });
  ws.on("error", (error) => {
    console.error(chalk.red(`Stream API error: ${error.message}`));
    isSubscribed = false;
    setTimeout(connectStreamAPI, 20000);
  });
  ws.on("close", () => {
    console.log(chalk.yellow("Stream API connection closed"));
    isSubscribed = false;
    setTimeout(connectStreamAPI, 20000);
  });
}

// Handle Stream API messages
function handleStreamMessage(message) {
  if (message.op === "status" && message.statusCode === "SUCCESS") {
    if (!isAuthenticated) {
      console.log(chalk.green("Authentication successful"));
      isAuthenticated = true;
    }
    subscribeToOpenMarkets();
  } else if (message.op === "mcm") {
    message.mc?.forEach((mc) => {
      const marketId = mc.id;
      const game = gameHistoricalData[marketId];
      if (!game || !game.isOpen) return;

      const isInPlay = mc.marketDefinition?.inPlay || false;

      // Skip score check for test betting; require score for live/simulated betting
      if (!testBetEnabled) {
        const hasScore = !!mc.marketDefinition?.score;
        if (isInPlay && !hasScore) {
          game.isOpen = false;
          console.log(
            chalk.red(`Excluding market ${marketId} (in-play, no score data)`)
          );
          appendToNdjson(game.eventId || marketId, {
            type: "market_excluded",
            reason: "in-play_no_score",
            marketId,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      // Update odds with proper validation and logging
      if (mc.rc && isInPlay) {
        console.log(
          chalk.gray(
            `Score data for market ${marketId}: ${JSON.stringify(
              mc.marketDefinition?.score
            )}`
          )
        );
        mc.rc.forEach((runner) => {
          const odds = runner.batb?.[0]?.[0];
          console.log(
            chalk.gray(
              `Market ${marketId}, Runner ${runner.id}, Status: ${game.status}, Raw batb odds = ${odds}`
            )
          );
          if (typeof odds !== "number" || isNaN(odds) || odds === 0) {
            console.log(
              chalk.yellow(
                `No back offers available for market ${marketId}, runner ${runner.id}`
              )
            );
          } else if (odds <= 1) {
            console.log(
              chalk.yellow(
                `Odds at minimum for market ${marketId}, runner ${runner.id}: ${odds}`
              )
            );
          } else {
            if (runner.id === game.selectionIdA) {
              game.currentOdds.pA = odds;
              console.log(
                chalk.gray(`Updated pA odds for ${marketId}: ${odds}`)
              );
            } else if (runner.id === game.selectionIdB) {
              game.currentOdds.pB = odds;
              console.log(
                chalk.gray(`Updated pB odds for ${marketId}: ${odds}`)
              );
            }
          }
        });

        // Test betting logic: Place a bet if odds match testBetOdds
        if (testBetEnabled && isInPlay && !testBetPlaced && !hasOpenBet) {
          const oddsA = game.currentOdds.pA;
          const oddsB = game.currentOdds.pB;
          if (oddsA && Math.abs(oddsA - testBetOdds) <= testBetOddsTolerance) {
            console.log(
              chalk.cyan(
                `Test bet triggered for market ${marketId}, Player A at odds ${oddsA}`
              )
            );
            placeBet(marketId, game.selectionIdA, oddsA, true);
          } else if (
            oddsB &&
            Math.abs(oddsB - testBetOdds) <= testBetOddsTolerance
          ) {
            console.log(
              chalk.cyan(
                `Test bet triggered for market ${marketId}, Player B at odds ${oddsB}`
              )
            );
            placeBet(marketId, game.selectionIdB, oddsB, true);
          }
        }

        appendToNdjson(game.eventId || marketId, {
          type: "odds_update",
          timestamp: new Date().toISOString(),
          pA_odds:
            typeof game.currentOdds.pA === "number" &&
            !isNaN(game.currentOdds.pA) &&
            game.currentOdds.pA > 1
              ? game.currentOdds.pA
              : null,
          pB_odds:
            typeof game.currentOdds.pB === "number" &&
            !isNaN(game.currentOdds.pB) &&
            game.currentOdds.pB > 1
              ? game.currentOdds.pB
              : null,
        });
      }

      if (mc.marketDefinition?.score && !testBetEnabled) {
        game.sets = mc.marketDefinition.score.sets || [];
        if (
          game.sets.length >= 1 &&
          !game.hasFirstSetEnded &&
          game.sets[0].completed
        ) {
          game.hasFirstSetEnded = true;
          totalSetsCompleted++;
          const set1 = game.sets[0];
          const homeScore = set1.homeScore || 0;
          const awayScore = set1.awayScore || 0;
          const difference = Math.abs(homeScore - awayScore);
          const underdogOdds =
            homeScore > awayScore ? game.currentOdds.pB : game.currentOdds.pA;
          console.log(
            chalk.cyan(
              `Market ${marketId}: Set 1 ended ${homeScore}-${awayScore}, Underdog Odds: ${underdogOdds}`
            )
          );
          if (difference <= 2 && underdogOdds >= 2) {
            totalConditionsMet++;
            if (!hasOpenBet) {
              placeBet(
                marketId,
                homeScore > awayScore ? game.selectionIdB : game.selectionIdA,
                underdogOdds
              );
              totalBetsPlaced++;
            }
          }
        }
      }

      if (mc.marketDefinition?.status === "CLOSED") {
        game.isOpen = false;
        game.status = "ENDED";
        let pnl = 0;
        let outcome = "no_bet";
        if (game.bet && mc.marketDefinition?.runners) {
          const winningRunner = mc.marketDefinition.runners.find(
            (r) => r.status === "WINNER"
          );
          if (winningRunner) {
            const isWin = winningRunner.id === game.bet.selectionId;
            outcome = isWin ? "win" : "lose";
            if (isWin) {
              pnl = (game.bet.price - 1) * game.bet.size * 0.95;
              if (enableSimulation) simBalance += pnl + game.bet.size;
              multiplier = 1;
            } else {
              pnl = -game.bet.size;
              if (enableSimulation) simBalance -= game.bet.size;
              multiplier *= 2;
            }
            console.log(
              chalk[outcome === "win" ? "green" : "red"](
                `Market ${marketId} closed, PNL: ${pnl.toFixed(2)} euros`
              )
            );
            appendToNdjson(game.eventId || marketId, {
              type: "bet_outcome",
              mode: enableSimulation ? "simulated" : "live",
              marketId,
              selectionId: game.bet.selectionId,
              outcome,
              pnl,
              timestamp: new Date().toISOString(),
            });
          }
        }
        appendToNdjson(game.eventId || marketId, {
          type: "market_closed",
          timestamp: new Date().toISOString(),
          outcome,
          pnl,
        });
        console.log(chalk.blue(`Market ${marketId} closed`));
        delete orderIds[marketId];
        delete gameHistoricalData[marketId];
        hasOpenBet = false;
        testBetPlaced = false;
      } else if (mc.marketDefinition?.inPlay) {
        game.status = "IN_PLAY";
      } else {
        game.status = "UPCOMING";
      }
    });
  } else if (message.op === "ocm") {
    message.oc?.forEach((oc) => {
      const marketId = oc.marketId;
      const game = gameHistoricalData[marketId];
      if (game && orderIds[marketId] && !enableSimulation) {
        oc.or?.forEach((order) => {
          if (
            order.status === "EXECUTION_COMPLETE" &&
            order.profit !== undefined &&
            order.betId === orderIds[marketId]
          ) {
            const outcome = order.profit > 0 ? "win" : "lose";
            const pnl = order.profit;
            console.log(
              chalk[outcome === "win" ? "green" : "red"](
                `Market ${marketId} order settled, PNL: ${pnl.toFixed(2)} euros`
              )
            );
            appendToNdjson(game.eventId || marketId, {
              type: "bet_outcome",
              mode: "live",
              marketId,
              selectionId: game.bet.selectionId,
              outcome,
              pnl,
              timestamp: new Date().toISOString(),
            });
            multiplier = outcome === "win" ? 1 : multiplier * 2;
            hasOpenBet = false;
            testBetPlaced = false;
            delete orderIds[marketId];
          }
        });
      }
    });
  }
}

// Main bot logic
async function runBot() {
  console.log(chalk.cyan("Starting Underdog Martingale bot"));
  if (testBetEnabled)
    console.log(
      chalk.yellow(
        `Test betting enabled: Targeting odds ${testBetOdds} ±${testBetOddsTolerance}`
      )
    );
  if (!(await login())) return;
  setupHistoricalDataCollection();
  const initialMarkets = await fetchOpenTennisMarkets();
  if (initialMarkets.length === 0) {
    console.error(chalk.red("No tennis markets found. Exiting."));
    return;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  initialMarkets.forEach((market) => {
    const marketId = market.marketId;
    const eventOpenDate = new Date(
      market.event?.openDate || market.marketStartTime || new Date()
    );
    const isToday = true;
    if (
      !gameHistoricalData[marketId] &&
      market.runners?.length >= 2 &&
      isToday
    ) {
      gameHistoricalData[marketId] = {
        isOpen: true,
        marketId,
        playerA: market.runners[0].runnerName || "Player A",
        playerB: market.runners[1].runnerName || "Player B",
        selectionIdA: market.runners[0].selectionId,
        selectionIdB: market.runners[1].selectionId,
        currentOdds: { pA: null, pB: null },
        sets: [],
        hasFirstSetEnded: false,
        eventId: market.event?.id || marketId,
        status: eventOpenDate > new Date() ? "UPCOMING" : "IN_PLAY",
        eventOpenDate,
      };
      totalMarketsTracked++;
    }
  });
  console.log(
    chalk.cyan(
      `Total markets tracked: ${Object.keys(gameHistoricalData).length}`
    )
  );
  connectStreamAPI();

  setInterval(() => {
    const closeMarkets = Object.values(gameHistoricalData).filter(
      (game) =>
        game.isOpen &&
        game.sets.length >= 1 &&
        !game.hasFirstSetEnded &&
        game.sets[0].homeScore !== undefined &&
        game.sets[0].awayScore !== undefined &&
        Math.max(game.sets[0].homeScore, game.sets[0].awayScore) >= 5
    );
    console.log(
      chalk.cyan(
        `Number of markets with first set close to ending (>=5 games): ${closeMarkets.length}`
      )
    );
    if (closeMarkets.length > 0) {
      const top3 = closeMarkets
        .sort((a, b) => {
          const maxA = Math.max(a.sets[0].homeScore, a.sets[0].awayScore);
          const maxB = Math.max(b.sets[0].homeScore, b.sets[0].awayScore);
          if (maxA !== maxB) return maxB - maxA;
          const diffA = Math.abs(a.sets[0].homeScore - a.sets[0].awayScore);
          const diffB = Math.abs(b.sets[0].homeScore - b.sets[0].awayScore);
          return diffB - diffA;
        })
        .slice(0, 3);
      console.log(chalk.cyan("Top 3 markets close to ending first set:"));
      top3.forEach((game) => {
        const set1 = game.sets[0];
        console.log(
          chalk.cyan(
            `Market ${game.marketId}: Set 1 ${game.playerA} ${set1.homeScore}-${
              set1.awayScore
            } ${game.playerB}, Odds ${game.currentOdds.pA || "N/A"}-${
              game.currentOdds.pB || "N/A"
            }`
          )
        );
      });
    }

    const upcomingMarkets = Object.values(gameHistoricalData).filter(
      (game) => game.status === "UPCOMING"
    ).length;
    const inPlayMarkets = Object.values(gameHistoricalData).filter(
      (game) => game.status === "IN_PLAY"
    ).length;
    const endedMarkets = Object.values(gameHistoricalData).filter(
      (game) => game.status === "ENDED"
    ).length;

    console.log(
      chalk.cyan(
        `Today's (${today.toISOString().split("T")[0]}) Tennis Match Schedule:`
      )
    );
    console.log(
      chalk.cyan(
        `Total: ${
          Object.keys(gameHistoricalData).length
        }, Upcoming: ${upcomingMarkets}, In-Play: ${inPlayMarkets}, Ended: ${endedMarkets}`
      )
    );
    console.log(
      chalk.yellow(
        "Note: Counts reflect markets available via Betfair API; actual schedules may include additional matches."
      )
    );

    console.log(chalk.cyan(`Total markets tracked: ${totalMarketsTracked}`));
    console.log(chalk.cyan(`Total sets completed: ${totalSetsCompleted}`));
    console.log(
      chalk.cyan(`Total times betting condition met: ${totalConditionsMet}`)
    );
    console.log(chalk.cyan(`Total bets placed: ${totalBetsPlaced}`));
  }, 300000);

  setInterval(() => {
    if (!hasPlacedBet) {
      const elapsed = Math.floor((new Date() - startTime) / 60000);
      console.log(
        chalk.yellow(`Elapsed time without betting: ${elapsed} minutes`)
      );
    }
  }, 300000);
}

// Start the bot
runBot();
