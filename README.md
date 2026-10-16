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
- **`lab/`** — le **laboratoire** : N pairs autonomes dans un terminal, un réseau
  qui perd et qui coupe, des byzantins, et des scénarios écrits en une ligne
  chacun. Tout sort d'une seule graine : un échec se rejoue.
- **`apps/`** — des **mini-applications** dans le navigateur. Dix fenêtres, dix
  pairs, un robot dans chacune : ce qu'on montre à quelqu'un.

Le banc utilise exclusivement la **surface publique** d'EdgeSync. Si un scénario a
besoin d'un accès interne, c'est un signal que la surface est mal découpée — pas une
raison d'aller chercher dedans.

## Ce que ce banc a déjà trouvé

### ⚠️ Rejouer une demande d'admission annule une révocation

Trouvée par tirage (graine 115108), réduite dans
[`lab/scenarios/rejeu-acl.txt`](lab/scenarios/rejeu-acl.txt). **Ouverte.**

Une `AclOp` porte `{group, changes, issuer, sig}` — et rien d'autre. Ni date, ni
position dans la chaîne, ni compteur. Elle est donc valable **pour toujours** :
la demande « admets p2 en écriture », signée par l'administrateur au moment où il
la voulait, reste une demande valide le lendemain, après que ce même
administrateur a révoqué p2.

N'importe qui peut la rejouer. Aucune clé n'est nécessaire : les ops voyagent en
clair dans les époques, et la chaîne est servie à qui la demande (D8). Il suffit
de la relire et de la renvoyer à l'arbitre, qui la vérifie — signature bonne,
émetteur autorisé — et la remet dans une époque.

```
h=4          par p0 : set(p1,Write) set(p2,Write) set(p4,Write)   ← la demande
h=5 ROTATION par p0 : remove(p4)                                  ← la révocation
h=6 ROTATION par p0 : remove(p1)
h=7          par p0 : set(p1,Write) set(p2,Write) set(p4,Write)   ← la MÊME, rejouée
```

`revoquer` n'est donc pas un état, c'est un événement que le rejeu écrase. Le
correctif tient en un champ : un **compteur monotone par émetteur** dans l'op,
mémorisé dans l'état ACL (une op dont le numéro est déjà passé est refusée). Il
survit à la signature hors ligne, il coûte un entier par principal, et il ne
change rien au lot de D35. Une variante lie l'op à une position de chaîne, au
prix d'une contention entre administrateurs.

