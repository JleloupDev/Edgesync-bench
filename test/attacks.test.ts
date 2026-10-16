// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Attack scenarios. Each one builds something SYNTACTICALLY VALID — a
// well-formed lie, signed with a real key — and asserts the protocol refuses it.
// A malformed frame proves nothing; the interesting question is always whether a
// correct-looking message from the wrong principal gets through.
//
// This file doubles as a regression suite: every assertion here is a property
// the protocol claims, and a failure means the claim stopped being true.
import { describe, it, expect } from 'vitest'
import {
  OwnIdentity, Access, ROOT_GROUP, keyPrincipal, resolveAccess, arbiterSet,
  randomBytes, resourceId, Keyring, signAclOp,
} from 'edgesync-protocol'
import { Adversary } from '../src/adversary'
import {
  VAULT, VAULT_ID, OWNERS, aclOp, makeSwarm, joiner, settle, foundVault,
} from '../src/harness'

/** A vault with the founder plus one admitted writer. */
async function vaultWithWriter() {
  const s = makeSwarm(1)
  await settle()
  const writer = s.members[0]
  s.founder.session.requestAclChange(ROOT_GROUP, [
    { t: 'set', principal: keyPrincipal(writer.identity.signPub), access: Access.Write },
  ])
  await settle()
  return { swarm: s, founder: s.founder, writer }
}

describe('attaques — autorité', () => {
  it("une époque signée par un non-arbitre est refusée", async () => {
    const { swarm, founder } = await vaultWithWriter()
    const before = founder.chain.height()

    const evil = new Adversary(swarm.bus)
    evil.send('founder', evil.hello(VAULT_ID))
    await settle()
    // Bien formée, correctement signée — mais pas par un arbitre.
    evil.send('founder', evil.forkAt(VAULT_ID, founder.chain))
    await settle()

    expect(founder.chain.height()).toBe(before)
    swarm.dispose()
  })

  it("un writer ne s'octroie rien, même avec une op parfaitement signée", async () => {
    const { swarm, founder, writer } = await vaultWithWriter()
    const complice = OwnIdentity.generate()

    writer.session.requestAclChange(ROOT_GROUP, [
      { t: 'set', principal: keyPrincipal(complice.signPub), access: Access.Read },
    ])
    await settle()

    expect(resolveAccess(founder.chain.state(), complice.signPub)).toBeUndefined()
    swarm.dispose()
  })

  it("un admin ne mint pas un admin — seul un owner le peut", async () => {
    const s = makeSwarm(1)
    await settle()
    const admin = s.members[0]
    s.founder.session.requestAclChange(ROOT_GROUP, [
      { t: 'set', principal: keyPrincipal(admin.identity.signPub), access: Access.Manage },
    ])
    await settle()
    expect(admin.access()).toBe(Access.Manage)

    // Cet admin, qui n'est pas owner, tente d'en fabriquer un autre.
    const cible = OwnIdentity.generate()
    admin.session.requestAclChange(ROOT_GROUP, [
      { t: 'set', principal: keyPrincipal(cible.signPub), access: Access.Manage },
    ])
    await settle()
    expect(resolveAccess(s.founder.chain.state(), cible.signPub)).toBeUndefined()

    // Mais il peut accorder strictement en dessous de lui.
    admin.session.requestAclChange(ROOT_GROUP, [
      { t: 'set', principal: keyPrincipal(cible.signPub), access: Access.Write },
    ])
    await settle()
    expect(resolveAccess(s.founder.chain.state(), cible.signPub)).toBe(Access.Write)
    s.dispose()
  })

  it("vider le groupe owners est refusé, même par un owner", async () => {
    const s = makeSwarm(0)
    await settle()
    s.founder.session.requestAclChange(OWNERS, [
      { t: 'remove', principal: keyPrincipal(s.founder.identity.signPub) },
    ])
    await settle()
    expect(s.founder.access()).toBe(Access.Manage) // toujours là
    expect(arbiterSet(s.founder.chain.state())).toHaveLength(1)
    s.dispose()
  })
})

describe('attaques — clés et chiffrement', () => {
  it("un révoqué ne lit plus ce qui s'écrit après lui", async () => {
    const { swarm, founder, writer } = await vaultWithWriter()
    founder.crdt.text().insert(0, 'avant')
    await settle()
    expect(writer.text()).toBe('avant')

    founder.session.requestAclChange(ROOT_GROUP, [
      { t: 'remove', principal: keyPrincipal(writer.identity.signPub) },
    ])
    await settle()

    founder.crdt.text().insert(5, ' apres')
    await settle()
    expect(founder.text()).toBe('avant apres')
    expect(writer.text()).toBe('avant') // il garde le passé, jamais la suite
    swarm.dispose()
  })

  it("un révoqué qui ré-écrit est ignoré", async () => {
    const { swarm, founder, writer } = await vaultWithWriter()
    founder.crdt.text().insert(0, 'base')
    await settle()

    founder.session.requestAclChange(ROOT_GROUP, [
      { t: 'remove', principal: keyPrincipal(writer.identity.signPub) },
    ])
    await settle()

    writer.crdt.text().insert(0, 'INTRUS ')
    await settle()
    expect(founder.text()).toBe('base')
    swarm.dispose()
  })

  it("une clé qui ne correspond pas à l'engagement de la chaîne est refusée", () => {
    const founder = OwnIdentity.generate()
    const { chain } = foundVault(founder)
    const kr = Keyring.empty()
    const commit = chain.keyCommitOf(chain.head())!
    expect(() => kr.adopt(chain.head(), randomBytes(32), commit)).toThrow(/commitment/)
    expect(kr.knownEpochs()).toHaveLength(0)
  })

  it("un KEY forgé par un non-membre n'est pas adopté", async () => {
    const s = makeSwarm(0)
    const outsider = joiner(s.bus, 'outsider')
    await settle()

    const evil = new Adversary(s.bus, 'evil')
    evil.send('outsider', evil.hello(VAULT_ID))
    await settle()
    evil.send('outsider', evil.forgeKey(
      VAULT, randomBytes(32), outsider.identity, randomBytes(32), VAULT_ID,
    ))
    await settle()

    expect(outsider.keyring.knownEpochs()).toHaveLength(0)
    s.dispose(); outsider.dispose()
  })
})

