// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// A9 — l'inondation de demandes d'ACL. Le protocole n'a AUCUNE limitation de
// débit : la spec la note comme « règle d'alerte à concevoir ». Ce banc est là
// pour montrer ce que ça coûte réellement, pas pour prouver que tout va bien.
//
// Deux inondations distinctes, parce qu'elles ne coûtent pas la même chose :
//   – depuis un ADMIN, dont chaque demande est valide et devient une époque ;
//   – depuis un INCONNU, dont chaque demande est rejetée au fold.
import { Access, ROOT_GROUP, keyPrincipal, OwnIdentity, encodeEpoch } from 'edgesync-protocol'
import { Adversary } from '../src/adversary'
import { aclOp, makeSwarm, measure, report, settle, type Measurement } from '../src/harness'

const N = Number(process.env.FLOOD ?? 300)

async function inondationParUnInconnu(): Promise<Measurement> {
  const s = makeSwarm(0)
  await settle(100)
  const avant = s.founder.chain.height()

  const evil = new Adversary(s.bus, 'inconnu')
  const m = await measure(s.bus, `${N} demandes d'un inconnu`, () => {
    for (let i = 0; i < N; i++) {
      const op = aclOp(evil.identity, ROOT_GROUP, [
        { t: 'set', principal: keyPrincipal(OwnIdentity.generate().signPub), access: Access.Manage },
      ])
      evil.send('founder', evil.request(op))
    }
  }, 600)

  const epoquesCreees = s.founder.chain.height() - avant
  console.log(`   → ${epoquesCreees} époque(s) créée(s) sur ${N} demandes`)
  console.log('     Chaque demande est VERIFIEE (signature, puis application a blanc)')
  console.log('     avant d\'entrer dans une epoque. Sans l\'essai a blanc, un inconnu')
  console.log('     forcait UNE EPOQUE PAR DEMANDE — trouvaille de ce banc.')
  console.log('     Reste : la verification elle-meme est un cout subi, sans cout')
  console.log('     pour l\'attaquant. C\'est A9, et il n\'est toujours pas traite.')
  s.dispose()
  return m
}

async function inondationParUnAdmin(): Promise<Measurement> {
  const s = makeSwarm(0)
  await settle(100)
  const avant = s.founder.chain.height()

  const m = await measure(s.bus, `${N} demandes d'un admin`, () => {
    for (let i = 0; i < N; i++) {
      s.founder.session.requestAclChange(ROOT_GROUP, [
        { t: 'set', principal: keyPrincipal(OwnIdentity.generate().signPub), access: Access.Read },
      ])
    }
  }, 600)

  let octets = 0
  for (const e of s.founder.chain.all()) octets += encodeEpoch(e).length
  console.log(`   → ${s.founder.chain.height() - avant} époques créées, chaîne à ${(octets / 1024).toFixed(1)} Kio`)
  console.log('     Un admin légitime peut faire enfler la chaîne sans limite.')
  console.log('     Pas de parade cryptographique : détection et attribution seulement.')
  s.dispose()
  return m
}

export async function run(): Promise<void> {
  console.log(`\n═══ INONDATION — ${N} demandes ═══`)
  const rows: Measurement[] = []
  rows.push(await inondationParUnInconnu())
  rows.push(await inondationParUnAdmin())
  report(rows)
}

if (import.meta.url === `file://${process.argv[1]}`) run()
