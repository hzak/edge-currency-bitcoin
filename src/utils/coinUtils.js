// @flow

import {
  hd,
  network as Network,
  networks,
  primitives,
  script,
  utils
} from 'bcoin'
import { Buffer } from 'buffer'

import { type EngineState } from '../engine/engineState.js'
import { logger } from '../utils/logger.js'
import { toNewFormat } from './addressFormat.js'
import {
  hash256,
  hash256Sync,
  reverseBufferToHex,
  secp256k1Sign
} from './utils.js'

const RBF_SEQUENCE_NUM = 0xffffffff - 2
const MESSAGE_HEADER = Buffer.from('\x18Bitcoin Signed Message:\n', 'utf8')

export type RawTx = string
export type BlockHeight = number
export type Txid = string

export type Script = {
  type: string,
  params?: Array<string>
}

export type Output = {
  address?: string,
  script?: Script,
  value: number
}

export type StandardOutput = {
  address: string,
  value: number
}

export type Utxo = {
  tx: any,
  index: number,
  height?: BlockHeight
}

export type TxOptions = {
  utxos?: Array<Utxo>,
  setRBF?: boolean,
  RBFraw?: RawTx,
  CPFP?: Txid,
  CPFPlimit?: number,
  selection?: string,
  subtractFee?: boolean
}

export type CreateTxOptions = {
  utxos: Array<Utxo>,
  rate: number,
  changeAddress: string,
  network: string,
  outputs?: Array<StandardOutput>,
  height?: BlockHeight,
  estimate?: Function,
  txOptions: TxOptions
}

export const createBitcoinMessageSigHash = (message: string): Buffer => {
  // Convert the length to a little endian varint:
  const messageBytes = Buffer.from(message, 'utf8')
  const l = messageBytes.length
  const msgBufLength =
    l < 0xfd
      ? Buffer.from([l])
      : l <= 0xffff
      ? Buffer.from([0xfd, l, l >> 8])
      : Buffer.from([0xfe, l, l >> 8, l >> 16, l >> 24])

  const payload = Buffer.concat([MESSAGE_HEADER, msgBufLength, messageBytes])
  const sigHash = hash256Sync(hash256Sync(payload))
  return sigHash
}

export const signBitcoinMessage = async (
  message: Buffer,
  key: Object
): Promise<string> => {
  const privateKey = key.privateKey
  const publicKey = key.getPublicKey()
  const sigHash = createBitcoinMessageSigHash(message)
  const { signature, recovery } = await secp256k1Sign(sigHash, privateKey)
  const compressed =
    publicKey.length === 33 && (publicKey[0] === 0x02 || publicKey[0] === 0x03)
  const recId = 27 + (compressed && 4) + recovery
  const recIdBuff = Buffer.alloc(1, recId)
  const signedMessage = Buffer.concat([recIdBuff, signature])
  const signedMessage64 = signedMessage.toString('base64')
  return signedMessage64
}

export const isCompressed = (key: any): boolean =>
  Buffer.isBuffer(key) &&
  key.length === 33 &&
  (key[0] === 0x02 || key[0] === 0x03)

export const keysFromEntropy = (
  entropy: Buffer,
  network: string,
  opts: any = {}
) => {
  const { formats = [], keyPrefix = {} } = networks[network] || {}
  return {
    [`${network}Key`]: hd.Mnemonic.fromEntropy(entropy).getPhrase(),
    format: opts.format || formats[0] || 'bip44',
    coinType: opts.coinType || keyPrefix.coinType || 0
  }
}

export const verifyWIF = (data: any, network: string) => {
  const base58 = utils.base58
  const { serializers = {} } = networks[network] || {}
  if (serializers.wif) data = serializers.wif.decode(data)
  const br = new utils.BufferReader(base58.decode(data), true)
  const version = br.readU8() // TODO make sure it can handle different version lengths
  network = Network.fromWIF(version, network)
  br.readBytes(32)
  if (br.left() > 4 && br.readU8() !== 1) {
    throw new Error('Bad compression flag.')
  }
  br.verifyChecksum()
  return true
}

export const verifyUriProtocol = (
  protocol: string | null,
  network: string,
  pluginId: string
) => {
  const { uriPrefix = '' } = networks[network] || {}
  if (protocol) {
    const prot = protocol.replace(':', '').toLowerCase()
    return prot === pluginId || prot === uriPrefix
  }
  return true
}

