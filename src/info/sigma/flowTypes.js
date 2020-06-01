// @flow

export const SIGMA_ENCRYPTED_FILE = 'mint.json'
export const RESTORE_FILE = 'restore.json'
export const OP_SIGMA_MINT = 'c3'
export const OP_SIGMA_SPEND = 'c4'

export const SIGMA_COIN = 100000000

export const denominations = [
  '5000000',
  '10000000',
  '50000000',
  '100000000',
  '1000000000',
  '2500000000',
  '10000000000'
]

export type PrivateCoin = {
  value: number,
  index: number,
  commitment: string,
  serialNumber: string,
  groupId: number,
  isSpend: boolean,
  spendTxId: string
}
