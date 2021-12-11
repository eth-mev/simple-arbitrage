import * as _ from "lodash";
import { BigNumber, Contract, Wallet } from "ethers";
import { FlashbotsBundleProvider, FlashbotsBundleResolution } from "@flashbots/ethers-provider-bundle";
import { WETH_ADDRESS } from "./addresses";
import { EthMarket } from "./EthMarket";
import { ETHER, bigNumberToDecimal } from "./utils";
import { Block } from "@ethersproject/abstract-provider";

export interface CrossedMarketDetails {
  profit: BigNumber,
  volume: BigNumber,
  tokenAddress: string,
  buyFromMarket: EthMarket,
  sellToMarket: EthMarket,
}

export type MarketsByToken = { [tokenAddress: string]: Array<EthMarket> }

// TODO: implement binary search (assuming linear/exponential global maximum profitability)
const TEST_VOLUMES = [
  ETHER.div(100),
  ETHER.div(10),
  ETHER.div(6),
  ETHER.div(4),
  ETHER.div(2),
  ETHER.div(1),
  ETHER.mul(2),
  ETHER.mul(5),
  ETHER.mul(10),
]

export function getBestCrossedMarket(crossedMarkets: Array<EthMarket>[], tokenAddress: string): CrossedMarketDetails | undefined {
  let bestCrossedMarket: CrossedMarketDetails | undefined = undefined;
  for (const crossedMarket of crossedMarkets) {
    const sellToMarket = crossedMarket[0]
    const buyFromMarket = crossedMarket[1]
    for (const size of TEST_VOLUMES) {
      const tokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, size);
      const proceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tokensOutFromBuyingSize)
      const profit = proceedsFromSellingTokens.sub(size);
      if (bestCrossedMarket !== undefined && profit.lt(bestCrossedMarket.profit)) {
        // If the next size up lost value, meet halfway. TODO: replace with real binary search
        const trySize = size.add(bestCrossedMarket.volume).div(2)
        const tryTokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, trySize);
        const tryProceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tryTokensOutFromBuyingSize)
        const tryProfit = tryProceedsFromSellingTokens.sub(trySize);
        if (tryProfit.gt(bestCrossedMarket.profit)) {
          bestCrossedMarket = {
            volume: trySize,
            profit: tryProfit,
            tokenAddress,
            sellToMarket,
            buyFromMarket
          }
        }
        break;
      }
      bestCrossedMarket = {
        volume: size,
        profit: profit,
        tokenAddress,
        sellToMarket,
        buyFromMarket
      }
    }
  }
  return bestCrossedMarket;
}

export class Arbitrage {
  private flashbotsProvider: FlashbotsBundleProvider;
  private bundleExecutorContract: Contract;
  private executorWallet: Wallet;

  constructor(executorWallet: Wallet, flashbotsProvider: FlashbotsBundleProvider, bundleExecutorContract: Contract) {
    this.executorWallet = executorWallet;
    this.flashbotsProvider = flashbotsProvider;
    this.bundleExecutorContract = bundleExecutorContract;
  }

  static printCrossedMarket(crossedMarket: CrossedMarketDetails): void {
    const buyTokens = crossedMarket.buyFromMarket.tokens
    const sellTokens = crossedMarket.sellToMarket.tokens
    console.log(
      `Profit: ${bigNumberToDecimal(crossedMarket.profit)} Volume: ${bigNumberToDecimal(crossedMarket.volume)}\n` +
      `${crossedMarket.buyFromMarket.protocol} (${crossedMarket.buyFromMarket.marketAddress})\n` +
      `  ${buyTokens[0]} => ${buyTokens[1]}\n` +
      `${crossedMarket.sellToMarket.protocol} (${crossedMarket.sellToMarket.marketAddress})\n` +
      `  ${sellTokens[0]} => ${sellTokens[1]}\n` +
      `\n`
    )
  }


