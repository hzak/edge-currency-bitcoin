// @flow

import { crypto, utils } from 'bcoin'
import bs58grscheck from 'bs58grscheck'
import { Buffer } from 'buffer'
import { type EdgeCurrencyInfo } from 'edge-core-js/types'

import type { EngineCurrencyInfo } from '../engine/currencyEngine.js'
import type { BcoinCurrencyInfo } from '../utils/bcoinExtender/bcoinExtender.js'
import { imageServerUrl } from './constants.js'

const isBech32 = address => {
  try {
    const hrp = utils.bech32.decode(address).hrp
    return hrp === bcoinInfo.addressPrefix.bech32
  } catch (e) {
    return false
  }
}

const base58 = {
  decode: (address: string) => {
    if (isBech32(address)) return address
    const payload = bs58grscheck.decode(address)
    const bw = new utils.StaticWriter(payload.length + 4)
    bw.writeBytes(payload)
    bw.writeChecksum()
    return utils.base58.encode(bw.render())
  },
  encode: (address: string) => {
    if (isBech32(address)) return address
    const payload = utils.base58.decode(address)
    return bs58grscheck.encode(payload.slice(0, -4))
  }
}

const sha256 = (rawTx: string) => {
  const buf = Buffer.from(rawTx, 'hex')
  return crypto.digest.sha256(buf)
}

const bcoinInfo: BcoinCurrencyInfo = {
  type: 'groestlcoin',
  magic: 0xf9beb4d4,
  formats: ['bip49', 'bip84', 'bip44', 'bip32'],
  keyPrefix: {
    privkey: 0x80,
    xpubkey: 0x0488b21e,
    xprivkey: 0x0488ade4,
    xpubkey58: 'xpub',
    xprivkey58: 'xprv',
    coinType: 17
  },
  addressPrefix: {
    pubkeyhash: 0x24,
    scripthash: 0x05,
    bech32: 'grs'
  },
  serializers: {
    address: base58,
    wif: base58,
    txHash: (rawTx: string) => sha256(rawTx).toString('hex'),
    signatureHash: sha256
  }
}

const engineInfo: EngineCurrencyInfo = {
  network: 'groestlcoin',
  currencyCode: 'GRS',
  gapLimit: 10,
  defaultFee: 100000,
  feeUpdateInterval: 60000,
  customFeeSettings: ['satPerByte'],
  simpleFeeSettings: {
    highFee: '150',
    lowFee: '20',
    standardFeeLow: '50',
    standardFeeHigh: '100',
    standardFeeLowAmount: '173200',
    standardFeeHighAmount: '8670000'
  }
}

const currencyInfo: EdgeCurrencyInfo = {
  // Basic currency information:
  currencyCode: 'GRS',
  displayName: 'Groestlcoin',
  pluginId: 'groestlcoin',
  denominations: [
    { name: 'GRS', multiplier: '100000000', symbol: 'G' },
    { name: 'mGRS', multiplier: '100000', symbol: 'mG' }
  ],
  walletType: 'wallet:groestlcoin',

  // Configuration options:
  defaultSettings: {
    customFeeSettings: ['satPerByte'],
    electrumServers: [
      'electrum://electrum32.groestlcoin.org:50001',
      'electrum://electrum16.groestlcoin.org:50001',
      'electrum://electrum29.groestlcoin.org:50001',
      'electrum://electrum14.groestlcoin.org:50001',
      'electrum://electrum3.groestlcoin.org:50001',
      'electrum://electrum24.groestlcoin.org:50001',
      'electrum://electrum12.groestlcoin.org:50001',
      'electrum://electrum40.groestlcoin.org:50001',
      'electrums://electrum4.groestlcoin.org:50002',
      'electrums://electrum33.groestlcoin.org:50002',
      'electrums://electrum39.groestlcoin.org:50002',
      'electrums://electrum36.groestlcoin.org:50002',
      'electrums://electrum20.groestlcoin.org:50002',
      'electrums://electrum7.groestlcoin.org:50002',
      'electrums://electrum19.groestlcoin.org:50002'
    ],
    disableFetchingServers: true
  },
  metaTokens: [],

  // Explorers:
  blockExplorer: 'https://blockchair.com/groestlcoin/block/%s',
  addressExplorer: 'https://blockchair.com/groestlcoin/address/%s',
  transactionExplorer: 'https://blockchair.com/groestlcoin/transaction/%s',

  // Images:
  symbolImage: `${imageServerUrl}/groestlcoin-logo-solo-64.png`,
  symbolImageDarkMono: `${imageServerUrl}/groestlcoin-logo-solo-64.png`
}

export const groestlcoin = { bcoinInfo, engineInfo, currencyInfo }
