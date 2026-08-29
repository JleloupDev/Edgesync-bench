// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ce que le protocole coûte quand le réseau grossit. Chaque mesure répond à une
// question qu'on s'est posée en concevant, et qui était restée « à modéliser ».
import {
  Access, ROOT_GROUP, keyPrincipal, resolveAccess, encodeEpoch, OwnIdentity,
} from 'edgesync-protocol'
import { makeSwarm, measure, report, settle, type Measurement } from '../src/harness'

const N = Number(process.env.PEERS ?? 12)

async function admissionUneParUne(): Promise<Measurement> {
  const s = makeSwarm(N)
  await settle(150)
  const m = await measure(s.bus, `admission ×${N}, une op chacune`, async () => {
    for (const p of s.members) {
      s.founder.session.requestAclChange(ROOT_GROUP, [
        { t: 'set', principal: keyPrincipal(p.identity.signPub), access: Access.Write },
      ])
      await settle(25)
    }
  }, 400)
  const admis = s.members.filter((p) => p.access() === Access.Write).length
  console.log(`   → ${admis}/${N} admis, chaîne à la hauteur ${s.founder.chain.height()}`)
  s.dispose()
  return m
}

async function admissionEnUnLot(): Promise<Measurement> {
  const s = makeSwarm(N)
  await settle(150)
  const m = await measure(s.bus, `admission ×${N}, UN seul lot (D35)`, async () => {
    s.founder.session.requestAclChange(
      ROOT_GROUP,
      s.members.map((p) => ({ t: 'set' as const, principal: keyPrincipal(p.identity.signPub), access: Access.Write })),
    )
  }, 400)
  const admis = s.members.filter((p) => p.access() === Access.Write).length
  console.log(`   → ${admis}/${N} admis, chaîne à la hauteur ${s.founder.chain.height()}`)
  s.dispose()
  return m
}

async function revocation(): Promise<Measurement> {
  const s = makeSwarm(N)
  await settle(150)
  s.founder.session.requestAclChange(
    ROOT_GROUP,
    s.members.map((p) => ({ t: 'set' as const, principal: keyPrincipal(p.identity.signPub), access: Access.Write })),
  )
  await settle(400)

  const cible = s.members[0]
  const m = await measure(s.bus, `révocation d'un membre parmi ${N}`, () => {
    s.founder.session.requestAclChange(ROOT_GROUP, [
      { t: 'remove', principal: keyPrincipal(cible.identity.signPub) },
    ])
  }, 400)

  const encore = resolveAccess(s.founder.chain.state(), cible.identity.signPub)
  const reKeyes = s.members.slice(1).filter((p) => p.keyring.knownEpochs().length >= 2).length
  console.log(`   → cible: ${encore ?? 'dehors'} · ${reKeyes}/${N - 1} survivants re-clés`)
  s.dispose()
  return m
}

async function croissanceDeLaChaine(): Promise<void> {
  const s = makeSwarm(0)
  await settle(100)
  const points: { ops: number; octets: number }[] = []
  for (let i = 1; i <= 60; i++) {
    s.founder.session.requestAclChange(ROOT_GROUP, [
      { t: 'set', principal: keyPrincipal(OwnIdentity.generate().signPub), access: Access.Read },
    ])
    if (i % 20 === 0) {
      let octets = 0
      for (const e of s.founder.chain.all()) octets += encodeEpoch(e).length
      points.push({ ops: i, octets })
    }
  }
  console.log('\ncroissance de la chaîne (une op par époque, le pire cas)')
  for (const p of points) {
    const parAn = Math.round((p.octets / p.ops) * 30 * 365 / 1024)
    console.log(`   ${String(p.ops).padStart(3)} époques  ${String(p.octets).padStart(7)} o` +
      `   → ${parAn} Kio/an à 30 changements/jour`)
  }
  s.dispose()
}

async function rattrapage(): Promise<Measurement> {
  const s = makeSwarm(0)
  await settle(100)
  for (let i = 0; i < 40; i++) {
    s.founder.session.requestAclChange(ROOT_GROUP, [
      { t: 'set', principal: keyPrincipal(OwnIdentity.generate().signPub), access: Access.Read },
    ])
  }
  await settle(200)

  const { joiner } = await import('../src/harness')
  const tardif = joiner(s.bus, 'tardif')
  const m = await measure(s.bus, `rattrapage de ${s.founder.chain.height()} époques`, async () => {
    await settle(200)
    s.founder.session.requestAclChange(ROOT_GROUP, [
      { t: 'set', principal: keyPrincipal(tardif.identity.signPub), access: Access.Write },
    ])
  }, 400)
  console.log(`   → hauteur atteinte ${tardif.chain.height()}, accès ${tardif.access()}`)
  s.dispose(); tardif.dispose()
  return m
}

export async function run(): Promise<void> {
  console.log(`\n═══ ÉCHELLE — ${N} pairs ═══`)
  const rows: Measurement[] = []
  rows.push(await admissionUneParUne())
  rows.push(await admissionEnUnLot())
  rows.push(await revocation())
  rows.push(await rattrapage())
  report(rows)
  await croissanceDeLaChaine()
}

if (import.meta.url === `file://${process.argv[1]}`) run()
