// @flow

import { bns } from 'biggystring'
import type { Disklet } from 'disklet'
import type {
  EdgeSpendInfo,
  EdgeSpendTarget,
  EdgeTransaction
} from 'edge-core-js/types'
import { InsufficientFundsError } from 'edge-core-js/types'

import { CurrencyEngine } from '../../engine/currencyEngine'
import { CurrencyEngineExtension } from '../../engine/currencyEngineExtension'
import { EngineState } from '../../engine/engineState'
import { EngineStateExtension } from '../../engine/engineStateExtension'
import { KeyManager } from '../../engine/keyManager'
import type { PluginIo } from '../../plugin/pluginIo'
import { getReceiveAddresses, sumUtxos } from '../../utils/coinUtils'
import type { TxOptions } from '../../utils/coinUtils.js'
import { logger } from '../../utils/logger'
import { getMintCommitmentsForValue } from './coinUtils'
import { type PrivateCoin, denominations, OP_SIGMA_MINT } from './flowTypes'
import { ZcoinStateExtension } from './zcoinStateExtension'

export class ZcoinEngineExtension implements CurrencyEngineExtension {
  currencyEngine: CurrencyEngine
  engineState: EngineState
  walletLocalEncryptedDisklet: Disklet
  keyManager: KeyManager
  io: PluginIo

  engineStateExtensions: EngineStateExtension
  zcoinStateExtensions: ZcoinStateExtension

  canRunLoop: boolean
  looperMethods: any

  constructor() {
    this.zcoinStateExtensions = new ZcoinStateExtension()
    this.engineStateExtensions = this.zcoinStateExtensions
  }

  async load(currencyEngine: CurrencyEngine) {
    logger.info('zcoinEngineExtension -> load called')

    this.currencyEngine = currencyEngine
    this.engineState = this.currencyEngine.engineState
    this.walletLocalEncryptedDisklet = this.currencyEngine.walletLocalEncryptedDisklet
    this.keyManager = this.currencyEngine.keyManager
    this.io = this.currencyEngine.io

    this.runLooperIfNeed()
  }

  onBalanceChanged() {
    logger.info('zcoinEngineExtension -> onBalanceChanged called')

    this.currencyEngine.callbacks.onBalanceChanged(
      this.currencyEngine.currencyCode,
      this.engineState.getBalance({ mintedBalance: true })
    )
  }

  async saveTx(edgeTransaction: EdgeTransaction) {
    logger.info('zcoinEngineExtension -> saveTx called')

    const { otherParams = {} } = edgeTransaction
    const { mintsForSave = [] } = otherParams

    await this.zcoinStateExtensions.appendMintedCoins(mintsForSave)
  }

  async loop() {
    logger.info('zcoinEngineExtension -> loop called')

    // TODO: can move into newTx
    const utxos = this.engineState.getUTXOs()
    const needToMint = sumUtxos(utxos)
    logger.info('zcoinEngineExtension -> Not minted balance: ' + needToMint)
    let needToMintStr = needToMint.toString()
    if (bns.gt(needToMintStr, denominations[0])) {
      if (
        bns.mul(bns.div(needToMintStr, denominations[0]), denominations[0]) ===
        needToMintStr
      ) {
        // can't mint all balance, because of fee
        needToMintStr = bns.sub(needToMintStr, denominations[0])
      }
      logger.info('zcoinEngineExtension -> Trying to mint: ' + needToMintStr)
      const edgeInfo: EdgeSpendInfo = {
        currencyCode: 'XZC',
        spendTargets: [
          {
            publicAddress: this.keyManager.getChangeAddress(),
            nativeAmount: needToMintStr
          }
        ]
      }
      // mint and getMintMetadataLoop must not work paralelly in order to avoid problems related to modifying mint.json parallely
      await this.mint(edgeInfo)
    }

    await this.getMintMetadataLoop()

    this.onBalanceChanged()
  }

  runLooperIfNeed() {
    this.canRunLoop = true
    this.addLooperMethodToLoop('loop', 60000)
  }

  cancelAllLooperMethods() {
    this.canRunLoop = false
    for (const looper in this.looperMethods) {
      clearTimeout(this.looperMethods[looper])
    }
  }

  async addLooperMethodToLoop(looperMethod: string, timer: number) {
    try {
      // $FlowFixMe
      await this[looperMethod]()
    } catch (e) {
      logger.error('Error in Loop:', looperMethod, e)
    }
    if (this.canRunLoop) {
      this.looperMethods[looperMethod] = setTimeout(() => {
        if (this.canRunLoop) {
          this.addLooperMethodToLoop('loop', timer)
        }
      }, timer)
    }
    return true
  }

  async mint(edgeSpendInfo: EdgeSpendInfo) {
    let tx = null
    let promise = null
    let tryAgain = true
    while (tryAgain) {
      tryAgain = false
      try {
        promise = this.makeMint(edgeSpendInfo)
        tx = await promise
      } catch (e) {
        logger.info('zcoinEngineExtension -> mint tx: Error ', e)
        if (e.message === 'InsufficientFundsError') {
          const amount = edgeSpendInfo.spendTargets[0].nativeAmount || '0'
          if (bns.gt(amount, denominations[0])) {
            edgeSpendInfo.spendTargets[0].nativeAmount = bns.sub(
              amount,
              denominations[0]
            )
            tryAgain = true
          } else {
            return
          }
        } else {
          return
        }
      }
    }
    if (tx == null) {
      return
    }

    try {
      promise = this.currencyEngine.signTx(tx)
      tx = await promise
      promise = this.currencyEngine.broadcastTx(tx)
      tx = await promise

      promise = this.currencyEngine.saveTx(tx)
      await promise
      logger.info('zcoinEngineExtension -> mint tx: ', tx)
    } catch (e) {
      logger.error('zcoinEngineExtension -> something went wrong ', e)
    }
  }

