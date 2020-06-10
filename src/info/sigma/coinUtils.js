// @flow

import { bns } from 'biggystring'

import type { PluginIo } from '../../plugin/pluginIo'
import { logger } from '../../utils/logger'
import type { PrivateCoin } from './flowTypes'
import { denominations, SIGMA_COIN } from './flowTypes'

export type SpendCoin = {
  value: number,
  index: number,
  anonymitySet: string[],
  groupId: number,
  blockHash: string
}

const hexFromArray = (array: Buffer): string => {
  return Array.from(array, function(byte) {
    return ('0' + (byte & 0xff).toString(16)).slice(-2)
  }).join('')
}

export const createPrivateCoin = async (
  value: number,
  privateKey: string,
  index: number,
  io: PluginIo
): Promise<PrivateCoin> => {
  const { commitment, serialNumber } = await io.sigmaMint({
    denomination: value / SIGMA_COIN,
    privateKey: hexFromArray(Buffer.from(privateKey, 'base64')),
    index
  })
  return {
    value,
    index,
    commitment: commitment,
    serialNumber: serialNumber,
    groupId: 0,
    isSpend: false,
    spendTxId: ''
  }
}

export const getMintCommitmentsForValue = async (
  value: string,
  privateKey: string,
  currentIndex: number,
  io: PluginIo
) => {
  logger.info(
    'mint getMintCommitmentsForValue:',
    value,
    privateKey,
    currentIndex
  )
  const result: Array<PrivateCoin> = []
  for (let i = denominations.length - 1; i >= 0; i--) {
    const denom = denominations[i]

    while (bns.gte(value, denom)) {
      value = bns.sub(value, denom)
      currentIndex++
      const pCoin = await createPrivateCoin(
        parseInt(denom),
        privateKey,
        currentIndex,
        io
      )
      result.push(pCoin)
    }
  }

  return result
}