  async evaluateMarkets(marketsByToken: MarketsByToken): Promise<Array<CrossedMarketDetails>> {
    let bestCrossedMarkets = new Array<CrossedMarketDetails>()

    for (const tokenAddress in marketsByToken) {
      const markets = marketsByToken[tokenAddress]
      const pricedMarkets = _.map(markets, (ethMarket: EthMarket) => {
        return {
          ethMarket: ethMarket,

          // FIXME: why .div(100)
          buyTokenPrice: ethMarket.getTokensIn(tokenAddress, WETH_ADDRESS, ETHER.div(100)),
          sellTokenPrice: ethMarket.getTokensOut(WETH_ADDRESS, tokenAddress, ETHER.div(100)),
        }
      });

      const crossedMarkets = new Array<Array<EthMarket>>()
      for (const pricedMarket of pricedMarkets) {
        _.forEach(pricedMarkets, pm => {

          if (pm.sellTokenPrice.gt(pricedMarket.buyTokenPrice)) {
            crossedMarkets.push([pricedMarket.ethMarket, pm.ethMarket])
          }
        })
      }

      const bestCrossedMarket = getBestCrossedMarket(crossedMarkets, tokenAddress);
      if (bestCrossedMarket !== undefined) {
        // Testing
        if (bestCrossedMarket.profit.gt(ETHER.div(100))) {
        // if (bestCrossedMarket.profit.gt(ETHER.div(10000000))) {
          bestCrossedMarkets.push(bestCrossedMarket)
        }
      }
    }
    bestCrossedMarkets.sort((a, b) => a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0)

    console.log(`bestCrossedMarkets search length: ${bestCrossedMarkets.length}`)

    return bestCrossedMarkets
  }

