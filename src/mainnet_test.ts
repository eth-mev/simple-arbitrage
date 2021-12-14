import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import {BigNumber, Contract, providers, Wallet} from "ethers";
import { BUNDLE_EXECUTOR_ABI } from "./abi";
import { UniswappyV2EthPair } from "./UniswappyV2EthPair";
import { FACTORY_ADDRESSES } from "./addresses";
import { Arbitrage } from "./Arbitrage";
import { get } from "https"
import {ETHER, getDefaultRelaySigningKey, log, logStatus} from "./utils";
import WALLET_PRIVATE_KEY from "./privatekey"

let PRIVATE_KEY = process.env.PRIVATE_KEY || WALLET_PRIVATE_KEY
let BUNDLE_EXECUTOR_ADDRESS = process.env.BUNDLE_EXECUTOR_ADDRESS || ""
let connectionInfoOrUrl: string;
let CHAIN_ID: number;

const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();

const MINER_REWARD_PERCENTAGE = parseInt(process.env.MINER_REWARD_PERCENTAGE || "80")


// Mainnet
BUNDLE_EXECUTOR_ADDRESS = "0x56dfaF6d227D60210f915D2dB78491135A710c9a";
connectionInfoOrUrl = "https://relay.flashbots.net"
CHAIN_ID = 1;

// Testnet
// BUNDLE_EXECUTOR_ADDRESS = "0xFADDfEF62D94d57973A22FEe975a8D4262d1EcD8";
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


const provider = new providers.InfuraProvider(CHAIN_ID)
const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);
const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);

async function check_call2() {
  const execContract = new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider);
  const transaction = await execContract.populateTransaction.call2("0xe5cAad8162456E7a7077EE670083c9b872210e28", ETHER.div(10) ,"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");

  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  const baseFeePerGas: BigNumber =  block.baseFeePerGas || BigNumber.from(0) ;
  const maxBaseFeeInFutureBlock = FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(baseFeePerGas, 1);
  const GWEI = BigNumber.from(10).pow(9);
  const priorityFee = GWEI.mul(1);

  try {
    const estimateGas = await execContract.provider.estimateGas(
      {
        ...transaction,
        from: arbitrageSigningWallet.address,
        chainId: CHAIN_ID,
        type: 2,
        maxFeePerGas: priorityFee.add(maxBaseFeeInFutureBlock),
        maxPriorityFeePerGas: priorityFee,
      })

    transaction.gasLimit = estimateGas.mul(10)
    console.log(`Estimate gas success!!!!!!`)
  } catch (e) {
    console.warn(`Estimate gas failure for `, e)
    return
  }
  // const connectedWallet = arbitrageSigningWallet.connect(provider)
  // console.log("signing...")
  // await connectedWallet.signTransaction(transaction);
  //
  // console.log("sending Tx...")
  // const result = await connectedWallet.sendTransaction(transaction);
  // console.log(JSON.stringify(result));
}

async function check_close() {
  const execContract = new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider);
  const transaction = await execContract.populateTransaction.close();

  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  const baseFeePerGas: BigNumber =  block.baseFeePerGas || BigNumber.from(0) ;
  const maxBaseFeeInFutureBlock = FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(baseFeePerGas, 1);
  const GWEI = BigNumber.from(10).pow(9);
  const priorityFee = GWEI.mul(1);

  try {
    const estimateGas = await execContract.provider.estimateGas(
      {
        ...transaction,
        from: arbitrageSigningWallet.address,
        chainId: CHAIN_ID,
        type: 2,
        maxFeePerGas: priorityFee.add(maxBaseFeeInFutureBlock),
        maxPriorityFeePerGas: priorityFee,
      })

    transaction.gasLimit = estimateGas.mul(10)
    console.log(`Estimate gas success!!!!!!`)
  } catch (e) {
    console.warn(`Estimate gas failure for `, e)
    return
  }
  // const connectedWallet = arbitrageSigningWallet.connect(provider)
  // console.log("signing...")
  // await connectedWallet.signTransaction(transaction);
  //
  // console.log("sending Tx...")
  // const result = await connectedWallet.sendTransaction(transaction);
  // console.log(JSON.stringify(result));
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
    arbitrage.takeCrossedMarkets(bestCrossedMarkets, blockNumber, MINER_REWARD_PERCENTAGE, block, CHAIN_ID).catch(console.error)
  })
}

// main();
check_call2();
// check_close();