describe('attaques — format et rejeu', () => {
  it("une op signée pour un AUTRE vault n'a aucun effet (séparation de domaine)", async () => {
    const { swarm, founder } = await vaultWithWriter()
    const cible = OwnIdentity.generate()

    // Le cas dangereux : une op REJOUÉE depuis un autre vault. Le fondateur y a
    // les mêmes droits, l'op est authentiquement de lui, tout est bien formé —
    // seul le vaultId de la région signée diffère.
    const rejouee = signAclOp(
      resourceId('un-autre-vault'),
      { group: ROOT_GROUP, issuer: founder.identity.signPub, changes: [
        { t: 'set', principal: keyPrincipal(cible.signPub), access: Access.Manage },
      ] },
      (m) => founder.identity.sign(m),
    )
    const evil = new Adversary(swarm.bus, 'rejoueur')
    evil.send('founder', evil.request(rejouee))
    await settle(200)

    expect(resolveAccess(founder.chain.state(), cible.signPub)).toBeUndefined()

    // Contrôle : la MÊME op signée pour CE vault passe — donc c'est bien la
    // séparation de domaine qui a bloqué, et pas autre chose.
    const legitime = aclOp(founder.identity, ROOT_GROUP, [
      { t: 'set', principal: keyPrincipal(cible.signPub), access: Access.Write },
    ], founder.chain)
    evil.send('founder', evil.request(legitime))
    await settle(200)
    expect(resolveAccess(founder.chain.state(), cible.signPub)).toBe(Access.Write)

    swarm.dispose()
  })

  it("rejouer un frame capturé ne corrompt rien", async () => {
    const { swarm, founder, writer } = await vaultWithWriter()
    founder.crdt.text().insert(0, 'stable')
    await settle()
    const snapshot = writer.text()

    const evil = new Adversary(swarm.bus, 'replayer')
    // On rejoue TOUT ce qui a traversé le bus, dans l'ordre puis à l'envers.
    const all = swarm.bus.wire.slice()
    for (const f of all) evil.send('founder', f)
    for (const f of all.reverse()) evil.send('peer-0', f)
    await settle(300)

    expect(founder.text()).toBe('stable')
    expect(writer.text()).toBe(snapshot)
    swarm.dispose()
  })

  it("des frames aléatoires ne tuent aucune session", async () => {
    const { swarm, founder, writer } = await vaultWithWriter()
    const evil = new Adversary(swarm.bus, 'fuzzer')
    for (let i = 0; i < 200; i++) {
      const junk = randomBytes(1 + Math.floor(Math.random() * 64))
      junk[0] = 1 + Math.floor(Math.random() * 11) // un type de message plausible
      evil.send('founder', junk)
      evil.send('peer-0', junk)
    }
    await settle(300)

    founder.crdt.text().insert(0, 'vivant')
    await settle()
    expect(writer.text()).toBe('vivant')
    swarm.dispose()
  })
})

describe('attaques — amplification', () => {
  it("un inconnu ne force AUCUNE époque, quel que soit le nombre de demandes", async () => {
    const { swarm, founder } = await vaultWithWriter()
    const avant = founder.chain.height()

    // Des demandes parfaitement signees, mais par quelqu'un qui n'a aucun droit.
    // Chacune produisait autrefois une epoque sans effet : une chaine que
    // n'importe qui pouvait faire enfler sans rien detenir.
    const evil = new Adversary(swarm.bus, 'amplificateur')
    for (let i = 0; i < 50; i++) {
      evil.send('founder', evil.request(aclOp(evil.identity, ROOT_GROUP, [
        { t: 'set', principal: keyPrincipal(OwnIdentity.generate().signPub), access: Access.Read },
      ])))
    }
    await settle(400)

    expect(founder.chain.height()).toBe(avant)
    swarm.dispose()
  })
})

describe('attaques — le fork', () => {
  it("une branche rivale à la même hauteur ne détourne pas la chaîne", async () => {
    const { swarm, founder, writer } = await vaultWithWriter()
    const honest = founder.chain.head()

    // Un adversaire admis comme writer, donc épinglé et légitime au sens TOFU,
    // tente une époque concurrente à la même hauteur.
    const evil = new Adversary(swarm.bus, 'forker', writer.identity)
    evil.send('founder', evil.forkAt(VAULT_ID, founder.chain))
    evil.send('peer-0', evil.forkAt(VAULT_ID, founder.chain))
    await settle(200)

    expect(founder.chain.head()).toEqual(honest)
    swarm.dispose()
  })
})
