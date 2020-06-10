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
import { getMintsToSpend } from './coinOperations'
import {
  createPrivateCoin,
  createSpendTX,
  getMintCommitmentsForValue,
  parseJsonTransactionForSpend,
  signSpendTX,
  sumTransaction
} from './coinUtils'
import type { SpendCoin } from './coinUtils.js'
import type { PrivateCoin } from './flowTypes'
import { denominations, OP_SIGMA_MINT, RESTORE_FILE } from './flowTypes'
import { ZcoinStateExtension } from './zcoinStateExtension'

const MILLI_TO_SEC = 1000

export class ZcoinEngineExtension implements CurrencyEngineExtension {
  currencyEngine: CurrencyEngine
  engineState: EngineState
  walletLocalEncryptedDisklet: Disklet
  keyManager: KeyManager
  io: PluginIo

  engineStateExtensions: EngineStateExtension
  zcoinStateExtensions: ZcoinStateExtension
  savedSpendTransactionValues: { [key: string]: number }

  canRunLoop: boolean
  looperMethods: any

  constructor() {
    this.savedSpendTransactionValues = {}
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

  async resyncBlockchain() {
    window.setTimeout(() => {
      this.forceReloadSpendTransactions()
      this.zcoinStateExtensions.wakeUpConnections()
    }, 5000)
  }

  async killEngine() {
    this.cancelAllLooperMethods()
  }

  onTxFetched(txid: string) {
    logger.info(`zcoinEngineExtension -> onTxFetched called txId ${txid}`)
    if (txid in this.savedSpendTransactionValues) {
      const edgeTransaction = this.getSpendTransactionSync(
        txid,
        this.savedSpendTransactionValues[txid]
      )
      this.currencyEngine.callbacks.onTransactionsChanged([edgeTransaction])
    } else {
      const edgeTransaction = this.getSpendTransactionSync(
        txid,
        this.getSpendTransactionValues()[txid]
      )
      this.currencyEngine.callbacks.onTransactionsChanged([edgeTransaction])
    }
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

    const { otherParams = {}, txid = '' } = edgeTransaction
    const {
      mintsForSave = [],
      spendCoins = [],
      isSpend = false,
      value = 0
    } = otherParams

    await this.zcoinStateExtensions.appendMintedCoins(mintsForSave)
    await this.zcoinStateExtensions.updateSpendCoins(spendCoins, txid)
    if (isSpend) {
      this.savedSpendTransactionValues[txid] = value
    }
  }

  async loop() {
    logger.info('zcoinEngineExtension -> loop called')

    const restored = await this.restore()
    if (!restored) {
      return
    }

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
      await this.mint(edgeInfo)
    }

    await this.getMintMetadataLoop()

    this.onBalanceChanged()
  }

