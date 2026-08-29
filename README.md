<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- SPDX-FileCopyrightText: 2026 Jean Leloup -->

# EdgeSync-bench

Banc de stress et d'attaque pour [EdgeSync](../EdgeSync). Deux choses, et elles ne
servent pas au même usage :

- **`test/`** — des **scénarios d'attaque**, écrits comme des assertions. Chacun
  fabrique un mensonge *syntaxiquement valide* — bien formé, correctement signé par
  une vraie clé — et vérifie que le protocole le refuse. Un frame malformé ne prouve
  rien ; ce qu'il faut prouver, c'est qu'un message impeccable venant du mauvais
  principal ne passe pas.
- **`bench/`** — des **mesures**. Ce que coûte réellement une admission, une
  révocation, un rattrapage, à mesure que le réseau grossit.

Le banc utilise exclusivement la **surface publique** d'EdgeSync. Si un scénario a
besoin d'un accès interne, c'est un signal que la surface est mal découpée — pas une
raison d'aller chercher dedans.

## Ce que ce banc a déjà trouvé

Deux failles réelles, corrigées dans EdgeSync :

**L'arbitre ne vérifiait pas la signature des ops qu'il embarquait.** Une op signée
pour un *autre* vault, rejouée vers l'arbitre, entrait dans son état. Les autres
pairs la rejetaient bien à `validateEpoch` — mais l'arbitre, lui, était corrompu, et
continuait à miner à partir de là. Ordonner est son travail ; se porter garant du
contenu ne l'est pas.

**N'importe qui pouvait faire enfler la chaîne.** Une op correctement signée mais
non autorisée produisait quand même une époque — sans effet sur l'état, mais un
maillon bien réel. Soit une époque par demande, pour un attaquant qui ne détient
rien d'autre qu'une paire de clés. L'arbitre applique désormais chaque op **à blanc**
avant de la committer.

Les deux ont leur test de non-régression ici.

## Lancer

```bash
npm install
npm test                      # les scénarios d'attaque
npm run bench                 # toutes les mesures
PEERS=25 npm run bench:scale  # l'échelle, avec 25 pairs
FLOOD=1000 npm run bench:flood
```

## Mesures, à 10 pairs

| scénario | ms | frames | octets |
|---|---:|---:|---:|
| admission ×10, une op chacune | 4 361 | 2 435 | 336 950 |
| admission ×10, **un seul lot** | 1 270 | 650 | 106 070 |
| révocation d'un membre parmi 10 | 1 108 | 605 | 88 972 |
| rattrapage de 40 époques | 625 | 25 | 29 271 |

**Le lot vaut un facteur 3** sur le fil et sur le temps — c'est `D35` mesuré :
« je retire 1, 2, 3 puis j'enregistre » est une op, pas trois.

### ⚠️ La chaîne grossit plus vite que la spec ne le disait

```
20 époques    6 786 o
40 époques   13 026 o     ≈ 321 octets par époque
60 époques   19 266 o
```

À 30 changements de droits par jour, cela fait **~3,4 Mio par an**. La
spécification annonçait « moins d'un mégaoctet » pour quelques centaines de membres
sur plusieurs années : c'est optimiste d'un facteur 3 à 10. Non bloquant à l'échelle
visée, mais la question de l'élagage se posera plus tôt qu'écrit.

### A9 — l'inondation, toujours ouverte

Un inconnu ne crée plus aucune époque (0 sur 200). Mais **la vérification
elle-même reste un coût subi** : ~1,5 s de calcul pour 200 demandes qui ne mènent à
rien, à coût nul pour l'attaquant. Et un admin légitime peut faire enfler la chaîne
sans limite — aucune parade cryptographique, seulement de la détection et de
l'attribution.

## Structure

```
src/harness.ts     monter N pairs sur un bus, mesurer le fil
src/adversary.ts   un transport brut sans Session : forger n'importe quel frame
test/attacks.test  les scénarios d'attaque, en assertions
bench/scale.ts     admission, révocation, rattrapage, croissance
bench/flood.ts     A9, l'inondation de demandes
```

Le `Bus` d'EdgeSync enregistre chaque octet qui le traverse : « ce que ça a coûté sur
le fil » ne demande aucune instrumentation.

## Licence

AGPL-3.0-or-later.