  async makeMint(
    edgeSpendInfo: EdgeSpendInfo,
    txOptions?: TxOptions = {}
  ): Promise<EdgeTransaction> {
    const { spendTargets } = edgeSpendInfo
    // Can't spend without outputs
    if (!txOptions.CPFP && (!spendTargets || spendTargets.length < 1)) {
      throw new Error('Need to provide Spend Targets')
    }
    // Calculate the total amount to send
    const totalAmountToSend = spendTargets.reduce(
      (sum, { nativeAmount }) => bns.add(sum, nativeAmount || '0'),
      '0'
    )

    // Try and get UTXOs from `txOptions`, if unsuccessful use our own utxo's
    const { utxos = this.engineState.getUTXOs() } = txOptions
    // Test if we have enough to spend
    if (bns.gt(totalAmountToSend, `${sumUtxos(utxos)}`)) {
      throw new InsufficientFundsError()
    }

    try {
      // Get the rate according to the latest fee
      const rate = this.currencyEngine.getRate(edgeSpendInfo)
      logger.info(`spend: Using fee rate ${rate} sat/K`)
      // Create outputs from spendTargets

      const currentMaxIndex = this.zcoinStateExtensions.getLastPrivateCoinIndex()

      const outputs = []
      let mints = []
      for (const spendTarget of spendTargets) {
        const {
          publicAddress: address,
          nativeAmount,
          otherParams: { script } = {}
        } = spendTarget
        const balance = nativeAmount || '0'

        mints = await getMintCommitmentsForValue(
          balance,
          this.currencyEngine.walletInfo.keys.dataKey,
          currentMaxIndex,
          this.io
        )
        mints.forEach(coin => {
          if (address && nativeAmount) {
            outputs.push({ address, value: coin.value })
          } else if (script) {
            outputs.push({ script, value: coin.value })
          }
        })

        mints.forEach(coin => {
          coin.groupId = -1
          coin.isSpend = false
          coin.spendTxId = ''
        })
      }

      const bcoinTx = await this.keyManager.createTX({
        outputs,
        utxos,
        rate,
        txOptions,
        height: this.currencyEngine.getBlockHeight(),
        io: this.io,
        walletInfo: this.currencyEngine.walletInfo
      })

      for (let i = 0; i < outputs.length; i++) {
        const privateCoin = mints[i]
        bcoinTx.outputs[i].address = null
        bcoinTx.outputs[i].script.fromRaw(
          Buffer.concat([
            Buffer.from(OP_SIGMA_MINT, 'hex'),
            Buffer.from(privateCoin.commitment, 'hex')
          ])
        )
      }

      const { scriptHashes } = this.engineState
      const sumOfTx = spendTargets.reduce(
        (s, { publicAddress, nativeAmount }: EdgeSpendTarget) =>
          publicAddress && scriptHashes[publicAddress]
            ? s
            : s - parseInt(nativeAmount),
        0
      )

      const addresses = getReceiveAddresses(
        bcoinTx,
        this.currencyEngine.network
      )

      const ourReceiveAddresses = addresses.filter(
        address => scriptHashes[address]
      )

      const edgeTransaction: EdgeTransaction = {
        ourReceiveAddresses,
        otherParams: {
          txJson: bcoinTx.getJSON(this.currencyEngine.network),
          edgeSpendInfo,
          rate,
          isSpend: false,
          mintsForSave: mints
        },
        currencyCode: this.currencyEngine.currencyCode,
        txid: '',
        date: 0,
        blockHeight: 0,
        nativeAmount: `${sumOfTx - parseInt(bcoinTx.getFee())}`,
        networkFee: `${bcoinTx.getFee()}`,
        signedTx: ''
      }
      return edgeTransaction
    } catch (e) {
      logger.error('mint tx: ', e)
      if (e.type === 'FundingError') throw new Error('InsufficientFundsError')
      throw e
    }
  }

  async getMintMetadataLoop() {
    logger.info('zcoinEngineExtension -> getMintMetadataLoop')

    // get saved mint data
    const mintData: PrivateCoin[] = this.zcoinStateExtensions.mintedCoins

    // process mints
    const mintsToRetrieve = []
    const mintsToUpdate = {}
    mintData.forEach(info => {
      if (info.commitment) {
        mintsToRetrieve.push({ denom: info.value, pubcoin: info.commitment })
        mintsToUpdate[info.commitment] = info
      }
    })

    if (mintsToRetrieve.length > 0) {
      const retrievedData = await this.zcoinStateExtensions.retrieveMintMetadata(
        mintsToRetrieve
      )
      retrievedData.forEach(data => {
        mintsToUpdate[data.pubcoin].groupId =
          this.currencyEngine.getBlockHeight() - data.height >= 5
            ? data.groupId
            : -1
      })
      await this.zcoinStateExtensions.writeMintedCoins(mintData)
    }
  }
}
