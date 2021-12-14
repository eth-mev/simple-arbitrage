import { BigNumber, Wallet } from "ethers";
import fs from 'fs';
import util from 'util';

export const ETHER = BigNumber.from(10).pow(18);

export function bigNumberToDecimal(value: BigNumber, base = 18): number {
  const divisor = BigNumber.from(10).pow(base)
  return value.mul(10000).div(divisor).toNumber() / 10000
}

export function getDefaultRelaySigningKey(): string {
  console.warn("You have not specified an explicity FLASHBOTS_RELAY_SIGNING_KEY environment variable. Creating random signing key, this searcher will not be building a reputation for next run")
  return Wallet.createRandom().privateKey;
}



const log_file_path = __dirname + '/../note/status.log';
const log_file = fs.createWriteStream(log_file_path, {flags : 'a'});

export const logStatus = {
  applicationStart: "Starting...",
  newSearch: "Found new search: ",
  getMarketPairsStart: "Getting All Market pairs...",
  getMarketPairsEnd: "Done All Market pairs.",
  estimateSuccess: "Estimate gas success!!!!!!",
  estimateFail: "Estimate gas failure for %s",
}

export function log(str: string, status: string): void {
  const _str = str || "";
  const now = new Date();

  const logStr = `${now.toString()} ${util.format(status, _str)}\n`

  log_file.write(logStr);
  // console.log(logStr);
};
