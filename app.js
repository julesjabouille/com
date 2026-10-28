/*
 * Widget Grist « Fiche projet ARIANE »
 *
 * - Page en lecture seule ; le bouton « Éditer la page » ouvre un mode édition
 *   (brouillon) validé par « Enregistrer » ou abandonné par « Annuler ».
 * - Enregistrer met à jour la ligne Grist ; toute modification de la ligne dans
 *   Grist met à jour la page (y compris pendant l'édition, sans écraser la saisie).
 * - Les colonnes de type référence (catégorie, sous-catégorie, missions, agents)
 *   sont résolues automatiquement : le widget lit la structure du document pour
 *   retrouver la table liée et la colonne affichée. Référence simple ou multiple
 *   (Ref / RefList) sont toutes deux gérées.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Valeurs du statut : classe du badge DSFR et thème des pastilles d'édition.
const STATUTS = {
  'En attente': { badge: 'fr-badge--warning', theme: 'warning' },
  'Annulé': { badge: 'fr-badge--error', theme: 'error' },
  'Terminé': { badge: 'fr-badge--success', theme: 'success' },
};
const STATUTS_CLOS = ['Terminé', 'Annulé'];

// Colonnes de type référence (Ref ou RefList).
const COLONNES_REFERENCES = [
  'categorie',
  'sous_categorie',
  'missions_fondatrices_rattachees',
  'agents_ariane',
];

// Secours, à renseigner seulement si la structure du document n'est pas lisible
// automatiquement (le message d'erreur l'indiquera). Exemple :
//   categorie: { tableId: 'Categories', colonneLibelle: 'Nom', multiple: true },
const REFERENCES_MANUELLES = {};

// Colonnes du widget : Grist propose l'association avec une colonne de la table.
const COLONNES = [
  { name: 'titre', title: 'Titre', type: 'Text' },
  { name: 'responsable', title: 'Responsable du projet', type: 'Text', optional: true },
  { name: 'categorie', title: 'Catégorie(s)', type: 'Any', optional: true },
  { name: 'sous_categorie', title: 'Sous-catégorie(s)', type: 'Any', optional: true },
  { name: 'descriptif', title: 'Descriptif du projet', type: 'Text', optional: true },
  { name: 'missions_fondatrices_rattachees', title: 'Missions fondatrices rattachées', type: 'Any', optional: true },
  { name: 'echeance', title: 'Échéance', type: 'Date', optional: true },
  { name: 'statut', title: 'Statut', type: 'Choice', optional: true },
  { name: 'agents_ariane', title: 'Agents ARIANE concernés', type: 'Any', optional: true },
  { name: 'autres_agents', title: 'Autres agents concernés', type: 'Text', optional: true },
  { name: 'autres_interlocuteurs', title: 'Autres interlocuteurs concernés', type: 'Text', optional: true },
  { name: 'lien_ressource', title: 'Lien ressource', type: 'Text', optional: true },
  { name: 'lien_article_presse', title: "Lien vers l'article de presse", type: 'Text', optional: true },
  { name: 'etapes', title: 'Étapes (JSON)', type: 'Text', optional: true },
];

// Champs modifiables en mode édition (titre et échéance restent en lecture seule).
const CHAMPS_EDITABLES = [
  'statut', 'responsable', 'categorie', 'sous_categorie',
  'missions_fondatrices_rattachees', 'agents_ariane', 'descriptif',
  'autres_agents', 'autres_interlocuteurs', 'lien_ressource', 'lien_article_presse', 'etapes',
];

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

let enregistrement = null;      // ligne courante (clés = noms des colonnes du widget)
let mappingsGrist = {};         // clé widget -> nom de colonne Grist

let structure = {};             // clé -> { multiple, tableId, colonneLibelle }
let filtreSousCategorie = null; // { type: 'parent' | 'enfants', colonne, memeTable }
let donnees = {};               // tableId -> colonnes { id: [...], Nom: [...] }
let indexIds = {};              // tableId -> Map(id -> indice)
let versionDonnees = 0;         // incrémenté à chaque rechargement des tables liées
let erreurStructure = null;
let signatureStructure = null;
let promesseStructure = null;
let chargementDonnees = null;
let rechargeDemandee = false;

let enEdition = false;
let enregistrementEnCours = false;
let brouillon = null;           // valeurs en cours d'édition
let original = null;            // valeurs de la ligne au dernier synchronisme
let etapesValides = true;       // false si la colonne etapes n'est pas un tableau JSON
let jeton = 0;                  // ignore les réponses asynchrones périmées

let derniereSignature = null;   // évite de reconstruire la page si rien n'a changé
let derniereLecture = null;     // titre + échéance au dernier rendu
let animerFrise = true;         // anime la barre à l'ouverture d'une nouvelle ligne

// ---------------------------------------------------------------------------
// Aides générales
// ---------------------------------------------------------------------------

const $ = (selecteur) => document.querySelector(selecteur);

// Création de nœuds DOM (le texte est toujours inséré en tant que texte).
function h(balise, props = {}, ...enfants) {
  const el = document.createElement(balise);
  for (const [cle, valeur] of Object.entries(props)) {
    if (valeur === undefined || valeur === null || valeur === false) continue;
    if (cle === 'class') el.className = valeur;
    else if (cle.startsWith('on')) el.addEventListener(cle.slice(2), valeur);
    else if (cle in el && !cle.includes('-') && cle !== 'role') el[cle] = valeur;
    else el.setAttribute(cle, valeur === true ? '' : valeur);
  }
  el.append(...enfants.flat().filter((e) => e !== null && e !== undefined && e !== false));
  return el;
}

function icone(nom) {
  return h('span', { class: `fr-icon-${nom} fr-icon--sm`, 'aria-hidden': 'true' });
}

// Retire l'encodage Grist (['L', ...], ['d', ts], ['R', table, id], ['r', table, ids]).
function dechiffrer(valeur) {
  if (!Array.isArray(valeur)) return valeur;
  const [type] = valeur;
  if (type === 'L' || type === 'l') return valeur.slice(1);
  if (type === 'r') return Array.isArray(valeur[2]) ? valeur[2] : [];
  if (type === 'R') return valeur[2];
  if (type === 'd' || type === 'D') return valeur[1];
  return valeur;
}

function texte(valeur) {
  const x = dechiffrer(valeur);
  if (x === null || x === undefined) return '';
  if (Array.isArray(x)) return x.join(', ');
  return String(x);
}

function idRef(valeur) {
  const x = dechiffrer(valeur);
  return typeof x === 'number' ? x : 0;
}

function idsRefs(valeur) {
  const x = dechiffrer(valeur);
  return Array.isArray(x) ? x.filter((v) => typeof v === 'number') : [];
}

// Identifiants contenus dans une cellule de référence, simple ou multiple.
function idsDe(valeur) {
  const x = dechiffrer(valeur);
  if (Array.isArray(x)) return x.filter((v) => typeof v === 'number');
  return typeof x === 'number' && x ? [x] : [];
}

// Date Grist : secondes depuis epoch (UTC) ou chaîne ISO.
function versDate(valeur) {
  const x = dechiffrer(valeur);
  if (x === null || x === undefined || x === '') return null;
  const d = typeof x === 'number' ? new Date(x * 1000) : new Date(x);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formaterDate(date) {
  return date
    ? date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    : '';
}

function formaterDateIso(iso) {
  return iso ? formaterDate(new Date(`${iso}T00:00:00Z`)) : '';
}

function aujourdhui() {
  return new Date().toLocaleDateString('sv-SE'); // AAAA-MM-JJ, fuseau local
}

// Table renvoyée en lignes -> en colonnes.
function versColonnes(donneesBrutes) {
  if (!Array.isArray(donneesBrutes)) return donneesBrutes || {};
  const colonnes = {};
  for (const ligne of donneesBrutes) {
    for (const [cle, valeur] of Object.entries(ligne)) (colonnes[cle] ||= []).push(valeur);
  }
  return colonnes;
}

// Convertit des champs du widget vers les noms de colonnes réels de la table.
function versColonnesGrist(champs) {
  const sortie = {};
  for (const [cle, valeur] of Object.entries(champs)) {
    const mappe = grist.mapColumnNamesBack({ id: enregistrement.id, [cle]: valeur });
    for (const [colonne, val] of Object.entries(mappe)) {
      if (colonne !== 'id' && val !== undefined) sortie[colonne] = val;
    }
  }
  return sortie;
}

// quoi : 'vide' | 'config' | 'application'
function montrer(quoi) {
  $('#message-vide').hidden = quoi !== 'vide';
  $('#message-config').hidden = quoi !== 'config';
  $('#application').hidden = quoi !== 'application';
  if (quoi !== 'application') derniereSignature = null;
}

function afficherErreur(message) {
  $('#message-erreur p').textContent = message;
  $('#message-erreur').hidden = false;
}

function masquerErreur() {
  $('#message-erreur').hidden = true;
}

// ---------------------------------------------------------------------------
// Références : structure du document, libellés, options
// ---------------------------------------------------------------------------

async function chargerStructure(mappings) {
  structure = {};
  filtreSousCategorie = null;
  erreurStructure = null;
  try {
    const tableId = await grist.getSelectedTableId();
    const [tables, colonnes] = (await Promise.all([
      grist.docApi.fetchTable('_grist_Tables'),
      grist.docApi.fetchTable('_grist_Tables_column'),
    ])).map(versColonnes);

    const idTable = (nom) => {
      const i = (tables.tableId || []).indexOf(nom);
      return i < 0 ? null : tables.id[i];
    };
    const parent = idTable(tableId);

    for (const cle of COLONNES_REFERENCES) {
      const colId = mappings?.[cle];
      if (!colId) continue;
      const i = colonnes.colId.findIndex((c, k) => c === colId && colonnes.parentId[k] === parent);
      if (i < 0) continue;
      const m = /^(Ref|RefList):(.+)$/.exec(colonnes.type[i]);
      if (!m) continue;
      const j = colonnes.id.indexOf(colonnes.visibleCol[i]);
      structure[cle] = {
        multiple: m[1] === 'RefList',
        tableId: m[2],
        colonneLibelle: j >= 0 ? colonnes.colId[j] : null,
      };
    }
    filtreSousCategorie = detecterFiltre(colonnes, idTable);
  } catch (err) {
    console.error(err);
    erreurStructure = err.message || String(err);
  }

  for (const [cle, definition] of Object.entries(REFERENCES_MANUELLES)) {
    structure[cle] = { multiple: false, colonneLibelle: null, ...definition };
  }

  const manquantes = COLONNES_REFERENCES.filter((c) => enregistrement && c in enregistrement && !structure[c]);
  if (erreurStructure && manquantes.length) {
    afficherErreur(`Structure des tables illisible (${erreurStructure}). `
      + 'Renseignez REFERENCES_MANUELLES dans app.js pour : ' + manquantes.join(', ') + '.');
  }
}

// Cherche comment relier sous-catégories et catégories.
function detecterFiltre(colonnes, idTable) {
  const cat = structure.categorie;
  const sous = structure.sous_categorie;
  if (!cat || !sous) return null;

  const indices = (idParent, types) => colonnes.colId
    .map((_, i) => i)
    .filter((i) => colonnes.parentId[i] === idParent && types.includes(colonnes.type[i]));

  // 1) la table des sous-catégories a une colonne de référence vers les catégories
  const versCategorie = indices(idTable(sous.tableId), [`Ref:${cat.tableId}`, `RefList:${cat.tableId}`]);
  if (versCategorie.length) {
    const choix = versCategorie.find((i) => /cat/i.test(colonnes.colId[i])) ?? versCategorie[0];
    return { type: 'parent', colonne: colonnes.colId[choix], memeTable: cat.tableId === sous.tableId };
  }
  // 2) la table des catégories liste ses sous-catégories
  const versSous = indices(idTable(cat.tableId), [`RefList:${sous.tableId}`]);
  if (versSous.length) return { type: 'enfants', colonne: colonnes.colId[versSous[0]], memeTable: false };
  return null;
}

async function chargerDonnees() {
  const aCharger = [...new Set(Object.values(structure).map((s) => s.tableId))];
  await Promise.all(aCharger.map(async (tableId) => {
    try {
      const colonnes = versColonnes(await grist.docApi.fetchTable(tableId));
      colonnes.id ||= [];
      donnees[tableId] = colonnes;
      indexIds[tableId] = new Map(colonnes.id.map((id, i) => [id, i]));
    } catch (err) {
      console.error(err);
      afficherErreur(`Impossible de lire la table « ${tableId} » : ${err.message || err}`);
    }
  }));
  versionDonnees += 1;
}

// Plusieurs demandes simultanées de rechargement sont regroupées.
function chargerDonneesGroupe() {
  if (chargementDonnees) {
    rechargeDemandee = true;
    return chargementDonnees;
  }
  chargementDonnees = (async () => {
    do {
      rechargeDemandee = false;
      await chargerDonnees();
    } while (rechargeDemandee);
  })().finally(() => { chargementDonnees = null; });
  return chargementDonnees;
}

async function preparerReferences(rafraichir) {
  const signature = JSON.stringify(mappingsGrist);
  if (signature !== signatureStructure) {
    signatureStructure = signature;
    promesseStructure = chargerStructure(mappingsGrist);
    rafraichir = true;
  }
  await promesseStructure;
  if (rafraichir) await chargerDonneesGroupe();
}

function cellule(tableId, colonne, id) {
  const i = indexIds[tableId]?.get(id);
  const valeurs = donnees[tableId]?.[colonne];
  return i === undefined || !valeurs ? undefined : valeurs[i];
}

function colonneLibelle(cle) {
  const s = structure[cle];
  const table = donnees[s?.tableId];
  if (!table) return null;
  if (s.colonneLibelle && table[s.colonneLibelle]) return s.colonneLibelle;
  return Object.keys(table).find((c) => c !== 'id' && c !== 'manualSort'
    && Array.isArray(table[c]) && table[c].some((v) => typeof v === 'string')) || null;
}

function libelleRef(cle, id) {
  const colonne = colonneLibelle(cle);
  const valeur = colonne ? cellule(structure[cle].tableId, colonne, id) : undefined;
  return texte(valeur) || `#${id}`;
}

// Options { id, libelle, groupe? } d'une colonne de référence.
function optionsRef(cle) {
  const s = structure[cle];
  const table = donnees[s?.tableId];
  if (!table) return [];
  let ids = table.id;
  // Catégories et sous-catégories dans une même table : seules les racines sont des catégories.
  if (cle === 'categorie' && filtreSousCategorie?.type === 'parent' && filtreSousCategorie.memeTable) {
    ids = ids.filter((id) => !idsDe(cellule(s.tableId, filtreSousCategorie.colonne, id)).length);
  }
  return ids
    .map((id) => ({ id, libelle: libelleRef(cle, id) }))
    .sort((a, b) => a.libelle.localeCompare(b.libelle, 'fr'));
}

// Sous-catégories rattachées à au moins une des catégories choisies.
// Si plusieurs catégories sont choisies, chaque option porte le nom de sa catégorie (groupe).
function optionsSousCategorie(categoriesIds) {
  const toutes = optionsRef('sous_categorie');
  const filtre = filtreSousCategorie;
  if (!filtre) return toutes;
  if (!categoriesIds.length) return [];

  const regrouper = categoriesIds.length > 1;
  const nomGroupe = (catId) => (regrouper ? libelleRef('categorie', catId) : undefined);
  const retenues = [];

  if (filtre.type === 'parent') {
    const tableId = structure.sous_categorie.tableId;
    for (const option of toutes) {
      const parents = idsDe(cellule(tableId, filtre.colonne, option.id));
      const catId = categoriesIds.find((c) => parents.includes(c));
      if (catId !== undefined) retenues.push({ ...option, groupe: nomGroupe(catId) });
    }
  } else {
    const dejaVues = new Set();
    for (const catId of categoriesIds) {
      const enfants = idsRefs(cellule(structure.categorie.tableId, filtre.colonne, catId));
      for (const option of toutes) {
        if (enfants.includes(option.id) && !dejaVues.has(option.id)) {
          dejaVues.add(option.id);
          retenues.push({ ...option, groupe: nomGroupe(catId) });
        }
      }
    }
  }
  return retenues.sort((a, b) => (a.groupe || '').localeCompare(b.groupe || '', 'fr')
    || a.libelle.localeCompare(b.libelle, 'fr'));
}

// Retire du brouillon les sous-catégories qui ne dépendent plus d'aucune catégorie choisie.
function nettoyerSousCategories() {
  if (!filtreSousCategorie || !brouillon.sous_categorie.length) return;
  const autorisees = new Set(optionsSousCategorie(brouillon.categorie).map((o) => o.id));
  brouillon.sous_categorie = brouillon.sous_categorie.filter((id) => autorisees.has(id));
}

function definirReference(cle, ids, focusId) {
  brouillon[cle] = ids;
  if (cle === 'categorie') nettoyerSousCategories();
  rendre(focusId);
}

// Libellés à afficher pour une référence (retombe sur le texte brut si non résolue).
function libellesAffiches(cle, v) {
  if (structure[cle]) return v[cle].map((id) => libelleRef(cle, id));
  const brut = texte(enregistrement[cle]);
  return brut ? [brut] : [];
}

// ---------------------------------------------------------------------------
// Valeurs de la fiche
// ---------------------------------------------------------------------------

function normaliserEtape(e) {
  return { texte: String(e?.texte ?? ''), date: String(e?.date ?? ''), fait: Boolean(e?.fait) };
}

// Étapes datées dans l'ordre chronologique, puis celles sans date.
function trierEtapes(liste) {
  return liste
    .map((etape, i) => ({ etape, i }))
    .sort((a, b) => {
      if (a.etape.date && b.etape.date) return a.etape.date.localeCompare(b.etape.date) || a.i - b.i;
      if (a.etape.date) return -1;
      if (b.etape.date) return 1;
      return a.i - b.i;
    })
    .map((x) => x.etape);
}

function lireEtapes(rec) {
  const brut = texte(rec.etapes);
  if (!brut) return { liste: [], valide: true };
  try {
    const valeur = JSON.parse(brut);
    if (Array.isArray(valeur)) return { liste: valeur.map(normaliserEtape), valide: true };
  } catch { /* contenu invalide */ }
  return { liste: [], valide: false };
}