  async restore(): Promise<boolean> {
    logger.info('zcoinEngineExtension -> restore')

    try {
      const restoreJsonStr = await this.walletLocalEncryptedDisklet.getText(
        RESTORE_FILE
      )
      if (restoreJsonStr && JSON.parse(restoreJsonStr).restored) {
        return true
      }
    } catch (e) {
      logger.error('zcoinEngineExtension -> something went wrong', e)
    }

    const mintData: PrivateCoin[] = []

    let usedSerialNumbers = []
    const usedCoins = await this.zcoinStateExtensions.retrieveUsedCoinSerials()
    usedSerialNumbers = usedCoins.serials

    const latestCoinIds = await this.zcoinStateExtensions.retrieveLatestCoinIds()
    let commitmentCount = 0
    for (const coinInfo of latestCoinIds) {
      coinInfo.anonymitySet = []
      for (let i = 0; i < coinInfo.id; i++) {
        const anonimitySet = await this.zcoinStateExtensions.retrieveAnonymitySet(
          coinInfo.denom,
          i + 1
        )
        coinInfo.anonymitySet = coinInfo.anonymitySet.concat(
          anonimitySet.serializedCoins
        )
        commitmentCount += anonimitySet.serializedCoins.length
      }
    }

    let counter = 0
    let index = -1
    while (counter++ < 100 && index++ < commitmentCount) {
      // commitment is only dependant to private key and index, that's why coin value is hardcoded
      const coin = await createPrivateCoin(
        100000000,
        this.currencyEngine.walletInfo.keys.dataKey,
        index,
        this.io
      )
      logger.info('zcoinEngineExtension -> restore coin ', coin)
      const isSpend = usedSerialNumbers.includes(coin.serialNumber)
      for (const coinInfo of latestCoinIds) {
        if (coinInfo.anonymitySet.includes(coin.commitment)) {
          mintData.push({
            value: coinInfo.denom,
            index: index,
            commitment: coin.commitment,
            serialNumber: '',
            groupId: coinInfo.id,
            isSpend: isSpend,
            spendTxId: ''
          })
          counter = 0
          break
        }
      }
    }

    try {
      logger.info('zcoinEngineExtension -> restore try save ', mintData)
      await this.zcoinStateExtensions.writeMintedCoins(mintData)
      await this.walletLocalEncryptedDisklet.setText(
        RESTORE_FILE,
        JSON.stringify({ restored: true })
      )
      logger.info('zcoinEngineExtension -> restored')
    } catch (e) {
      return false
    }

    return true
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

  async makeSpend(
    edgeSpendInfo: EdgeSpendInfo,
    txOptions?: TxOptions = {}
  ): Promise<EdgeTransaction> {
    logger.info('zcoinEngineExtension -> makeSpend called')

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

    const mintData: PrivateCoin[] = this.zcoinStateExtensions.mintedCoins
    const currentMaxIndex = this.zcoinStateExtensions.getLastPrivateCoinIndex()
    logger.info('zcoinEngineExtension -> spend mintData = ', mintData)

    const approvedMints: PrivateCoin[] = []
    mintData.forEach(info => {
      if (info.groupId && info.groupId !== -1 && !info.isSpend) {
        approvedMints.push(info)
      }
    })

    // // Try and get UTXOs from `txOptions`, if unsuccessful use our own utxo's
    let { utxos = this.engineState.getUTXOs() } = txOptions
    utxos = JSON.parse(JSON.stringify(utxos))
    // // Test if we have enough to spend
    // if (bns.gt(totalAmountToSend, `${approvedMintedBalance}`)) {
    //   throw new InsufficientFundsError()
    // }

    const remainder = totalAmountToSend || '0'
    logger.info('zcoinEngineExtension -> spend remainder before ', remainder)
    const mintsToBeSpend: PrivateCoin[] = getMintsToSpend(
      approvedMints,
      remainder
    )
    logger.info('zcoinEngineExtension -> mintsToBeSpend', mintsToBeSpend)
    if (mintsToBeSpend.length === 0) {
      throw new Error('InsufficientFundsError')
    }

    const spendCoins: SpendCoin[] = []
    for (const info of mintsToBeSpend) {
      // const retrievedData = await this.engineState.retrieveAnonymitySet(info.value, info.groupId)
      // logger.info('zcoinEngineExtension -> retrieveAnonymitySet retrievedData', retrievedData)
      spendCoins.push({
        value: info.value,
        anonymitySet: [], // retrievedData.serializedCoins,
        blockHash: '1', // retrievedData.blockHash,
        index: info.index,
        groupId: info.groupId
      })
    }
    logger.info('zcoinEngineExtension -> mints to be spend', mintsToBeSpend)

    try {
      // Get the rate according to the latest fee
      const rate = this.currencyEngine.getRate(edgeSpendInfo)
      logger.info(`spend: Using fee rate ${rate} sat/K`)
      // Create outputs from spendTargets

      const mintBalance = parseInt(
        this.engineState.getBalance({ mintedBalance: true }),
        10
      )

      for (let i = 0; i < utxos.length; i++) {
        const len = utxos[i].tx.outputs.length
        utxos[i].tx.outputs[len - 1].value = mintBalance
      }

      const outputs = []
      for (const spendTarget of spendTargets) {
        const {
          publicAddress: address,
          nativeAmount,
          otherParams: { script } = {}
        } = spendTarget
        const value = parseInt(nativeAmount || '0')
        if (address && nativeAmount) outputs.push({ address, value })
        else if (script) outputs.push({ script, value })
      }

      const standardOutputs = await this.keyManager.convertToStandardOutputs(
        outputs
      )

      // TODO: remove mints: mintedInTx not need
      const {
        tx: bcoinTx,
        mints: mintedInTx,
        spendFee,
        value
      } = await createSpendTX({
        mints: spendCoins,
        outputs: standardOutputs,
        rate,
        txOptions,
        utxos,
        height: this.currencyEngine.getBlockHeight(),
        io: this.io,
        privateKey: this.currencyEngine.walletInfo.keys.dataKey,
        currentIndex: currentMaxIndex,
        changeAddress: this.keyManager.getChangeAddress(),
        estimate: prev => this.keyManager.fSelector.estimateSize(prev),
        network: this.keyManager.network
      })

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
          isSpend: true,
          mintedInTx,
          spendCoins,
          value,
          currentIndex: currentMaxIndex
        },
        currencyCode: this.currencyEngine.currencyCode,
        txid: '',
        date: 0,
        blockHeight: 0,
        nativeAmount: `${sumOfTx}`,
        networkFee: `${spendFee}`,
        signedTx: ''
      }

      logger.info('zcoinEngineExtension -> spend 2', edgeTransaction)
      return edgeTransaction
    } catch (e) {
      if (e.type === 'FundingError') throw new Error('InsufficientFundsError')
      throw e
    }
  }

  async signTx(edgeTransaction: EdgeTransaction): Promise<?EdgeTransaction> {
    const { isSpend = false } = edgeTransaction.otherParams || {}
    logger.info('zcoinEngineExtension -> signTx called is spend = ', isSpend)
    if (!isSpend) {
      return null
    }

    const { spendCoins, value, currentIndex, txJson } =
      edgeTransaction.otherParams || {}
    const spends: SpendCoin[] = []
    for (const info of spendCoins) {
      const retrievedData = await this.zcoinStateExtensions.retrieveAnonymitySet(
        info.value,
        info.groupId
      )
      // logger.info('zcoinEngineExtension -> retrieveAnonymitySet retrievedData', retrievedData)
      spends.push({
        value: info.value,
        anonymitySet: retrievedData.serializedCoins,
        blockHash: retrievedData.blockHash,
        index: info.index,
        groupId: info.groupId
      })
    }

    const bTx = parseJsonTransactionForSpend(txJson)
    logger.info('zcoinEngineExtension -> spend&mint: spend transaction', spends)

    const { signedTx, txid, mintsForSave } = await signSpendTX(
      bTx,
      value,
      currentIndex,
      this.currencyEngine.walletInfo.keys.dataKey,
      spends,
      this.io
    )

    logger.info('zcoinEngineExtension -> spend&mint retrievedData', signedTx)
    return {
      ...edgeTransaction,
      otherParams: {
        ...edgeTransaction.otherParams,
        mintsForSave,
        spendCoins: spends
      },
      signedTx,
      txid,
      date: Date.now() / MILLI_TO_SEC
    }
  }

  getTransactionSync(txid: string): EdgeTransaction {
    logger.info('zcoinEngineExtension -> getTransactionSync called')
    const spendTransactionValues = this.getSpendTransactionValues()
    return this.getSpendTransactionSync(txid, spendTransactionValues[txid])
  }

  getSpendTransactionSync(txid: string, spendValue: number): EdgeTransaction {
    const { height = -1, firstSeen = Date.now() / 1000 } =
      this.engineState.txHeightCache[txid] || {}
    let date = firstSeen
    // If confirmed, we will try and take the timestamp as the date
    if (height && height !== -1) {
      const blockHeight = this.currencyEngine.pluginState.headerCache[
        `${height}`
      ]
      if (blockHeight) {
        date = blockHeight.timestamp
      }
    }

    // Get parsed bcoin tx from engine
    const bcoinTransaction = this.engineState.parsedTxs[txid]
    if (!bcoinTransaction) {
      throw new Error('Transaction not found')
    }

    const {
      fee,
      ourReceiveAddresses,
      nativeAmount,
      isMint: isSpecialTransaction
    } = sumTransaction(
      bcoinTransaction,
      this.currencyEngine.network,
      this.engineState,
      spendValue
    )

    const sizes = bcoinTransaction.getSizes()
    const debugInfo = `Inputs: ${bcoinTransaction.inputs.length}\nOutputs: ${bcoinTransaction.outputs.length}\nSize: ${sizes.size}\nWitness: ${sizes.witness}`
    const edgeTransaction: EdgeTransaction = {
      ourReceiveAddresses,
      currencyCode: this.currencyEngine.currencyCode,
      otherParams: {
        debugInfo,
        isSpecialTransaction
      },
      txid: txid,
      date: date,
      blockHeight: height === -1 ? 0 : height,
      nativeAmount: `${nativeAmount}`,
      networkFee: `${fee}`,
      signedTx: this.engineState.txCache[txid]
    }
    return edgeTransaction
  }

  getSpendTransactionValues(): { [key: string]: number } {
    // Get existing spend transaction ids
    const spendTransactionValues = {}
    const mintData = this.zcoinStateExtensions.mintedCoins
    mintData.forEach(item => {
      if (item.spendTxId) {
        if (!(item.spendTxId in spendTransactionValues)) {
          spendTransactionValues[item.spendTxId] = 0
        }
        spendTransactionValues[item.spendTxId] += item.value
      }
    })

    return spendTransactionValues
  }

  forceReloadSpendTransactions() {
    this.zcoinStateExtensions.mintedCoins.forEach(item => {
      if (item.spendTxId) {
        this.zcoinStateExtensions.handleNewTxid(item.spendTxId, true)
      }
    })
  }
}