export const setKeyType = async (
  key: any,
  nested: boolean,
  witness: boolean,
  network: string,
  redeemScript?: string
): Promise<any> => {
  let keyRing = {}
  if (redeemScript) {
    nested = false
    witness = false
    keyRing = await primitives.KeyRing.fromScript(
      key.privateKey || key.publicKey,
      script.fromRaw(Buffer.from(redeemScript.replace(/^0x/, ''), 'hex')),
      isCompressed(key.publicKey),
      network
    )
  } else {
    keyRing = await primitives.KeyRing.fromKey(
      key.privateKey || key.publicKey,
      isCompressed(key.publicKey),
      network
    )
  }

  Object.assign(keyRing, { nested, witness, network: Network.get(network) })
  return keyRing
}

export const createTX = async ({
  utxos,
  outputs = [],
  changeAddress,
  rate,
  height = -1,
  estimate,
  network,
  txOptions: {
    selection = 'value',
    RBFraw = '',
    CPFP = '',
    CPFPlimit = 1,
    subtractFee = false,
    setRBF = false
  }
}: CreateTxOptions) => {
  // Convert an address to the correct format that bcoin supports
  const toBcoinFormat = (address: string, network: string): string => {
    try {
      const { serializers = {} } = networks[network] || {}
      if (serializers.address) address = serializers.address.decode(address)
      else address = toNewFormat(address, network)
    } catch (e) {}
    return primitives.Address.fromString(address, network)
  }

  // Create the Mutable Transaction
  const mtx = new primitives.MTX()

  // Check for CPFP condition
  if (CPFP !== '') {
    utxos = utxos.filter(({ tx }) => tx.txid() === CPFP)
    // If not outputs are given try and build the most efficient TX
    if (!mtx.outputs || mtx.outputs.length === 0) {
      // Sort the UTXOs by size
      utxos = utxos.sort(
        (a, b) =>
          parseInt(b.tx.outputs[b.index]) - parseInt(a.tx.outputs[a.index])
      )
      // Try and get only the biggest UTXO unless the limit is 0 which means take all
      if (CPFPlimit) utxos = utxos.slice(0, CPFPlimit)
      // CPFP transactions will try to not have change
      // by subtracting moving all the value from the UTXOs
      // and subtracting the fee from the total output value
      const value = sumUtxos(utxos)
      subtractFee = true
      // CPFP transactions will add the change address as a single output
      outputs.push({ address: changeAddress, value })
    }
  }

  if (outputs.length === 0) {
    throw new Error('No outputs available.')
  }

  // Add the outputs
  outputs.forEach(({ address, value }) => {
    const bcoinAddress = toBcoinFormat(address, network)
    const addressScript = script.fromAddress(bcoinAddress)
    mtx.addOutput(addressScript, value)
  })

  // Create coins
  const coins = utxos.map(({ tx, index, height }) => {
    const coin = primitives.Coin.fromTX(tx, index, height)
    const { serializers = {} } = networks[network] || {}
    if (serializers.txHash) {
      coin.hash = serializers.txHash(tx.toNormal().toString('hex'))
    }
    return coin
  })

  // Try to fund the transaction
  await mtx.fund(coins, {
    selection,
    changeAddress: toBcoinFormat(changeAddress, network),
    subtractFee,
    height,
    rate,
    estimate
  })

  // If TX is RBF mark is by changing the Inputs sequences
  if (setRBF) {
    for (const input of mtx.inputs) {
      input.sequence = RBF_SEQUENCE_NUM
    }
  }

  // Check consensus rules for inputs
  if (height !== -1 && !mtx.verifyInputs(height)) {
    throw new Error('TX failed context check.')
  }

  return mtx
}

export const getPrivateFromSeed = async (seed: string, network: string) => {
  try {
    const mnemonic = hd.Mnemonic.fromPhrase(seed)
    return hd.PrivateKey.fromMnemonic(mnemonic, network)
  } catch (e) {
    logger.error('Not a mnemonic, treating the seed as base64')
    return hd.PrivateKey.fromSeed(Buffer.from(seed, 'base64'), network)
  }
}

export const addressToScriptHash = (
  address: string,
  network: string
): Promise<string> => {
  const addressObj = primitives.Address.fromString(address, network)
  return Promise.resolve(script.fromAddress(addressObj).toRaw())
    .then(scriptRaw => hash256(scriptRaw))
    .then(scriptHashRaw => reverseBufferToHex(scriptHashRaw))
}

export const verifyTxAmount = (
  rawTx: string,
  bcoinTx: any = primitives.TX.fromRaw(rawTx, 'hex')
) =>
  filterOutputs(bcoinTx.outputs).find(({ value }) => parseInt(value) <= 0)
    ? false
    : bcoinTx

export const parseTransaction = (
  rawTx: string,
  bcoinTx: any = primitives.TX.fromRaw(rawTx, 'hex')
) =>
  !bcoinTx.outputs.forEach(output => {
    output.scriptHash = reverseBufferToHex(hash256Sync(output.script.toRaw()))
  }) && bcoinTx