// Référence -> liste d'identifiants (une référence simple donne 0 ou 1 élément).
function lireRef(cle, brut) {
  if (structure[cle]?.multiple) return idsRefs(brut);
  const id = idRef(brut);
  return id ? [id] : [];
}

function extraireValeurs(rec) {
  const etapes = lireEtapes(rec);
  etapesValides = etapes.valide;
  return {
    statut: texte(rec.statut),
    responsable: texte(rec.responsable),
    categorie: lireRef('categorie', rec.categorie),
    sous_categorie: lireRef('sous_categorie', rec.sous_categorie),
    missions_fondatrices_rattachees: lireRef('missions_fondatrices_rattachees', rec.missions_fondatrices_rattachees),
    agents_ariane: lireRef('agents_ariane', rec.agents_ariane),
    descriptif: texte(rec.descriptif),
    autres_agents: texte(rec.autres_agents),
    autres_interlocuteurs: texte(rec.autres_interlocuteurs),
    lien_ressource: texte(rec.lien_ressource),
    lien_article_presse: texte(rec.lien_article_presse),
    etapes: trierEtapes(etapes.liste),
  };
}

const estMappe = (cle) => Boolean(enregistrement) && cle in enregistrement;

function modifiable(cle) {
  if (!estMappe(cle)) return false;
  if (COLONNES_REFERENCES.includes(cle)) return Boolean(structure[cle]);
  if (cle === 'etapes') return etapesValides;
  return true;
}