  // TODO: take more than 1
  async takeCrossedMarkets(bestCrossedMarkets: CrossedMarketDetails[],
                           blockNumber: number,
                           minerRewardPercentage: number,
                           block: Block,
                           chainId: number): Promise<void> {
    console.log(`takeCrossedMarkets: bestCrossedMarket Count: ${bestCrossedMarkets.length}`)


    for (const bestCrossedMarket of bestCrossedMarkets) {

      console.log("Send this much wei", bestCrossedMarket.volume.toString(), "get this much profit wei", bestCrossedMarket.profit.toString())
      console.log("Send this much WETH", bigNumberToDecimal(bestCrossedMarket.volume).toString(), "get this much profit", bigNumberToDecimal(bestCrossedMarket.profit).toString())
      const buyCalls = await bestCrossedMarket.buyFromMarket.sellTokensToNextMarket(WETH_ADDRESS, bestCrossedMarket.volume, bestCrossedMarket.sellToMarket);
      const inter = bestCrossedMarket.buyFromMarket.getTokensOut(WETH_ADDRESS, bestCrossedMarket.tokenAddress, bestCrossedMarket.volume)
      const sellCallData = await bestCrossedMarket.sellToMarket.sellTokens(bestCrossedMarket.tokenAddress, inter, this.bundleExecutorContract.address);

      const targets: Array<string> = [...buyCalls.targets, bestCrossedMarket.sellToMarket.marketAddress]
      const payloads: Array<string> = [...buyCalls.data, sellCallData]
      console.log({targets, payloads})
      // const minerReward = bestCrossedMarket.profit.mul(minerRewardPercentage).div(100);
      // const minerReward = 0;

      const baseFeePerGas: BigNumber =  block.baseFeePerGas || BigNumber.from(0) ;
      const maxBaseFeeInFutureBlock = FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(baseFeePerGas, 1);
      const GWEI = BigNumber.from(10).pow(9);
      const priorityFee = GWEI.mul(1);



      console.log(`volume: ${bestCrossedMarket.volume}`)
      // const transaction = await this.bundleExecutorContract.populateTransaction.uniswapWeth(bestCrossedMarket.volume, minerReward, targets, payloads,
      const transaction = await this.bundleExecutorContract.populateTransaction.uniswapWeth(bestCrossedMarket.volume, targets, payloads,
      //   {
      //   type: 2, //EIP-1559
      //   maxFeePerGas: priorityFee.add(maxBaseFeeInFutureBlock),
      //   maxPriorityFeePerGas: priorityFee,
      // }
        {}
      );


      let transactionArb = {
        transaction: {
          chainId: chainId,
          type: 2, //EIP-1559
          value: ETHER.mul(0),
          data: transaction.data,
          maxFeePerGas: priorityFee.add(maxBaseFeeInFutureBlock),
          maxPriorityFeePerGas: priorityFee,
          to: this.bundleExecutorContract.address,
          gasLimit: 6000000,
        },
        signer: this.executorWallet
      }

      console.log("signingBundle")
      const signedBundle = await this.flashbotsProvider.signBundle([
        transactionArb
      ]);
      console.log(`signedBundle: ${signedBundle}`);


      const bundleSubmitResponse = await this.flashbotsProvider.sendRawBundle(signedBundle, blockNumber + 1);
      console.log(`bundleSubmitResponse: ${bundleSubmitResponse}`);


      if ('error' in bundleSubmitResponse) {
        console.log(`bundleSubmitResponse Error: ${bundleSubmitResponse.error.message}`);
        continue;
      }


      const bundleResolution = await bundleSubmitResponse.wait()
      if (bundleResolution === FlashbotsBundleResolution.BundleIncluded) {
        console.log(`Congrats, included in ${blockNumber + 1}`)
      } else if (bundleResolution === FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
        console.log(`Not included in ${blockNumber + 1}`)
      } else if (bundleResolution === FlashbotsBundleResolution.AccountNonceTooHigh) {
        console.log("Nonce too high, bailing")
      }


      // Testing
      break;


      /*
      const transaction = await this.bundleExecutorContract.populateTransaction.uniswapWeth(bestCrossedMarket.volume, minerReward, targets, payloads, {
        type: 2, //EIP-1559
        maxFeePerGas: priorityFee.add(maxBaseFeeInFutureBlock),
        maxPriorityFeePerGas: priorityFee,
      });

      console.log(`populateTransaction: ${JSON.stringify(transaction)}`)
      const isTestnet = true;
      // if (!isTestnet) {
        try {
          const estimateGas = await this.bundleExecutorContract.provider.estimateGas(
            {
              ...transaction,
              from: this.executorWallet.address,
              chainId: chainId,
            })
          if (estimateGas.gt(1400000)) {
            console.log("EstimateGas succeeded, but suspiciously large: " + estimateGas.toString())
            continue
          }
          // Testing
          // transaction.gasLimit = estimateGas.mul(2)
          transaction.gasLimit = estimateGas.mul(100)
        } catch (e) {
          // console.warn(`Estimate gas failure for ${JSON.stringify(bestCrossedMarket)}`)
          console.warn(`Estimate gas failure for ${JSON.stringify(bestCrossedMarket)}`, e)
          continue
        }
      // } else {
      //   console.log("Skip estimateGas, do later")
      // }

      const bundledTransactions = [
        {
          signer: this.executorWallet,
          transaction: transaction
        }
      ];
      console.log(`bundledTransactions: ${bundledTransactions}`)
      const signedBundle = await this.flashbotsProvider.signBundle(bundledTransactions)
      console.log(`signedBundle: ${signedBundle}`)

      //

      if (!isTestnet) {
        const simulation = await this.flashbotsProvider.simulate(signedBundle, blockNumber + 1 )
        if ("error" in simulation || simulation.firstRevert !== undefined) {
          console.log(`Simulation Error on token ${bestCrossedMarket.tokenAddress}, skipping`)
          continue
        }
        console.log(`Submitting bundle, profit sent to miner: ${bigNumberToDecimal(simulation.coinbaseDiff)}, effective gas price: ${bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9)} GWEI`)
      } else {
        console.log(`
      Submitting bundle, profit sent to miner: , 
      effective gas price: ? GWEI`)
      }

      console.log(`Submitting to block: ${blockNumber + 1}, ${blockNumber + 2}`)
      const bundlePromises =  _.map([blockNumber + 1, blockNumber + 2], targetBlockNumber =>
        this.flashbotsProvider.sendRawBundle(
          signedBundle,
          targetBlockNumber
        ))
      const results = await Promise.all(bundlePromises)




      for (const bundleSubmitResponse of results) {


        if ('error' in bundleSubmitResponse) {
          console.log(`bundleSubmitResponse Error: ${bundleSubmitResponse.error.message}`);
          return;
        }

        const bundleResolution = await bundleSubmitResponse.wait()
        if (bundleResolution === FlashbotsBundleResolution.BundleIncluded) {
          console.log(`Congrats, included in targetBlock`)
        } else if (bundleResolution === FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
          console.log(`Not included in targetBlock`)
        } else if (bundleResolution === FlashbotsBundleResolution.AccountNonceTooHigh) {
          console.log("Nonce too high, bailing")
        }
      }






      */

    }

  }
}