Depuis le gossip (ADR-0018 d'EdgeSync), l'arbitre ignore une demande qu'il a déjà
vue à l'octet près. Ce n'est pas un correctif : la mémoire des messages vus est
bornée et n'est pas persistée. Le scénario simule un redémarrage (`oublier p0`)
avant le rejeu, et la faille réapparaît.

### ⚠️ Le plan du contenu ne rattrape pas une trame perdue

[`lab/scenarios/perte.txt`](lab/scenarios/perte.txt). **Ouverte, et dépendante
d'une hypothèse non écrite.**

Trois pour cent de perte, aucun byzantin, aucune coupure : la chaîne se recolle
toute seule (une époque manquante déclenche un `ChainReq`), mais le contenu, non.
Un frame `OP` perdu n'est jamais redemandé — la synchronisation par vecteur
d'état n'a lieu qu'au `HELLO` et après une clé. Sans reconnexion, rien ne la
redéclenche : les répliques restent différentes, silencieusement, définitivement.

Sur TCP/WebSocket la perte se manifeste par une rupture, donc un `HELLO`, donc un
rattrapage. Le protocole est correct **sous son hypothèse de lien fiable** — mais
cette hypothèse n'est écrite nulle part, et elle tombe dès qu'un relais laisse
tomber une trame sous charge sans fermer la connexion. Une anti-entropie
périodique (un `SyncReq` de temps en temps, un vecteur d'état coûte quelques
dizaines d'octets) fermerait la question.

Depuis le gossip, ce scénario **converge** : dans un maillage de cinq pairs,
chaque `OP` arrive par plusieurs chemins, et une copie perdue est rattrapée par
une autre. C'est de la redondance, pas une réparation. Si toutes les copies se
perdent, ou sur une ligne où il n'y a qu'un chemin, rien ne redemande la trame.
La faille reste ouverte.

### Déjà corrigées

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
npm test                      # les scénarios d'attaque + l'e2e des mini-apps
npm run bench                 # toutes les mesures
PEERS=25 npm run bench:scale  # l'échelle, avec 25 pairs
FLOOD=1000 npm run bench:flood
npm run demo                  # les mini-apps navigateur, sur http://localhost:8787
npm run lab -- lab/scenarios/base.txt    # le laboratoire, dans le terminal
npm run lab -- --fuzz=100                # cent scénarios tirés
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

## Le laboratoire

```bash
npm run lab -- lab/scenarios/twins.txt            # un scénario, des verdicts
npm run lab -- lab/scenarios/partition.txt --suivre   # le même, en direct
npm run lab -- --fuzz=100                         # cent scénarios tirés
npm run lab -- --fuzz=100 --seed=4242             # les mêmes, à l'identique
```

Pas de navigateur, pas de fenêtres à aligner : une ligne par pair dans un
terminal. Chaque pair décide **seul** à chaque tick — le scénario ne pilote
personne, il ne fait qu'injecter des événements dans le monde. C'est ce qui
sépare un banc d'un script : le script rejoue une chronologie, le banc en produit
qu'on n'a pas écrites.

```
  tick 160   1458 trames livrées · 0 perdues · 444 Kio · 0 en vol
  pair    profil     droit    chaîne        contenu   empreinte  écrits
  p0      honnete    manage   h=1   724f60     462     6236388f    10
  p1      menteur    write    h=1   724f60     462     6236388f    11
  p3✂     honnete    write    h=1   724f60     301     a1b2c3d4    20
```

**Le réseau.** Rien ne part tout seul : chaque trame attend son tick, la
livraison se fait dans un ordre tiré, et le réseau sait perdre, retenir et
couper. Toute la non-détermination passe par une graine — c'est le modèle de
`testHelper.js` chez Yjs (files par destinataire, `flushRandomMessage`,
`disconnectRandom`) porté sur `ITransport`, plus ce que Yjs n'a pas à simuler :
des droits qui changent au milieu du trafic.

**Les profils.** `honnete`, `bavard`, `dormeur`, et quatre façons d'être de
mauvaise foi : `sourd` (panne grise — il parle, il n'écoute plus), `inondeur`
(A9), `menteur` (époques qu'il ne peut pas miner, ops d'un autre vault, contenu
scellé sous une clé inventée), `rejoueur` (il renvoie ce qu'il a capté).

**Les jumeaux.** `jumeau p0` applique [Twins](https://arxiv.org/abs/2004.10617)
(Bano et al.) : on n'écrit aucune malveillance, on **dédouble** un pair — mêmes
clés, vue séparée. L'équivocation apparaît toute seule, deux époques différentes
à la même hauteur signées par la même main. C'est la différence entre tester un
attaquant qu'on a imaginé et tester ce qu'un pair légitime dédoublé produit.

**Le langage** est emprunté à any-sync, dont la suite ACL se pilote par des
lignes de texte : une discussion de spécification devient un test d'une ligne.

```
pairs 5
profil p1 menteur
admettre *
tourne 30
couper p3            revoquer p2          jumeau p0
tourne 40
retablir p3
apaiser 150
attendre converge            # ce qui doit tenir
attendre-pas hors-du-vault p2  # une BORNE : elle ne tient pas, et le jour où
                               # elle tiendra, ce fichier échouera
```

| scénario | ce qu'il établit |
|---|---|
| `base` | six pairs, une admission en un lot, convergence — celui qui doit toujours tenir |
| `partition` | le coupé écrit dans le vide, et tout se recolle au retour |
| `revocation` | le révoqué têtu : rien de ce qu'il écrit ensuite n'entre chez les autres |
| `byzantins` | menteur + inondeur + rejoueur + sourd, en même temps : les honnêtes convergent |
| `twins` | l'arbitre dédoublé équivoque — attribuable, pas empêché (k=1 assumé) |
| `revocations-concurrentes` | deux admins révoquent en même temps : l'arbitre unique sérialise |
| `arbitres-multiples` | **la borne C7** : trois arbitres déclarés, `quorumSize(3)=2`, `mint` signe seule — l'arbitre avance seul et le réseau refuse |
| `rejeu-acl` | la trouvaille ci-dessus, réduite au cas minimal |
| `readmission` | réadmettre quelqu'un republie tout ce qu'il a écrit pendant son exclusion |
| `perte` | l'autorité se répare ; le contenu converge par redondance du gossip, sans vraie réparation |

Le tirage (`--fuzz`) écrit des scénarios, pas des appels : un échec se relit, se
corrige à la main, et devient un fichier de non-régression sans être réécrit.
`test/lab.test.ts` rejoue les dix scénarios plus douze tirages à chaque `npm test`.

## Les mini-applications

`npm run demo`, puis <http://localhost:8787/?n=10&app=editor>.

Dix fenêtres, **dix pairs complets** : chacune a sa propre identité, sa propre
chaîne, son propre keyring. Rien n'est préprovisionné — la fenêtre 0 fonde le
vault, les neuf autres arrivent les mains vides et rattrapent l'autorité puis la
clé **par le protocole**, exactement comme dans `vault-fixture` d'EdgeSync.

```
apps/relay.ts                 le relais : il attribue un lien, il recopie des octets
apps/src/relay-transport.ts   ITransport au-dessus du relais (+ coupure, + compteurs)
apps/src/demo-peer.ts         ce qu'une APPLICATION doit écrire pour se brancher — sans DOM
apps/editor.ts                l'éditeur de texte partagé, un Y.Text, un robot par fenêtre
apps/crud.ts                  une base CRUD : deuxième canal du MÊME vault
apps/wall.ts                  le mur : N fenêtres côte à côte, et le verdict de convergence
```

Le relais est **hors du protocole** (ADR-0002) : il ne connaît ni vault, ni clé,
ni ACL, et pose lui-même le `from` de chaque trame — un pair ne peut pas se faire
passer pour un autre *au niveau du lien*, ce qui ne prouve rien sur l'identité,
que seul le HELLO signé porte.

**Ce qu'il y a à regarder :**

| bouton | ce qu'il montre |
|---|---|
| `robots ▶` | dix robots tapent au hasard, aux mêmes instants, aux mêmes endroits |
| `couper un pair` | une partition : la fenêtre continue d'écrire dans le vide |
| `tout reconnecter` | le rattrapage par vecteur d'état (ADR-0008), sans rien redemander |
| `révoquer` (fenêtre 0) | l'écriture du révoqué cesse d'entrer chez les autres |
| `vérifier la convergence` | le verdict, empreinte par empreinte |

La vérification suit la discipline de `compare(users)` chez Yjs : **arrêter les
robots, tout remettre en ligne, laisser le fil se vider, et seulement alors
comparer**. Comparer des pairs qui tapent encore ne prouve rien.

Les robots ne tirent jamais sur `Math.random` : chaque fenêtre a une graine,
affichée et repassable par l'URL (`?seed=`). Une divergence qu'on ne sait pas
rejouer n'est pas un bug, c'est une rumeur.

`test/apps-relay.e2e.test.ts` fait tourner ce **même** code sans navigateur :
admission en un lot, partition et retour, révocation, deuxième canal. Ce qui n'est
donc pas couvert automatiquement, c'est le DOM des pages — le protocole, lui, l'est.

### Ce que les mini-apps ont trouvé

**`PeerStore` n'expose pas ses entrées.** Une application qui affiche « qui est
là » — n'importe laquelle — n'a que `serialize()` pour y arriver : sérialiser du
JSON pour le reparser aussitôt. La démo le fait, en le signalant. C'est un manque
de la surface d'EdgeSync, pas un besoin d'aller lire dedans.

## Structure

```
src/harness.ts     monter N pairs sur un bus, mesurer le fil
src/adversary.ts   un transport brut sans Session : forger n'importe quel frame
test/attacks.test  les scénarios d'attaque, en assertions
test/apps-relay    les mini-apps sans navigateur : lien réel, partition, révocation
bench/scale.ts     admission, révocation, rattrapage, croissance
bench/flood.ts     A9, l'inondation de demandes
lab/net.ts         le réseau simulé : latence, perte, coupure, ordre tiré
lab/profiles.ts    l'autonomie des pairs, byzantins compris
lab/scenario.ts    le langage de scénario, et son exécuteur
lab/checks.ts      les verdicts
lab/fuzz.ts        le tirage de scénarios
lab/scenarios/     ce que le banc sait déjà démontrer
apps/              les mini-applications navigateur (voir plus haut)
```

Le `Bus` d'EdgeSync enregistre chaque octet qui le traverse : « ce que ça a coûté sur
le fil » ne demande aucune instrumentation.

## Licence

AGPL-3.0-or-later.
