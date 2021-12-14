import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { Contract, providers, Wallet } from "ethers";
import { BUNDLE_EXECUTOR_ABI } from "./abi";
import { UniswappyV2EthPair } from "./UniswappyV2EthPair";
import { FACTORY_ADDRESSES } from "./addresses";
import { Arbitrage } from "./Arbitrage";
import { get } from "https"
import {getDefaultRelaySigningKey, log, logStatus} from "./utils";
import WALLET_PRIVATE_KEY from "./privatekey"

// let ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || "http://127.0.0.1:8545"
let PRIVATE_KEY = process.env.PRIVATE_KEY || WALLET_PRIVATE_KEY
let BUNDLE_EXECUTOR_ADDRESS = process.env.BUNDLE_EXECUTOR_ADDRESS || ""
let connectionInfoOrUrl: string;
let CHAIN_ID: number;

const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();

const MINER_REWARD_PERCENTAGE = parseInt(process.env.MINER_REWARD_PERCENTAGE || "80")


// Mainnet
// ETHEREUM_RPC_URL = "https://mainnet.infura.io/v3/921303e119d14c15bc81eba01a2ff8f7"
BUNDLE_EXECUTOR_ADDRESS = "0x109f2Aa85C5EAcde3ccA1477089bA723e754c032";
connectionInfoOrUrl = "https://relay.flashbots.net"
CHAIN_ID = 1;

// Testnet
// ETHEREUM_RPC_URL = "https://goerli.infura.io/v3/921303e119d14c15bc81eba01a2ff8f7"
// BUNDLE_EXECUTOR_ADDRESS = "0xE12e6e6D0D0be42809618bFae55b82e5536C5290";
// connectionInfoOrUrl = "https://relay-goerli.flashbots.net"
// CHAIN_ID = 5;

if (PRIVATE_KEY === "") {
  console.warn("Must provide PRIVATE_KEY environment variable")
  process.exit(1)
}
if (BUNDLE_EXECUTOR_ADDRESS === "") {
  console.warn("Must provide BUNDLE_EXECUTOR_ADDRESS environment variable. Please see README.md")
  process.exit(1)
}

if (FLASHBOTS_RELAY_SIGNING_KEY === "") {
  console.warn("Must provide FLASHBOTS_RELAY_SIGNING_KEY. Please see https://github.com/flashbots/pm/blob/main/guides/searcher-onboarding.md")
  process.exit(1)
}

const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL || ""

// const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);

const provider = new providers.InfuraProvider(CHAIN_ID)


const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);
const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);


function healthcheck() {
  if (HEALTHCHECK_URL === "") {
    return
  }
  get(HEALTHCHECK_URL).on('error', console.error);
}

async function main() {
  log("", logStatus.applicationStart);
  console.log("Searcher Wallet Address: " + await arbitrageSigningWallet.getAddress())
  console.log("Flashbots Relay Signing Wallet Address: " + await flashbotsRelaySigningWallet.getAddress())
  // Testing
  // const flashbotsProvider = await FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet);
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet, connectionInfoOrUrl, CHAIN_ID)

  const arbitrage = new Arbitrage(
    arbitrageSigningWallet,
    flashbotsProvider,
    new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider) )

  log("", logStatus.getMarketPairsStart);
  const markets = await UniswappyV2EthPair.getUniswapMarketsByToken(provider, FACTORY_ADDRESSES);
  log("", logStatus.getMarketPairsEnd);

  provider.on('block', async (blockNumber) => {
    console.log(`New Block: ${blockNumber} Searching`)
    const block = await provider.getBlock(blockNumber);
    await UniswappyV2EthPair.updateReserves(provider, markets.allMarketPairs);
    const bestCrossedMarkets = await arbitrage.evaluateMarkets(markets.marketsByToken);
    if (bestCrossedMarkets.length === 0) {
      console.log("No crossed markets")
      return
    }
    console.log(`New Block: ${blockNumber} Search Done`)
    bestCrossedMarkets.forEach(Arbitrage.printCrossedMarket);
    arbitrage.takeCrossedMarkets(bestCrossedMarkets, blockNumber, MINER_REWARD_PERCENTAGE, block, CHAIN_ID).then(healthcheck).catch(console.error)
  })
}

main();