// Creates a Bcoin Transaction instance from a static JSON object
export const parseJsonTransaction = (txJson: Object): Object => {
  // Create a bcoin transaction instance. At this stage it WON'T contain the utxo information for the inputs
  const bcoinTx = primitives.MTX.fromJSON(txJson)
  // Import all the 'coins' (utxos) from txJson
  for (const input of txJson.inputs) {
    // Create a bcoin Coin Object from the input's coin and prevout
    const opts = Object.assign({}, input.coin, input.prevout)
    const bcoinCoin = primitives.Coin.fromJSON(opts)
    // Add the `Coin` (UTXO) to the transaction's view (where a bcoin TX/MTX Object keeps it's `Coins`)
    bcoinTx.view.addCoin(bcoinCoin)
  }
  return bcoinTx
}

export const parsePath = (
  path: string = '',
  masterPath: string
): Array<number> =>
  (path.split(`${masterPath}`)[1] || '')
    .split('/')
    .filter(i => i !== '')
    .map(i => parseInt(i))

export const sumUtxos = (utxos: Array<Utxo>) =>
  utxos.reduce((s, { tx, index }) => s + parseInt(tx.outputs[index].value), 0)

export const getLock = () => new utils.Lock()

export const getForksForNetwork = (network: string) =>
  networks[network] && networks[network].forks ? networks[network].forks : []

export const getFromatsForNetwork = (network: string) =>
  networks[network] ? networks[network].formats : []

export const addressFromKey = async (
  key: any,
  network: string
): Promise<{ address: string, scriptHash: string }> => {
  const { serializers = {} } = networks[network] || {}
  const standardAddress = key.getAddress().toString()
  let address = standardAddress
  if (serializers.address) address = serializers.address.encode(address)
  const scriptHash = await addressToScriptHash(standardAddress, network)
  return {
    address,
    scriptHash
  }
}

export const sumTransaction = (
  bcoinTransaction: any,
  network: string,
  engineState: EngineState
) => {
  const ourReceiveAddresses = []
  let totalOutputAmount = 0
  let totalInputAmount = 0
  let nativeAmount = 0
  let address = ''
  let value = 0
  let output = null
  let type = null

  // Process tx outputs
  const outputsLength = bcoinTransaction.outputs.length
  for (let i = 0; i < outputsLength; i++) {
    output = bcoinTransaction.outputs[i]
    type = output.getType()
    if (type === 'nonstandard' || type === 'nulldata') {
      continue
    }
    output = output.getJSON(network)
    value = output.value
    try {
      address = toNewFormat(output.address, network)
      const { serializers = {} } = networks[network] || {}
      address = serializers.address
        ? serializers.address.encode(address)
        : address
    } catch (e) {
      logger.error(e)
      if (value <= 0) {
        continue
      } else {
        address = ''
      }
    }
    totalOutputAmount += value
    if (engineState.scriptHashes[address]) {
      nativeAmount += value
      ourReceiveAddresses.push(address)
    }
  }

  let input = null
  let prevoutBcoinTX = null
  let index = 0
  let hash = ''
  // Process tx inputs
  const inputsLength = bcoinTransaction.inputs.length
  for (let i = 0; i < inputsLength; i++) {
    input = bcoinTransaction.inputs[i]
    if (input.prevout) {
      hash = input.prevout.rhash()
      index = input.prevout.index
      prevoutBcoinTX = engineState.parsedTxs[hash]
      if (prevoutBcoinTX) {
        output = prevoutBcoinTX.outputs[index].getJSON(network)
        value = output.value
        address = toNewFormat(output.address, network)
        const { serializers = {} } = networks[network] || {}
        address = serializers.address
          ? serializers.address.encode(address)
          : address
        totalInputAmount += value
        if (engineState.scriptHashes[address]) {
          nativeAmount -= value
        }
      }
    }
  }

  const fee = totalInputAmount ? totalInputAmount - totalOutputAmount : 0
  return { nativeAmount, fee, ourReceiveAddresses }
}

export const filterOutputs = (outputs: Array<any>): Array<any> =>
  outputs.filter(output => {
    const type = output.getType()
    return type !== 'nonstandard' && type !== 'nulldata'
  })

export const getReceiveAddresses = (
  bcoinTx: Object,
  network: string
): Array<string> =>
  filterOutputs(bcoinTx.outputs).map(output => {
    const address = output.getAddress().toString(network)
    return toNewFormat(address, network)
  })

export const bitcoinTimestampFromHeader = (header: Buffer): number => {
  if (header.length !== 80) {
    throw new Error(`Cannot interpret block header ${header.toString('hex')}`)
  }
  return header.readUInt32LE(4 + 32 + 32)
}