// Valeur au format d'écriture Grist.
function encoder(cle, valeur) {
  if (COLONNES_REFERENCES.includes(cle)) {
    return structure[cle]?.multiple ? ['L', ...valeur] : (valeur[0] || 0);
  }
  if (cle === 'etapes') return JSON.stringify(valeur);
  return typeof valeur === 'string' ? valeur.trim() : valeur;
}

const egal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Mode édition
// ---------------------------------------------------------------------------

async function entrerEdition() {
  await chargerDonneesGroupe(); // listes à jour (nouvelles catégories, agents...)
  original = extraireValeurs(enregistrement);
  brouillon = structuredClone(original);
  enEdition = true;
  rendre();
}

function sortirEdition() {
  enEdition = false;
  brouillon = null;
  original = null;
  rendre();
}

async function validerEdition() {
  if (enregistrementEnCours) return;

  // Étape en cours de saisie mais pas encore ajoutée : on l'ajoute.
  const champTexte = document.getElementById('nouvelle-etape-texte');
  const champDate = document.getElementById('nouvelle-etape-date');
  if (champTexte?.value.trim()) {
    brouillon.etapes.push({ texte: champTexte.value.trim(), date: champDate?.value || '', fait: false });
  }
  brouillon.etapes = trierEtapes(
    brouillon.etapes
      .map((e) => ({ ...e, texte: e.texte.trim() }))
      .filter((e) => e.texte),
  );

  const champs = {};
  for (const cle of CHAMPS_EDITABLES) {
    if (!modifiable(cle)) continue;
    const valeur = encoder(cle, brouillon[cle]);
    if (!egal(valeur, encoder(cle, original[cle]))) champs[cle] = valeur;
  }
  if (!Object.keys(champs).length) {
    sortirEdition();
    return;
  }

  enregistrementEnCours = true;
  document.querySelectorAll('.barre button').forEach((b) => { b.disabled = true; });
  try {
    // Format attendu par l'API Grist : { id, fields: { colonne: valeur } }
    await grist.getTable().update({ id: enregistrement.id, fields: versColonnesGrist(champs) });
    Object.assign(enregistrement, champs);
    masquerErreur();
    enregistrementEnCours = false;
    sortirEdition();
  } catch (err) {
    console.error(err);
    enregistrementEnCours = false;
    afficherErreur(`Échec de l'enregistrement : ${err.message || err}`);
    rendre();
  }
}

