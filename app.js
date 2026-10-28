/*
 * Widget Grist « Projet ARIANE »
 * Lit la ligne sélectionnée de la table et écrit chaque modification dans Grist.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Identifiant de la table référencée par « Agents ARIANE concernés ».
const TABLE_AGENTS = 'agents';

// Colonne de la table agents affichée dans la liste (null = 1re colonne texte trouvée).
const COLONNE_LIBELLE_AGENT = null;

// Valeurs du statut et classe DSFR du badge correspondant.
const STATUTS = {
  'En attente': 'fr-badge--warning',
  'Annulé': 'fr-badge--error',
  'Terminé': 'fr-badge--success',
};

// Colonnes utilisées par le widget. Le nom sert de clé ; Grist propose
// l'association avec une colonne de la table dans le panneau de droite.
const COLONNES = [
  { name: 'titre', title: 'Titre', type: 'Text' },
  { name: 'responsable', title: 'Responsable du projet', type: 'Text', optional: true },
  { name: 'categorie', title: 'Catégorie', type: 'Any', optional: true },
  { name: 'sous_categorie', title: 'Sous-catégorie', type: 'Any', optional: true },
  { name: 'descriptif', title: 'Descriptif du projet', type: 'Text', optional: true },
  { name: 'missions_fondatrices_rattachees', title: 'Missions fondatrices rattachées', type: 'Any', optional: true },
  { name: 'echeance', title: 'Échéance', type: 'Date', optional: true },
  { name: 'statut', title: 'Statut', type: 'Choice', optional: true },
  { name: 'agents_ariane', title: 'Agents ARIANE concernés', type: 'RefList', optional: true },
  { name: 'autres_agents', title: 'Autres agents concernés', type: 'Text', optional: true },
  { name: 'autres_interlocuteurs', title: 'Autres interlocuteurs concernés', type: 'Text', optional: true },
  { name: 'lien_ressource', title: 'Lien ressource', type: 'Text', optional: true },
  { name: 'lien_article_presse', title: "Lien vers l'article de presse", type: 'Text', optional: true },
  { name: 'etapes', title: 'Étapes (JSON)', type: 'Text', optional: true },
];

// Champs texte éditables : clé widget -> identifiant de l'élément HTML.
const CHAMPS_EDITABLES = {
  responsable: 'responsable',
  descriptif: 'descriptif',
  autres_agents: 'autres-agents',
  autres_interlocuteurs: 'autres-interlocuteurs',
  lien_ressource: 'lien-ressource',
  lien_article_presse: 'lien-article',
};

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

let enregistrement = null;   // ligne courante (clés = noms des colonnes du widget)
let agents = new Map();      // id d'agent -> libellé
let etapes = [];             // liste des étapes de la ligne courante
let etapesValides = true;    // false si la colonne etapes ne contient pas un tableau JSON

// ---------------------------------------------------------------------------
// Aides
// ---------------------------------------------------------------------------

const $ = (selecteur) => document.querySelector(selecteur);

// Retire l'encodage Grist (['L', ...], ['d', ts], ['r', table, ids]...).
function dechiffrer(valeur) {
  if (!Array.isArray(valeur)) return valeur;
  const [type] = valeur;
  if (type === 'L' || type === 'l') return valeur.slice(1);
  if (type === 'r' || type === 'R') return Array.isArray(valeur[2]) ? valeur[2] : [];
  if (type === 'd' || type === 'D') return valeur[1];
  return valeur;
}

function texte(valeur) {
  const x = dechiffrer(valeur);
  if (x === null || x === undefined) return '';
  if (Array.isArray(x)) return x.join(', ');
  return String(x);
}

// Date Grist : secondes depuis epoch (UTC) ou chaîne ISO.
function versDate(valeur) {
  const x = dechiffrer(valeur);
  if (x === null || x === undefined || x === '') return null;
  const d = typeof x === 'number' ? new Date(x * 1000) : new Date(x);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formaterDate(date) {
  return date ? date.toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—';
}

// Date saisie via <input type="date"> (YYYY-MM-DD).
function formaterDateIso(iso) {
  if (!iso) return '';
  return formaterDate(new Date(`${iso}T00:00:00Z`));
}

// Liste d'identifiants de référence (RefList).
function idsReferences(valeur) {
  const x = dechiffrer(valeur);
  return Array.isArray(x) ? x.filter((v) => typeof v === 'number') : [];
}

// Table renvoyée en lignes -> en colonnes (format attendu par le reste du code).
function versColonnes(donnees) {
  if (!Array.isArray(donnees)) return donnees;
  const colonnes = {};
  for (const ligne of donnees) {
    for (const [cle, valeur] of Object.entries(ligne)) {
      (colonnes[cle] ||= []).push(valeur);
    }
  }
  return colonnes;
}

// Convertit les champs du widget vers les noms de colonnes réels de la table Grist.
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
}

function afficherErreur(message) {
  $('#message-erreur p').textContent = message;
  $('#message-erreur').hidden = false;
}

function masquerErreur() {
  $('#message-erreur').hidden = true;
}

// ---------------------------------------------------------------------------
// Écriture dans Grist
// ---------------------------------------------------------------------------

async function enregistrer(champs) {
  if (!enregistrement) return;
  const id = enregistrement.id;

  // Mise à jour locale immédiate, puis envoi à Grist.
  Object.assign(enregistrement, champs);
  remplir(enregistrement);

  try {
    const colonnesGrist = versColonnesGrist(champs);
    await grist.getTable().update({ id, ...colonnesGrist });
    masquerErreur();
  } catch (err) {
    console.error(err);
    afficherErreur(`Échec de l'enregistrement : ${err.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

function afficher(rec) {
  if (!rec) {
    enregistrement = null;
    montrer('vide');
    return;
  }
  enregistrement = rec;
  if (!('titre' in rec)) {
    montrer('config');
    return;
  }
  montrer('application');
  remplir(rec);
}

function remplir(rec) {
  // Titre et champs en lecture seule
  $('#titre').textContent = texte(rec.titre) || '(sans titre)';
  $('#categorie').textContent = texte(rec.categorie) || '—';
  $('#sous-categorie').textContent = texte(rec.sous_categorie) || '—';
  $('#missions').textContent = texte(rec.missions_fondatrices_rattachees) || '—';
  $('#echeance').textContent = formaterDate(versDate(rec.echeance));

  // Champs texte éditables
  for (const [champ, idElement] of Object.entries(CHAMPS_EDITABLES)) {
    const el = document.getElementById(idElement);
    el.disabled = !(champ in rec);
    if (document.activeElement !== el) el.value = texte(rec[champ]);
  }
  majLien('lien-ressource', 'lien-ressource-ouvrir');
  majLien('lien-article', 'lien-article-ouvrir');

  remplirStatut(rec);
  remplirAgents(rec);
  chargerEtapes(rec);
  afficherEtapes(rec);
}

function remplirStatut(rec) {
  const statut = texte(rec.statut);
  const select = $('#statut');
  select.disabled = !('statut' in rec);
  if (document.activeElement !== select) select.value = statut;

  const badge = $('#statut-badge');
  badge.className = `fr-badge fr-badge--sm fr-badge--no-icon ${STATUTS[statut] || 'fr-badge--info'}`;
  badge.textContent = statut || 'Non renseigné';
}

function majLien(idChamp, idLien) {
  const url = $(`#${idChamp}`).value.trim();
  const lien = $(`#${idLien}`);
  if (/^https?:\/\//i.test(url)) {
    lien.href = url;
    lien.textContent = url;
    lien.hidden = false;
  } else {
    lien.removeAttribute('href');
    lien.textContent = '';
    lien.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Agents ARIANE (liste déroulante multiple)
// ---------------------------------------------------------------------------

function remplirAgents(rec) {
  const selection = idsReferences(rec.agents_ariane);
  const select = $('#agents-select');
  select.disabled = !('agents_ariane' in rec);

  select.replaceChildren(new Option(agents.size ? 'Ajouter un agent…' : 'Aucun agent disponible', ''));
  for (const [id, libelle] of agents) {
    if (!selection.includes(id)) select.add(new Option(libelle, String(id)));
  }
  select.value = '';

  const zone = $('#agents-tags');
  zone.replaceChildren(...selection.map((id) => {
    const libelle = agents.get(id) ?? `Agent n°${id}`;
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'fr-tag fr-tag--dismiss';
    tag.textContent = libelle;
    tag.setAttribute('aria-label', `Retirer ${libelle}`);
    tag.disabled = select.disabled;
    tag.addEventListener('click', () => {
      enregistrer({ agents_ariane: ['L', ...selection.filter((x) => x !== id)] });
    });
    return tag;
  }));
}

async function chargerAgents() {
  try {
    const brut = await grist.docApi.fetchTable(TABLE_AGENTS);
    const table = versColonnes(brut);
    const ids = table.id || [];
    const colonne = COLONNE_LIBELLE_AGENT
      || Object.keys(table).find((c) => c !== 'id' && c !== 'manualSort'
        && Array.isArray(table[c]) && table[c].some((v) => typeof v === 'string'));

    agents = new Map(
      ids.map((id, i) => [id, String(colonne && table[colonne][i] ? table[colonne][i] : `Agent n°${id}`)]),
    );
    agents = new Map([...agents].sort((a, b) => a[1].localeCompare(b[1], 'fr')));
    if (enregistrement) remplir(enregistrement);
  } catch (err) {
    console.error(err);
    afficherErreur(`Impossible de lire la table « ${TABLE_AGENTS} » : ${err.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Étapes (stockées en JSON dans la colonne etapes)
// ---------------------------------------------------------------------------

function chargerEtapes(rec) {
  const brut = texte(rec.etapes);
  etapesValides = true;
  etapes = [];
  if (!brut) return;
  try {
    const valeur = JSON.parse(brut);
    if (Array.isArray(valeur)) etapes = valeur;
    else etapesValides = false;
  } catch {
    etapesValides = false;
  }
}

function afficherEtapes(rec) {
  const actif = 'etapes' in rec && etapesValides;
  $('#etape-form').querySelectorAll('input, button').forEach((el) => { el.disabled = !actif; });

  const liste = $('#etapes-liste');
  liste.replaceChildren();

  if (!etapesValides) {
    liste.append(creerLigneInfo('La colonne « etapes » ne contient pas un tableau JSON valide : modification désactivée.'));
    return;
  }
  if (!etapes.length) {
    liste.append(creerLigneInfo('Aucune étape pour le moment.'));
    return;
  }

  etapes.forEach((etape, index) => {
    const li = document.createElement('li');
    li.className = 'etape';

    const groupe = document.createElement('div');
    groupe.className = 'fr-checkbox-group';

    const cocher = document.createElement('input');
    cocher.type = 'checkbox';
    cocher.id = `liste-etape-${index}`;
    cocher.checked = Boolean(etape.fait);
    cocher.disabled = !actif;
    cocher.addEventListener('change', () => {
      const nouvelles = etapes.map((e, i) => (i === index ? { ...e, fait: cocher.checked } : e));
      enregistrer({ etapes: JSON.stringify(nouvelles) });
    });

    const label = document.createElement('label');
    label.className = 'fr-label';
    label.htmlFor = cocher.id;
    label.textContent = etape.texte || '(sans libellé)';
    const indication = document.createElement('span');
    indication.className = 'fr-hint-text';
    indication.textContent = etape.date
      ? `Date de réalisation : ${formaterDateIso(etape.date)}`
      : 'Pas de date de réalisation';
    label.append(indication);

    groupe.append(cocher, label);

    const supprimer = document.createElement('button');
    supprimer.type = 'button';
    supprimer.className = 'fr-btn fr-btn--tertiary fr-btn--sm fr-icon-delete-line fr-btn--icon-left';
    supprimer.textContent = 'Supprimer';
    supprimer.disabled = !actif;
    supprimer.addEventListener('click', () => {
      enregistrer({ etapes: JSON.stringify(etapes.filter((_, i) => i !== index)) });
    });

    li.append(groupe, supprimer);
    liste.append(li);
  });
}

function creerLigneInfo(message) {
  const li = document.createElement('li');
  li.className = 'fr-text--sm fr-py-1w';
  li.textContent = message;
  return li;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function initialiserStatutSelect() {
  const select = $('#statut');
  select.replaceChildren(new Option('— Choisir —', ''));
  for (const valeur of Object.keys(STATUTS)) select.add(new Option(valeur, valeur));
}

function brancherEvenements() {
  // Statut
  $('#statut').addEventListener('change', (e) => {
    enregistrer({ statut: e.target.value });
  });

  // Champs texte éditables : enregistrement à la validation (change)
  for (const [champ, idElement] of Object.entries(CHAMPS_EDITABLES)) {
    const el = document.getElementById(idElement);
    el.addEventListener('change', () => {
      enregistrer({ [champ]: el.value.trim() });
    });
  }
  // Liens : mise à jour du lien cliquable pendant la saisie
  $('#lien-ressource').addEventListener('input', () => majLien('lien-ressource', 'lien-ressource-ouvrir'));
  $('#lien-article').addEventListener('input', () => majLien('lien-article', 'lien-article-ouvrir'));

  // Agents : ajout d'un agent sélectionné dans la liste
  $('#agents-select').addEventListener('change', (e) => {
    if (!e.target.value || !enregistrement) return;
    const actuels = idsReferences(enregistrement.agents_ariane);
    enregistrer({ agents_ariane: ['L', ...actuels, Number(e.target.value)] });
  });

  // Étapes : ajout
  $('#etape-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const champTexte = $('#etape-texte');
    const champDate = $('#etape-date');
    const libelle = champTexte.value.trim();
    if (!libelle || !enregistrement) return;

    const nouvelle = { texte: libelle, date: champDate.value || '', fait: false };
    enregistrer({ etapes: JSON.stringify([...etapes, nouvelle]) });

    champTexte.value = '';
    champDate.value = '';
    champTexte.focus();
  });
}

initialiserStatutSelect();
brancherEvenements();

grist.ready({
  requiredAccess: 'full',
  columns: COLONNES,
});

grist.onRecord(afficher, { keepEncoded: true, expandRefs: false });

chargerAgents();
