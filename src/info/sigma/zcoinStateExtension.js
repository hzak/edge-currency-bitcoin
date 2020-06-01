// @flow

import type { Disklet } from 'disklet'

import { EngineState } from '../../engine/engineState'
import { EngineStateExtension } from '../../engine/engineStateExtension'

export type AnonymitySet = {
  blockHash: string,
  serializedCoins: string[]
}

export type UsedSerials = {
  serials: string[]
}

export type CoinGroup = {
  denom: number,
  id: number,
  anonymitySet: string[]
}

export type MintMetadata = {
  pubcoin: string,
  groupId: number,
  height: number
}

export class ZcoinStateExtension implements EngineStateExtension {
  engineState: EngineState
  encryptedLocalDisklet: Disklet

  setUp(engineState: EngineState) {
    this.engineState = engineState
    this.encryptedLocalDisklet = this.engineState.encryptedLocalDisklet
  }
}
