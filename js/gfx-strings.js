// gfx-strings.js — localized strings for the Graphics settings panel.
// The rest of the game ships in English only (spec §10); this panel follows
// navigator.language across the nine target locales.

const EN = {
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  preset: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Colour grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', particles: 'Particles',
    background: 'Background motion', detail: 'Detail',
  },
  tier: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Static', animated: 'Animated',
    plain: 'Plain', detailed: 'Detailed',
  },
  adaptive: 'Adaptive resolution',
  showFps: 'Show frame rate',
  unknownGpu: 'unknown GPU',
  postFailed: 'Post-processing is unavailable on this device; the shelf renders without it.',
  noWebgl: 'The 3D shelf is unavailable here; these settings apply to the vessel board only.',
};

const STRINGS = {
  'en-US': { ...EN, cat: { ...EN.cat, grade: 'Color grade' } },
  'en-GB': EN,
  'es-419': {
    quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    preset: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
    cat: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Antialiasing', reflections: 'Reflejos', particles: 'Partículas', background: 'Movimiento de fondo', detail: 'Detalle' },
    tier: { off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Estático', animated: 'Animado', plain: 'Simple', detailed: 'Detallado' },
    adaptive: 'Resolución adaptable', showFps: 'Mostrar cuadros por segundo', unknownGpu: 'GPU desconocida',
    postFailed: 'El posprocesamiento no está disponible en este dispositivo; el estante se muestra sin él.',
    noWebgl: 'El estante 3D no está disponible aquí; estos ajustes solo afectan al tablero de recipientes.',
  },
  'es-ES': {
    quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    preset: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    renderScale: 'Escala de renderizado', fromPreset: 'Según el preajuste ({tier})',
    cat: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Etalonaje', antialias: 'Antialiasing', reflections: 'Reflejos', particles: 'Partículas', background: 'Movimiento de fondo', detail: 'Detalle' },
    tier: { off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Estático', animated: 'Animado', plain: 'Sencillo', detailed: 'Detallado' },
    adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo', unknownGpu: 'GPU desconocida',
    postFailed: 'El posprocesado no está disponible en este dispositivo; la estantería se muestra sin él.',
    noWebgl: 'La estantería 3D no está disponible aquí; estos ajustes solo afectan al tablero de recipientes.',
  },
  'de-DE': {
    quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
    preset: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    renderScale: 'Renderskalierung', fromPreset: 'Aus Voreinstellung ({tier})',
    cat: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchten', grade: 'Farbkorrektur', antialias: 'Kantenglättung', reflections: 'Spiegelungen', particles: 'Partikel', background: 'Hintergrundbewegung', detail: 'Details' },
    tier: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statisch', animated: 'Animiert', plain: 'Schlicht', detailed: 'Detailliert' },
    adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen', unknownGpu: 'unbekannte GPU',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Regal wird ohne sie dargestellt.',
    noWebgl: 'Das 3D-Regal ist hier nicht verfügbar; diese Einstellungen betreffen nur das Gefäßbrett.',
  },
  'fr-FR': {
    quality: 'Qualité', auto: 'Automatique (détecté : {tier})',
    preset: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
    cat: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage', antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Particules', background: 'Animation du décor', detail: 'Détails' },
    tier: { off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statique', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé' },
    adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde', unknownGpu: 'GPU inconnu',
    postFailed: 'Le post-traitement est indisponible sur cet appareil ; l’étagère s’affiche sans lui.',
    noWebgl: 'L’étagère 3D est indisponible ici ; ces réglages ne s’appliquent qu’au plateau de fioles.',
  },
  'fr-CA': {
    quality: 'Qualité', auto: 'Automatique (détectée : {tier})',
    preset: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
    cat: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Correction des couleurs', antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Particules', background: 'Animation du décor', detail: 'Détails' },
    tier: { off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statique', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé' },
    adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images', unknownGpu: 'processeur graphique inconnu',
    postFailed: 'Le post-traitement n’est pas offert sur cet appareil; l’étagère s’affiche sans lui.',
    noWebgl: 'L’étagère 3D n’est pas offerte ici; ces réglages ne s’appliquent qu’au plateau de fioles.',
  },
  'pt-BR': {
    quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
    preset: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    renderScale: 'Escala de renderização', fromPreset: 'Da predefinição ({tier})',
    cat: { shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Antisserrilhamento', reflections: 'Reflexos', particles: 'Partículas', background: 'Movimento do cenário', detail: 'Detalhes' },
    tier: { off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Estático', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado' },
    adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros', unknownGpu: 'GPU desconhecida',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; a prateleira é exibida sem ele.',
    noWebgl: 'A prateleira 3D não está disponível aqui; estas opções afetam só o tabuleiro de frascos.',
  },
  'it-IT': {
    quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
    preset: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    renderScale: 'Scala di rendering', fromPreset: 'Da preimpostazione ({tier})',
    cat: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing', reflections: 'Riflessi', particles: 'Particelle', background: 'Movimento dello sfondo', detail: 'Dettagli' },
    tier: { off: 'Disattivato', on: 'Attivato', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statico', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato' },
    adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi', unknownGpu: 'GPU sconosciuta',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; lo scaffale viene mostrato senza.',
    noWebgl: 'Lo scaffale 3D non è disponibile qui; queste impostazioni valgono solo per il tavolo delle fiale.',
  },
};

export const GFX_LOCALES = Object.keys(STRINGS);

/** Best supported locale for a BCP-47 tag (e.g. 'es-MX' → 'es-419', 'fr' → 'fr-FR'). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  if (STRINGS[t]) return t;
  const lang = t.split('-')[0].toLowerCase();
  const region = (t.split('-')[1] || '').toUpperCase();
  if (lang === 'en') return ['GB', 'IE', 'AU', 'NZ', 'ZA', 'IN'].includes(region) ? 'en-GB' : 'en-US';
  if (lang === 'es') return region === 'ES' || !region ? 'es-ES' : 'es-419';
  if (lang === 'fr') return region === 'CA' ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

export function gfxStrings(tag) {
  return STRINGS[pickLocale(tag)];
}

/** Fill "{tier}"-style placeholders. */
export function fmt(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? vars[k] : ''));
}