// Une modification de la ligne dans Grist pendant l'édition : on reporte dans le brouillon
// les champs que l'utilisateur n'a pas touchés ; ses propres saisies sont conservées.
function fusionnerExterne() {
  const nouvelles = extraireValeurs(enregistrement);
  let change = false;

  for (const cle of CHAMPS_EDITABLES) {
    if (!modifiable(cle)) continue;
    if (egal(nouvelles[cle], original[cle])) continue;       // inchangé dans Grist
    if (egal(brouillon[cle], original[cle])) {                // non modifié par l'utilisateur
      brouillon[cle] = structuredClone(nouvelles[cle]);
      change = true;
    }
  }
  original = nouvelles;

  const lecture = JSON.stringify([enregistrement.titre, enregistrement.echeance]);
  if (lecture !== derniereLecture) change = true;
  if (change) rendrePreservantFocus();
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

const signatureCourante = () => `${versionDonnees}|${JSON.stringify(enregistrement)}`;

function rendreSiChangement() {
  if (signatureCourante() !== derniereSignature) rendre();
}

// focusId : identifiant de l'élément qui reprend le focus après reconstruction.
function rendre(focusId) {
  if (!enregistrement) return;
  const v = enEdition ? brouillon : extraireValeurs(enregistrement);

  // On conserve la position de défilement et la nouvelle étape en cours de saisie.
  const defilement = window.scrollY;
  const nouvelleEtape = {
    texte: document.getElementById('nouvelle-etape-texte')?.value ?? '',
    date: document.getElementById('nouvelle-etape-date')?.value ?? '',
  };

  $('#application').replaceChildren(
    construireBarre(),
    construireEntete(v),
    h('div', { class: 'corps' },
      h('div', { class: 'colonne' }, blocDescriptif(v), blocEtapes(v)),
      h('div', { class: 'colonne' }, blocMissions(v), blocPersonnes(v), blocLiens(v))),
  );

  const champTexte = document.getElementById('nouvelle-etape-texte');
  if (champTexte) {
    champTexte.value = nouvelleEtape.texte;
    document.getElementById('nouvelle-etape-date').value = nouvelleEtape.date;
  }

  derniereSignature = signatureCourante();
  derniereLecture = JSON.stringify([enregistrement.titre, enregistrement.echeance]);
  majFrise(animerFrise);
  animerFrise = false;
  window.scrollTo(0, defilement);
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}

// Reconstruit la page en gardant le focus et la position du curseur dans le champ actif.
function rendrePreservantFocus() {
  const actif = document.activeElement;
  const id = actif?.id;
  let selection = null;
  try { selection = [actif.selectionStart, actif.selectionEnd]; } catch { /* champ sans sélection */ }

  rendre(id);

  const el = id ? document.getElementById(id) : null;
  if (el && selection && selection[0] !== null) {
    try { el.setSelectionRange(selection[0], selection[1]); } catch { /* champ sans sélection */ }
  }
}

function construireBarre() {
  if (!enEdition) {
    return h('div', { class: 'barre' },
      h('button', {
        type: 'button',
        class: 'fr-btn fr-btn--secondary fr-btn--sm fr-icon-edit-line fr-btn--icon-left',
        onclick: entrerEdition,
      }, 'Éditer la page'));
  }
  return h('div', { class: 'barre edition' },
    h('p', { class: 'consigne' }, 'Mode édition : les modifications ne sont enregistrées qu\'après validation.'),
    h('div', { class: 'actions' },
      h('button', {
        type: 'button',
        class: 'fr-btn fr-btn--tertiary fr-btn--sm fr-icon-close-line fr-btn--icon-left',
        disabled: enregistrementEnCours,
        onclick: sortirEdition,
      }, 'Annuler'),
      h('button', {
        type: 'button',
        class: 'fr-btn fr-btn--sm fr-icon-save-line fr-btn--icon-left',
        disabled: enregistrementEnCours,
        onclick: validerEdition,
      }, 'Enregistrer')));
}

// ----- En-tête -----

function construireEntete(v) {
  return h('header', { class: 'entete' },
    h('div', { class: 'entete-gauche' },
      h('h1', { class: 'fr-h3' }, texte(enregistrement.titre) || '(sans titre)'),
      enEdition ? rubriquesEdition(v) : rubriquesVue(v)),
    h('div', { class: `entete-droite${enEdition ? ' edition' : ''}` },
      blocEcheance(v), blocStatut(v), blocResponsable(v)));
}

function rubriquesVue(v) {
  const lignes = [];
  for (const [cle, singulier, pluriel] of [
    ['categorie', 'Catégorie', 'Catégories'],
    ['sous_categorie', 'Sous-catégorie', 'Sous-catégories'],
  ]) {
    if (!estMappe(cle)) continue;
    const libelles = libellesAffiches(cle, v);
    if (!libelles.length) continue;
    lignes.push(h('div', { class: 'rubrique' },
      h('span', { class: 'rubrique-libelle' }, libelles.length > 1 ? pluriel : singulier),
      h('div', { class: 'puces' }, ...libelles.map((l) => h('p', { class: 'fr-tag' }, l)))));
  }
  return lignes.length
    ? h('div', { class: 'rubriques' }, ...lignes)
    : h('p', { class: 'vide' }, 'Aucune catégorie renseignée');
}

function rubriquesEdition(v) {
  const champs = [];

  if (estMappe('categorie')) {
    champs.push(modifiable('categorie')
      ? champReference('categorie', v, optionsRef('categorie'), { singulier: 'Catégorie', pluriel: 'Catégories' })
      : champLecture('Catégorie', libellesAffiches('categorie', v).join(', ')));
  }

  if (estMappe('sous_categorie')) {
    if (modifiable('sous_categorie')) {
      let desactive = false;
      let aide;
      if (filtreSousCategorie && !v.categorie.length) {
        desactive = true;
        aide = 'Choisissez d\'abord une catégorie';
      } else if (!filtreSousCategorie && structure.categorie) {
        aide = 'Aucun lien trouvé avec les catégories : toutes les sous-catégories sont proposées';
      }
      champs.push(champReference('sous_categorie', v, optionsSousCategorie(v.categorie), {
        singulier: 'Sous-catégorie', pluriel: 'Sous-catégories', desactive, aide,
      }));
    } else {
      champs.push(champLecture('Sous-catégorie', libellesAffiches('sous_categorie', v).join(', ')));
    }
  }
  return h('div', { class: 'rubriques-edition' }, ...champs);
}

function blocEcheance(v) {
  if (!estMappe('echeance')) return null;
  const date = versDate(enregistrement.echeance);
  const iso = date ? date.toISOString().slice(0, 10) : '';
  const enRetard = Boolean(iso) && iso < aujourdhui() && !STATUTS_CLOS.includes(v.statut);
  return h('div', { class: `echeance${enRetard ? ' retard' : ''}` },
    h('p', { class: 'meta-libelle' }, 'Échéance'),
    h('p', { class: 'echeance-valeur' },
      icone('calendar-line'),
      date ? formaterDate(date) : 'Non définie',
      enRetard ? h('span', { class: 'fr-badge fr-badge--sm fr-badge--error fr-badge--no-icon' }, 'En retard') : null));
}

function blocStatut(v) {
  if (!estMappe('statut')) return null;
  if (!enEdition) {
    const configuration = STATUTS[v.statut];
    return h('div', { class: 'statut' },
      h('p', { class: 'meta-libelle' }, 'Statut'),
      h('p', { class: `fr-badge fr-badge--no-icon ${configuration?.badge ?? 'fr-badge--info'}` },
        v.statut || 'Non renseigné'));
  }
  return h('div', { class: 'statut' },
    h('p', { class: 'meta-libelle', id: 'libelle-statut' }, 'Statut'),
    h('div', { class: 'pastilles', role: 'radiogroup', 'aria-labelledby': 'libelle-statut' },
      ...Object.entries(STATUTS).map(([valeur, configuration], i) => h('label', { class: `pastille theme-${configuration.theme}` },
        h('input', {
          type: 'radio',
          name: 'statut',
          id: `statut-${i}`,
          value: valeur,
          checked: v.statut === valeur,
          onchange: () => { brouillon.statut = valeur; rendre(`statut-${i}`); },
        }),
        h('span', {}, valeur)))));
}

function blocResponsable(v) {
  if (!estMappe('responsable')) return null;
  if (!enEdition) {
    return h('div', { class: 'responsable-bloc' },
      h('p', { class: 'meta-libelle' }, 'Responsable du projet'),
      h('p', { class: 'responsable' }, icone('user-line'), v.responsable || 'Non renseigné'));
  }
  return champTexte('responsable', 'Responsable du projet', v);
}

// ----- Blocs de contenu -----

function blocDescriptif(v) {
  if (!estMappe('descriptif')) return null;
  let contenu;
  if (enEdition) {
    contenu = h('textarea', {
      class: 'fr-input',
      id: 'champ-descriptif',
      rows: 8,
      'aria-label': 'Descriptif du projet',
      value: v.descriptif,
      oninput: (e) => { brouillon.descriptif = e.target.value; },
    });
  } else {
    contenu = v.descriptif
      ? h('p', { class: 'texte-long' }, v.descriptif)
      : h('p', { class: 'vide' }, 'Aucun descriptif renseigné.');
  }
  return h('section', { class: 'bloc' }, h('h2', { class: 'bloc-titre' }, 'Descriptif du projet'), contenu);
}

function blocMissions(v) {
  const cle = 'missions_fondatrices_rattachees';
  if (!estMappe(cle)) return null;
  const contenu = enEdition && modifiable(cle)
    ? champReference(cle, v, optionsRef(cle), { singulier: 'Mission', pluriel: 'Ajouter une mission' })
    : listePuces(libellesAffiches(cle, v), 'Aucune mission rattachée.');
  return h('section', { class: 'bloc' }, h('h2', { class: 'bloc-titre' }, 'Missions fondatrices rattachées'), contenu);
}

function blocPersonnes(v) {
  if (!['agents_ariane', 'autres_agents', 'autres_interlocuteurs'].some(estMappe)) return null;
  const elements = [];

  if (estMappe('agents_ariane')) {
    elements.push(enEdition && modifiable('agents_ariane')
      ? champReference('agents_ariane', v, optionsRef('agents_ariane'), {
        singulier: 'Agent ARIANE concerné', pluriel: 'Agents ARIANE concernés',
      })
      : champVue('Agents ARIANE concernés', (() => {
        const libelles = libellesAffiches('agents_ariane', v);
        return libelles.length ? listePuces(libelles) : null;
      })(), 'Aucun agent'));
  }

  // Champs multilignes : Entrée ajoute une nouvelle ligne dans la même entrée.
  for (const [cle, libelle] of [
    ['autres_agents', 'Autres agents concernés'],
    ['autres_interlocuteurs', 'Autres interlocuteurs concernés'],
  ]) {
    if (!estMappe(cle)) continue;
    elements.push(enEdition
      ? champTexte(cle, libelle, v, { multiligne: true, aide: 'Une ligne par entrée (Entrée pour ajouter une ligne)' })
      : champVue(libelle, v[cle] ? h('p', { class: 'texte-long' }, v[cle]) : null));
  }
  return h('section', { class: 'bloc' }, h('h2', { class: 'bloc-titre' }, 'Personnes concernées'), ...elements);
}

function blocLiens(v) {
  const liens = [
    ['lien_ressource', 'Lien ressource'],
    ['lien_article_presse', 'Lien vers l\'article de presse'],
  ].filter(([cle]) => estMappe(cle));
  if (!liens.length) return null;

  return h('section', { class: 'bloc' },
    h('h2', { class: 'bloc-titre' }, 'Liens'),
    ...liens.map(([cle, libelle]) => {
      if (enEdition) return champTexte(cle, libelle, v, { type: 'url', placeholder: 'https://…' });
      const url = v[cle];
      let contenu = null;
      if (/^https?:\/\//i.test(url)) {
        contenu = h('a', {
          class: 'fr-link',
          href: url,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: url,
        }, url);
      } else if (url) {
        contenu = h('p', {}, url);
      }
      return champVue(libelle, contenu);
    }));
}

// ----- Frise chronologique -----

function blocEtapes(v) {
  if (!estMappe('etapes')) return null;
  const liste = v.etapes;
  const faites = liste.filter((e) => e.fait).length;

  const entete = h('div', { class: 'bloc-entete' },
    h('h2', { class: 'bloc-titre' }, 'Étapes'),
    liste.length ? h('p', { class: 'progression' }, libelleProgression(faites, liste.length)) : null);

  let corps;
  if (!etapesValides) {
    corps = h('p', { class: 'vide' }, 'La colonne des étapes ne contient pas un tableau JSON valide : affichage et modification désactivés.');
  } else if (!liste.length) {
    corps = h('p', { class: 'vide' }, enEdition ? 'Aucune étape pour le moment : ajoutez la première ci-dessous.' : 'Aucune étape pour le moment.');
  } else {
    corps = frise(liste);
  }
  return h('section', { class: 'bloc' }, entete, corps, enEdition && etapesValides ? formulaireAjoutEtape() : null);
}

function libelleProgression(faites, total) {
  const pourcentage = total ? Math.round((faites / total) * 100) : 0;
  return `${faites} sur ${total} réalisée${faites > 1 ? 's' : ''} · ${pourcentage} %`;
}

function frise(liste) {
  return h('div', { class: 'frise' },
    h('div', { class: 'frise-rail' }, h('div', { class: 'frise-remplissage' })),
    h('ol', { class: 'frise-liste' }, ...liste.map((etape, i) => {
      const enRetard = Boolean(etape.date) && !etape.fait && etape.date < aujourdhui();
      const noeud = enEdition
        ? h('label', { class: 'noeud' },
          h('input', {
            type: 'checkbox',
            id: `etape-fait-${i}`,
            checked: etape.fait,
            'aria-label': `Étape réalisée : ${etape.texte}`,
            onchange: (e) => {
              brouillon.etapes[i].fait = e.target.checked;
              e.target.closest('.frise-etape').classList.toggle('fait', e.target.checked);
              majFrise();
            },
          }))
        : h('span', { class: 'noeud', 'aria-hidden': 'true' });

      const contenu = enEdition
        ? h('div', { class: 'etape-edition' },
          h('input', {
            type: 'text',
            class: 'fr-input',
            id: `etape-texte-${i}`,
            value: etape.texte,
            'aria-label': 'Libellé de l\'étape',
            oninput: (e) => { brouillon.etapes[i].texte = e.target.value; },
          }),
          h('input', {
            type: 'date',
            class: 'fr-input',
            id: `etape-date-${i}`,
            value: etape.date,
            'aria-label': 'Date de réalisation',
            onchange: (e) => { brouillon.etapes[i].date = e.target.value; },
          }),
          h('button', {
            type: 'button',
            class: 'fr-btn fr-btn--tertiary-no-outline fr-btn--sm fr-icon-delete-line',
            title: 'Supprimer l\'étape',
            onclick: () => { brouillon.etapes.splice(i, 1); rendre(); },
          }, 'Supprimer l\'étape'))
        : h('div', {},
          h('p', { class: 'etape-titre' }, etape.texte),
          h('p', { class: `etape-date${enRetard ? ' retard' : ''}` },
            icone('calendar-line'),
            etape.date ? formaterDateIso(etape.date) : 'Sans date',
            enRetard ? h('span', { class: 'fr-badge fr-badge--sm fr-badge--error fr-badge--no-icon' }, 'En retard') : null));

      return h('li', { class: `frise-etape${etape.fait ? ' fait' : ''}` },
        noeud, h('div', { class: 'frise-contenu' }, contenu));
    })));
}

function formulaireAjoutEtape() {
  const champTexte = h('input', {
    type: 'text',
    class: 'fr-input',
    id: 'nouvelle-etape-texte',
    placeholder: 'Nouvelle étape…',
    'aria-label': 'Libellé de la nouvelle étape',
  });
  const champDate = h('input', {
    type: 'date',
    class: 'fr-input',
    id: 'nouvelle-etape-date',
    'aria-label': 'Date de réalisation de la nouvelle étape',
  });
  return h('form', {
    class: 'ajout-etape',
    onsubmit: (e) => {
      e.preventDefault();
      const libelle = champTexte.value.trim();
      if (!libelle) { champTexte.focus(); return; }
      brouillon.etapes = trierEtapes([...brouillon.etapes, { texte: libelle, date: champDate.value, fait: false }]);
      champTexte.value = '';
      champDate.value = '';
      rendre('nouvelle-etape-texte');
    },
  },
  champTexte,
  champDate,
  h('button', { type: 'submit', class: 'fr-btn fr-btn--secondary fr-btn--sm fr-icon-add-line fr-btn--icon-left' }, 'Ajouter'));
}

// Positionne la barre de progression : du premier nœud jusqu'au dernier nœud coché.
function majFrise(depuisZero = false) {
  const frise = document.querySelector('.frise');
  if (!frise) return;
  const etapes = [...frise.querySelectorAll('.frise-etape')];
  const rail = frise.querySelector('.frise-rail');
  const remplissage = rail.firstElementChild;

  const faites = etapes.filter((li) => li.classList.contains('fait')).length;
  const progression = document.querySelector('.progression');
  if (progression) progression.textContent = libelleProgression(faites, etapes.length);

  frise.classList.toggle('complete', etapes.length > 0 && faites === etapes.length);
  rail.hidden = etapes.length < 2;
  if (rail.hidden) return;

  const haut = frise.getBoundingClientRect().top;
  const centres = etapes.map((li) => {
    const r = li.querySelector('.noeud').getBoundingClientRect();
    return r.top + r.height / 2 - haut;
  });
  rail.style.top = `${centres[0]}px`;
  rail.style.height = `${centres[centres.length - 1] - centres[0]}px`;

  const dernierFait = etapes.reduce((acc, li, i) => (li.classList.contains('fait') ? i : acc), -1);
  const cible = dernierFait > 0 ? centres[dernierFait] - centres[0] : 0;

  if (depuisZero) {
    // Animation d'ouverture : on part de 0 puis on laisse la transition CSS remplir la barre.
    remplissage.style.transition = 'none';
    remplissage.style.height = '0px';
    void remplissage.offsetHeight; // applique l'état initial avant d'animer
    remplissage.style.transition = '';
  }
  remplissage.style.height = `${cible}px`;
}

// ----- Composants de formulaire -----

function champVue(libelle, contenu, vide = 'Non renseigné') {
  return h('div', { class: 'champ-vue' },
    h('p', { class: 'meta-libelle' }, libelle),
    contenu ?? h('p', { class: 'vide' }, vide));
}

function champLecture(libelle, valeur) {
  return champVue(libelle, valeur ? h('p', {}, valeur) : null);
}

function listePuces(libelles, vide = 'Aucun') {
  return libelles.length
    ? h('div', { class: 'puces' }, ...libelles.map((l) => h('p', { class: 'fr-tag' }, l)))
    : h('p', { class: 'vide' }, vide);
}

function etiquette(libelle, aide) {
  return [libelle, aide ? h('span', { class: 'fr-hint-text' }, aide) : null];
}

function champTexte(cle, libelle, v, { type = 'text', placeholder, multiligne = false, aide } = {}) {
  const id = `champ-${cle}`;
  const saisie = multiligne
    ? h('textarea', {
      class: 'fr-input',
      id,
      rows: 3,
      value: v[cle],
      oninput: (e) => { brouillon[cle] = e.target.value; },
    })
    : h('input', {
      type,
      class: 'fr-input',
      id,
      placeholder,
      value: v[cle],
      oninput: (e) => { brouillon[cle] = e.target.value; },
    });
  return h('div', { class: 'fr-input-group' },
    h('label', { class: 'fr-label', htmlFor: id }, ...etiquette(libelle, aide)),
    saisie);
}

// Options <option>, regroupées en <optgroup> quand elles portent un groupe.
function elementsOptions(options, estChoisi = () => false) {
  const sortie = [];
  let groupe = null;
  let optgroup = null;
  for (const o of options) {
    const option = h('option', { value: String(o.id), selected: estChoisi(o.id) }, o.libelle);
    if (o.groupe) {
      if (o.groupe !== groupe) {
        groupe = o.groupe;
        optgroup = h('optgroup', { label: groupe });
        sortie.push(optgroup);
      }
      optgroup.append(option);
    } else {
      groupe = null;
      sortie.push(option);
    }
  }
  return sortie;
}

// Champ de référence : liste déroulante simple (Ref) ou à sélection multiple (RefList).
function champReference(cle, v, options, { singulier, pluriel, desactive, aide } = {}) {
  return structure[cle].multiple
    ? champMultiple(cle, pluriel, v, options, { desactive, aide })
    : champSelection(cle, singulier, v[cle][0] || 0, options, { desactive, aide });
}

// Référence unique (valeur 0 = aucune).
function champSelection(cle, libelle, valeur, options, { desactive, aide }) {
  const id = `champ-${cle}`;
  const liste = valeur && !options.some((o) => o.id === valeur)
    ? [{ id: valeur, libelle: libelleRef(cle, valeur) }, ...options]
    : options;
  return h('div', { class: 'fr-select-group' },
    h('label', { class: 'fr-label', htmlFor: id }, ...etiquette(libelle, aide)),
    h('select', {
      class: 'fr-select',
      id,
      disabled: desactive,
      onchange: (e) => {
        const choix = Number(e.target.value);
        definirReference(cle, choix ? [choix] : [], id);
      },
    },
    h('option', { value: '0' }, '— Aucune —'),
    ...elementsOptions(liste, (x) => x === valeur)));
}

// Sélection multiple : on ajoute depuis la liste déroulante, on retire via les pastilles.
function champMultiple(cle, libelle, v, options, { desactive, aide } = {}) {
  const id = `champ-${cle}`;
  const choisis = v[cle];
  const disponibles = options.filter((o) => !choisis.includes(o.id));

  return h('div', { class: 'champ-multiple' },
    h('div', { class: 'fr-select-group' },
      h('label', { class: 'fr-label', htmlFor: id }, ...etiquette(libelle, aide)),
      h('select', {
        class: 'fr-select',
        id,
        disabled: desactive || disponibles.length === 0,
        onchange: (e) => {
          const choix = Number(e.target.value);
          if (choix) definirReference(cle, [...brouillon[cle], choix], id);
        },
      },
      h('option', { value: '0' }, disponibles.length ? 'Sélectionner…' : 'Aucun élément à ajouter'),
      ...elementsOptions(disponibles))),
    h('div', { class: 'puces' }, ...choisis.map((choix) => {
      const nom = libelleRef(cle, choix);
      return h('button', {
        type: 'button',
        class: 'fr-tag fr-tag--dismiss',
        'aria-label': `Retirer ${nom}`,
        onclick: () => definirReference(cle, brouillon[cle].filter((x) => x !== choix), id),
      }, nom);
    })));
}

// ---------------------------------------------------------------------------
// Réception des données de Grist
// ---------------------------------------------------------------------------

// Appelé quand le curseur change de ligne ET quand les données de la ligne changent.
async function afficher(rec, mappings) {
  const monJeton = ++jeton;

  if (!rec) {
    enregistrement = null;
    enEdition = false;
    montrer('vide');
    return;
  }

  // Grist renvoie les noms de colonnes de la table : on les remappe vers ceux du widget.
  const mappe = grist.mapColumnNames(rec);
  const memeLigne = Boolean(enregistrement) && enregistrement.id === mappe.id;
  const modifiee = !memeLigne || !egal(mappe, enregistrement);

  if (!memeLigne) {
    enEdition = false;
    brouillon = null;
    original = null;
    animerFrise = true;
    derniereSignature = null;
  }
  enregistrement = mappe;

  if (!('titre' in mappe)) {
    montrer('config');
    return;
  }

  mappingsGrist = mappings || {};
  await preparerReferences(modifiee); // libellés à jour si la ligne a changé
  if (monJeton !== jeton) return;

  montrer('application');
  if (enEdition) fusionnerExterne();  // la saisie en cours n'est pas écrasée
  else rendreSiChangement();
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

grist.ready({
  requiredAccess: 'full',
  columns: COLONNES,
});

grist.onRecord(afficher, { keepEncoded: true, expandRefs: false });

window.addEventListener('resize', () => majFrise());
document.fonts?.ready.then(() => majFrise());
