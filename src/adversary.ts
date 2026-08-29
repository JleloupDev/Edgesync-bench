// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Adversarial primitives: a raw transport with no Session behind it, able to
// forge any frame the protocol accepts. This is what an attacker actually has —
// the wire format and a keypair, nothing more.
//
// Every helper here builds something SYNTACTICALLY valid. A malformed frame
// proves nothing; what has to be proven is that a well-formed lie is refused.
import {
  OwnIdentity, InProcessTransport, Bus, Keyring, AclChain,
  encrypt, seal, signedRegion, encodeEnvelope, concat, randomBytes,
  signEpoch, epochId, encodeEpochPush, encodeAclRequest, encodeKey,
  frame, MsgType,
  type AclOp, type Epoch,
} from 'edgesync-protocol'

export class Adversary {
  readonly identity: OwnIdentity
  private readonly transport: InProcessTransport

  constructor(bus: Bus, id = 'adversary', identity = OwnIdentity.generate()) {
    this.identity = identity
    this.transport = new InProcessTransport(id, bus)
    this.transport.connect()
  }

  send(to: string, bytes: Uint8Array): void {
    this.transport.send(to, bytes)
  }

  /** A HELLO that passes the handshake — the cheapest way to get pinned. */
  hello(vaultId: Uint8Array): Uint8Array {
    const nonce = randomBytes(24)
    const transcript = concat(new Uint8Array([1]), this.identity.signPub, this.identity.boxPub, vaultId, nonce)
    return frame(MsgType.Hello, encodeHelloRaw({
      signPub: this.identity.signPub, boxPub: this.identity.boxPub, nonce,
      sig: this.identity.sign(transcript),
    }))
  }

  /** An epoch signed by whoever we are — valid bytes, possibly no authority. */
  forgeEpoch(vaultId: Uint8Array, draft: Omit<Epoch, 'sigs'>): Uint8Array {
    const e = signEpoch(vaultId, draft, this.identity.signPub, (m) => this.identity.sign(m))
    return frame(MsgType.EpochPush, encodeEpochPush(e))
  }

  /** A rival epoch at the SAME height as an existing one — an attempted fork. */
  forkAt(vaultId: Uint8Array, chain: AclChain, ops: AclOp[] = []): Uint8Array {
    return this.forgeEpoch(vaultId, {
      prev: chain.head(), height: chain.height() + 1, round: 0, ops,
      keyCommit: undefined,
    })
  }

  /** A signed ACL request. Signed correctly; authorised or not is the question. */
  request(op: AclOp): Uint8Array {
    return frame(MsgType.AclRequest, encodeAclRequest(op))
  }

  /** A content op sealed under a key we somehow hold, signed by us. */
  forgeContentOp(resourceId: Uint8Array, position: Uint8Array, key: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const { nonce, ciphertext } = encrypt(key, plaintext)
    const sig = this.identity.sign(signedRegion(resourceId, position, nonce, ciphertext))
    return frame(MsgType.Op, encodeEnvelope({
      resourceId, epochId: position, nonce, ciphertext, sig, signerPub: this.identity.signPub,
    }))
  }

  /** A KEY grant we are not entitled to make. */
  forgeKey(resource: string, keyEpochId: Uint8Array, recipient: { signPub: Uint8Array; boxPub: Uint8Array }, vaultKey: Uint8Array, resourceId: Uint8Array): Uint8Array {
    const sealedVaultKey = seal(recipient.boxPub, vaultKey)
    const region = concat(resourceId, keyEpochId, recipient.signPub, sealedVaultKey)
    return frame(MsgType.Key, encodeKey({
      resource, keyEpochId, sealedVaultKey,
      grantorSignPub: this.identity.signPub, recipientSignPub: recipient.signPub,
      sig: this.identity.sign(region),
    }))
  }
}

/** Re-export of the wire encoder, kept local so the class body reads cleanly. */
function encodeHelloRaw(m: { signPub: Uint8Array; boxPub: Uint8Array; nonce: Uint8Array; sig: Uint8Array }): Uint8Array {
  return concat(m.signPub, m.boxPub, m.nonce, m.sig)
}

/** Everything an attacker would need to try replaying a captured frame. */
export function capture(bus: Bus, type: MsgType): Uint8Array[] {
  return bus.wire.filter((f) => f.length > 0 && f[0] === type)
}

export { Keyring, epochId }
