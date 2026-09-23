/**
 * Translations of the shared UI strings in `en.ts`.
 *
 * Each locale is a deep-partial override of the English source, type-checked
 * against its shape: a key that does not exist in English will not compile, and
 * a key a locale leaves out falls back to English. `copy-locales.spec.ts` keeps
 * every locale complete.
 */

import type { CopyShape } from './en';

type Widen<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Widen<U>[]
    : { -readonly [K in keyof T]: Widen<T[K]> };

export type CopyStrings = Widen<CopyShape>;

export type CopyOverride = {
  [K in keyof CopyStrings]?: CopyStrings[K] extends readonly unknown[]
    ? CopyStrings[K]
    : { [P in keyof CopyStrings[K]]?: CopyStrings[K][P] extends string ? string : Partial<CopyStrings[K][P]> };
};

/** Counted nouns and a few sentence shapes, per locale (see `say`). */
export interface SayStrings {
  nouns: Record<'source' | 'file' | 'result' | 'step' | 'conversation', [one: string, other: string]>;
  stepOf: (current: number, total: number) => string;
}

const es: CopyOverride = {
  actions: {
    copy: 'Copiar', copied: 'Copiado', copyCode: 'Copiar código', edit: 'Editar', retry: 'Reintentar',
    regenerate: 'Regenerar', delete: 'Eliminar', cancel: 'Cancelar', close: 'Cerrar', save: 'Guardar',
    stop: 'Detener', more: 'Más', open: 'Abrir', download: 'Descargar', export: 'Exportar',
    confirm: 'Confirmar', rename: 'Renombrar', remove: 'Quitar', add: 'Añadir', test: 'Probar',
    show: 'Mostrar', hide: 'Ocultar', back: 'Atrás', apply: 'Aplicar', revert: 'Revertir',
    restore: 'Restaurar', reveal: 'Mostrar en carpeta', copyPath: 'Copiar ruta', continue: 'Continuar',
    load: 'Cargar', unload: 'Descargar de memoria', refresh: 'Actualizar'
  },
  confirm: {
    deleteMessage: { title: '¿Eliminar mensaje?', message: 'Esta acción no se puede deshacer.' },
    deleteChat: { title: '¿Eliminar chat?', message: 'Esta acción no se puede deshacer.' },
    discardChanges: { title: '¿Descartar cambios?', message: 'Se perderán tus ediciones.', confirmLabel: 'Descartar' }
  },
  empty: {
    noMatches: 'Sin resultados', noMatchesHint: 'Prueba con otro término', noConversations: 'Aún no hay conversaciones',
    noMessages: 'Aún no hay mensajes', noSources: 'Sin fuentes', noActivity: 'Sin actividad'
  },
  status: {
    working: 'Trabajando', thinking: 'Pensando', planning: 'Planificando', reasoning: 'Razonando', writing: 'Escribiendo',
    searching: 'Buscando', reading: 'Leyendo', loading: 'Cargando', saving: 'Guardando', listening: 'Escuchando',
    transcribing: 'Transcribiendo', processing: 'Procesando', downloading: 'Descargando', extracting: 'Extrayendo'
  },
  tool: {
    needsApproval: 'Requiere aprobación', approvalLede: 'La ejecución está en pausa hasta que decidas.',
    allow: 'Permitir', deny: 'Denegar', failed: 'Falló', cancelled: 'Cancelado', stopped: 'Detenido',
    done: 'Hecho', error: 'Error', result: 'Resultado', truncated: '… (recortado)'
  },
  codeRun: { read: 'Leer', write: 'Escribir', edit: 'Editar', bash: 'Ejecutar', grep: 'Buscar', ls: 'Listar', todo_write: 'Actualizar tareas', git_status: 'Estado de Git', git_diff: 'Diff de Git', approvePlan: 'Aprobar plan', approval: 'Aprobación', approved: 'Aprobado', denied: 'Denegado', compacting: 'Compactando contexto', compacted: 'Contexto compactado', continuing: 'Límite de salida alcanzado — continuando', planNote: 'Al aprobar, el agente empieza a editar; cada edición sigue pidiendo permiso.', turnLimit: 'Detenido por el límite de turnos', interrupted: 'Interrumpido — la app se cerró durante esta ejecución', plan: 'Plan' },
  untitled: { home: 'Nuevo chat', code: 'Nueva conversación', roleplay: 'Nuevo rol' },
  spaces: { home: 'Inicio', code: 'Código', roleplay: 'Rol' },
  roleplay: {
    newRoleplay: 'Nuevo rol', characters: 'Personajes', library: 'Biblioteca de personajes', newCharacter: 'Nuevo personaje',
    importCharacter: 'Importar', pickCharacter: 'Elige un personaje para empezar', pickCharacterHint: 'Los personajes que crees aparecen aquí.',
    noRoleplays: 'Aún no hay sesiones de rol', noRoleplaysHint: 'Empieza una escena con un personaje y aparecerá aquí.',
    enableInSettings: 'Activa Rol en Ajustes → General.'
  },
  thread: {
    activity: 'Actividad', jumpToLatest: 'Ir al final', previousVersion: 'Versión anterior', nextVersion: 'Versión siguiente',
    jumpToSelection: 'Ir a la selección original', generationFailed: 'La generación falló', listen: 'Escuchar',
    stopListening: 'Detener', sources: 'Fuentes', outputTokens: 'tok de salida'
  },
  composer: {
    placeholder: 'Pregunta lo que quieras', errorPlaceholder: 'Algo salió mal. Inténtalo de nuevo.', send: 'Enviar mensaje',
    stop: 'Detener respuesta', attach: 'Adjuntar', dictate: 'Dictar', dropFiles: 'Suelta los archivos aquí',
    dropHint: 'Imágenes, PDF, documentos', hint: 'Enter para enviar · Shift+Enter para nueva línea', selectMode: 'Elegir modo',
    selectSearchMode: 'Elegir modo de búsqueda', documents: 'Documentos', clearAll: 'Quitar todo'
  },
  emptyState: {
    greeting: '¿En qué puedo ayudarte hoy?',
    suggestions: [
      { id: 'weather', label: 'Clima', prompt: '¿Qué tiempo hace hoy?' },
      { id: 'code', label: 'Código', prompt: 'Ayúdame a escribir una función que ' },
      { id: 'write', label: 'Escribir', prompt: 'Ayúdame a escribir ' },
      { id: 'analyze', label: 'Analizar', prompt: 'Analiza esto:\n\n' },
      { id: 'brainstorm', label: 'Ideas', prompt: 'Dame ideas para ' }
    ]
  },
  model: {
    loading: 'Cargando modelo…', none: 'Ningún modelo cargado', browseAll: 'Ver todos los modelos',
    changeRuntime: 'Cambiar runtime', configureProvider: 'Configurar un proveedor'
  },
  viewer: {
    loadingPdf: 'Cargando PDF…', loadingFile: 'Cargando archivo…', convertingDocument: 'Convirtiendo documento…',
    convertingSpreadsheet: 'Convirtiendo hoja de cálculo…', previewUnavailable: 'Vista previa no disponible'
  },
  search: { chats: 'Buscar chats', placeholder: 'Buscar chats…' },
  searchModes: {
    chat: { label: 'Auto', description: 'Usa herramientas y búsqueda cuando haga falta' },
    search: { label: 'Buscar', description: 'Consulta web rápida' },
    deep: { label: 'Profunda', description: 'Investigación a fondo · más fuentes' },
    max: { label: 'Máx', description: 'Investigación exhaustiva · más lenta, más fuentes' }
  }
};

const ptBR: CopyOverride = {
  actions: {
    copy: 'Copiar', copied: 'Copiado', copyCode: 'Copiar código', edit: 'Editar', retry: 'Tentar de novo',
    regenerate: 'Regenerar', delete: 'Excluir', cancel: 'Cancelar', close: 'Fechar', save: 'Salvar',
    stop: 'Parar', more: 'Mais', open: 'Abrir', download: 'Baixar', export: 'Exportar',
    confirm: 'Confirmar', rename: 'Renomear', remove: 'Remover', add: 'Adicionar', test: 'Testar',
    show: 'Mostrar', hide: 'Ocultar', back: 'Voltar', apply: 'Aplicar', revert: 'Reverter',
    restore: 'Restaurar', reveal: 'Mostrar na pasta', copyPath: 'Copiar caminho', continue: 'Continuar',
    load: 'Carregar', unload: 'Descarregar', refresh: 'Atualizar'
  },
  confirm: {
    deleteMessage: { title: 'Excluir mensagem?', message: 'Isso não pode ser desfeito.' },
    deleteChat: { title: 'Excluir chat?', message: 'Isso não pode ser desfeito.' },
    discardChanges: { title: 'Descartar alterações?', message: 'Suas edições serão perdidas.', confirmLabel: 'Descartar' }
  },
  empty: {
    noMatches: 'Nenhum resultado', noMatchesHint: 'Tente outro termo', noConversations: 'Nenhuma conversa ainda',
    noMessages: 'Nenhuma mensagem ainda', noSources: 'Sem fontes', noActivity: 'Sem atividade'
  },
  status: {
    working: 'Trabalhando', thinking: 'Pensando', planning: 'Planejando', reasoning: 'Raciocinando', writing: 'Escrevendo',
    searching: 'Pesquisando', reading: 'Lendo', loading: 'Carregando', saving: 'Salvando', listening: 'Ouvindo',
    transcribing: 'Transcrevendo', processing: 'Processando', downloading: 'Baixando', extracting: 'Extraindo'
  },
  tool: {
    needsApproval: 'Precisa de aprovação', approvalLede: 'A execução está pausada até você decidir.',
    allow: 'Permitir', deny: 'Negar', failed: 'Falhou', cancelled: 'Cancelado', stopped: 'Parado',
    done: 'Concluído', error: 'Erro', result: 'Resultado', truncated: '… (truncado)'
  },
  codeRun: { read: 'Ler', write: 'Escrever', edit: 'Editar', bash: 'Executar', grep: 'Pesquisar', ls: 'Listar', todo_write: 'Atualizar tarefas', git_status: 'Status do Git', git_diff: 'Diff do Git', approvePlan: 'Aprovar plano', approval: 'Aprovação', approved: 'Aprovado', denied: 'Negado', compacting: 'Compactando contexto', compacted: 'Contexto compactado', continuing: 'Limite de saída atingido — continuando', planNote: 'Ao aprovar, o agente começa a editar; cada edição ainda pede permissão.', turnLimit: 'Parado no limite de turnos', interrupted: 'Interrompido — o app fechou durante esta execução', plan: 'Plano' },
  untitled: { home: 'Novo chat', code: 'Nova conversa', roleplay: 'Novo roleplay' },
  spaces: { home: 'Início', code: 'Código', roleplay: 'Roleplay' },
  roleplay: {
    newRoleplay: 'Novo roleplay', characters: 'Personagens', library: 'Biblioteca de personagens', newCharacter: 'Novo personagem',
    importCharacter: 'Importar', pickCharacter: 'Escolha um personagem para começar', pickCharacterHint: 'Os personagens que você criar aparecem aqui.',
    noRoleplays: 'Nenhuma sessão de roleplay ainda', noRoleplaysHint: 'Comece uma cena com um personagem e ela aparecerá aqui.',
    enableInSettings: 'Ative o Roleplay em Configurações → Geral.'
  },
  thread: {
    activity: 'Atividade', jumpToLatest: 'Ir para o fim', previousVersion: 'Versão anterior', nextVersion: 'Próxima versão',
    jumpToSelection: 'Ir para a seleção original', generationFailed: 'A geração falhou', listen: 'Ouvir',
    stopListening: 'Parar', sources: 'Fontes', outputTokens: 'tok de saída'
  },
  composer: {
    placeholder: 'Pergunte qualquer coisa', errorPlaceholder: 'Algo deu errado. Tente de novo.', send: 'Enviar mensagem',
    stop: 'Parar resposta', attach: 'Anexar', dictate: 'Ditar', dropFiles: 'Solte os arquivos aqui',
    dropHint: 'Imagens, PDFs, documentos', hint: 'Enter para enviar · Shift+Enter para nova linha', selectMode: 'Escolher modo',
    selectSearchMode: 'Escolher modo de pesquisa', documents: 'Documentos', clearAll: 'Limpar tudo'
  },
  emptyState: {
    greeting: 'Como posso ajudar hoje?',
    suggestions: [
      { id: 'weather', label: 'Clima', prompt: 'Como está o tempo hoje?' },
      { id: 'code', label: 'Código', prompt: 'Me ajude a escrever uma função que ' },
      { id: 'write', label: 'Escrever', prompt: 'Me ajude a escrever ' },
      { id: 'analyze', label: 'Analisar', prompt: 'Analise isto para mim:\n\n' },
      { id: 'brainstorm', label: 'Ideias', prompt: 'Sugira ideias para ' }
    ]
  },
  model: {
    loading: 'Carregando modelo…', none: 'Nenhum modelo carregado', browseAll: 'Ver todos os modelos',
    changeRuntime: 'Trocar runtime', configureProvider: 'Configurar um provedor'
  },
  viewer: {
    loadingPdf: 'Carregando PDF…', loadingFile: 'Carregando arquivo…', convertingDocument: 'Convertendo documento…',
    convertingSpreadsheet: 'Convertendo planilha…', previewUnavailable: 'Pré-visualização indisponível'
  },
  search: { chats: 'Pesquisar chats', placeholder: 'Pesquisar chats…' },
  searchModes: {
    chat: { label: 'Auto', description: 'Usa ferramentas e pesquisa quando necessário' },
    search: { label: 'Pesquisa', description: 'Consulta rápida na web' },
    deep: { label: 'Profunda', description: 'Pesquisa detalhada · mais fontes' },
    max: { label: 'Máx', description: 'Pesquisa exaustiva · mais lenta, mais fontes' }
  }
};

const fr: CopyOverride = {
  actions: {
    copy: 'Copier', copied: 'Copié', copyCode: 'Copier le code', edit: 'Modifier', retry: 'Réessayer',
    regenerate: 'Régénérer', delete: 'Supprimer', cancel: 'Annuler', close: 'Fermer', save: 'Enregistrer',
    stop: 'Arrêter', more: 'Plus', open: 'Ouvrir', download: 'Télécharger', export: 'Exporter',
    confirm: 'Confirmer', rename: 'Renommer', remove: 'Retirer', add: 'Ajouter', test: 'Tester',
    show: 'Afficher', hide: 'Masquer', back: 'Retour', apply: 'Appliquer', revert: 'Annuler les modifications',
    restore: 'Restaurer', reveal: 'Afficher dans le dossier', copyPath: 'Copier le chemin', continue: 'Continuer',
    load: 'Charger', unload: 'Décharger', refresh: 'Actualiser'
  },
  confirm: {
    deleteMessage: { title: 'Supprimer le message ?', message: 'Cette action est irréversible.' },
    deleteChat: { title: 'Supprimer la conversation ?', message: 'Cette action est irréversible.' },
    discardChanges: { title: 'Abandonner les modifications ?', message: 'Vos modifications seront perdues.', confirmLabel: 'Abandonner' }
  },
  empty: {
    noMatches: 'Aucun résultat', noMatchesHint: 'Essayez un autre terme', noConversations: 'Aucune conversation pour l’instant',
    noMessages: 'Aucun message pour l’instant', noSources: 'Aucune source', noActivity: 'Aucune activité'
  },
  status: {
    working: 'En cours', thinking: 'Réflexion', planning: 'Planification', reasoning: 'Raisonnement', writing: 'Rédaction',
    searching: 'Recherche', reading: 'Lecture', loading: 'Chargement', saving: 'Enregistrement', listening: 'Écoute',
    transcribing: 'Transcription', processing: 'Traitement', downloading: 'Téléchargement', extracting: 'Extraction'
  },
  tool: {
    needsApproval: 'Approbation requise', approvalLede: 'L’exécution est en pause jusqu’à votre décision.',
    allow: 'Autoriser', deny: 'Refuser', failed: 'Échec', cancelled: 'Annulé', stopped: 'Arrêté',
    done: 'Terminé', error: 'Erreur', result: 'Résultat', truncated: '… (tronqué)'
  },
  codeRun: { read: 'Lire', write: 'Écrire', edit: 'Modifier', bash: 'Exécuter', grep: 'Rechercher', ls: 'Lister', todo_write: 'Mettre à jour les tâches', git_status: 'État Git', git_diff: 'Diff Git', approvePlan: 'Approuver le plan', approval: 'Approbation', approved: 'Approuvé', denied: 'Refusé', compacting: 'Compactage du contexte', compacted: 'Contexte compacté', continuing: 'Limite de sortie atteinte — poursuite', planNote: 'Approuver permet à l’agent de commencer à modifier ; chaque modification demande encore votre accord.', turnLimit: 'Arrêté à la limite de tours', interrupted: 'Interrompu — l’application s’est fermée pendant l’exécution', plan: 'Plan' },
  untitled: { home: 'Nouvelle conversation', code: 'Nouvelle conversation', roleplay: 'Nouveau jeu de rôle' },
  spaces: { home: 'Accueil', code: 'Code', roleplay: 'Jeu de rôle' },
  roleplay: {
    newRoleplay: 'Nouveau jeu de rôle', characters: 'Personnages', library: 'Bibliothèque de personnages', newCharacter: 'Nouveau personnage',
    importCharacter: 'Importer', pickCharacter: 'Choisissez un personnage pour commencer', pickCharacterHint: 'Les personnages que vous créez apparaissent ici.',
    noRoleplays: 'Aucune session de jeu de rôle', noRoleplaysHint: 'Lancez une scène avec un personnage et elle apparaîtra ici.',
    enableInSettings: 'Activez le jeu de rôle dans Réglages → Général.'
  },
  thread: {
    activity: 'Activité', jumpToLatest: 'Aller à la fin', previousVersion: 'Version précédente', nextVersion: 'Version suivante',
    jumpToSelection: 'Aller à la sélection d’origine', generationFailed: 'La génération a échoué', listen: 'Écouter',
    stopListening: 'Arrêter', sources: 'Sources', outputTokens: 'jetons de sortie'
  },
  composer: {
    placeholder: 'Demandez ce que vous voulez', errorPlaceholder: 'Un problème est survenu. Réessayez.', send: 'Envoyer le message',
    stop: 'Arrêter la réponse', attach: 'Joindre', dictate: 'Dicter', dropFiles: 'Déposez les fichiers ici',
    dropHint: 'Images, PDF, documents', hint: 'Entrée pour envoyer · Maj+Entrée pour un saut de ligne', selectMode: 'Choisir le mode',
    selectSearchMode: 'Choisir le mode de recherche', documents: 'Documents', clearAll: 'Tout effacer'
  },
  emptyState: {
    greeting: 'Comment puis-je vous aider aujourd’hui ?',
    suggestions: [
      { id: 'weather', label: 'Météo', prompt: 'Quel temps fait-il aujourd’hui ?' },
      { id: 'code', label: 'Code', prompt: 'Aide-moi à écrire une fonction qui ' },
      { id: 'write', label: 'Écrire', prompt: 'Aide-moi à écrire ' },
      { id: 'analyze', label: 'Analyser', prompt: 'Analyse ceci pour moi :\n\n' },
      { id: 'brainstorm', label: 'Idées', prompt: 'Propose des idées pour ' }
    ]
  },
  model: {
    loading: 'Chargement du modèle…', none: 'Aucun modèle chargé', browseAll: 'Voir tous les modèles',
    changeRuntime: 'Changer de runtime', configureProvider: 'Configurer un fournisseur'
  },
  viewer: {
    loadingPdf: 'Chargement du PDF…', loadingFile: 'Chargement du fichier…', convertingDocument: 'Conversion du document…',
    convertingSpreadsheet: 'Conversion du tableur…', previewUnavailable: 'Aperçu indisponible'
  },
  search: { chats: 'Rechercher des conversations', placeholder: 'Rechercher des conversations…' },
  searchModes: {
    chat: { label: 'Auto', description: 'Utilise les outils et la recherche si besoin' },
    search: { label: 'Recherche', description: 'Vérification web rapide' },
    deep: { label: 'Approfondie', description: 'Recherche poussée · plus de sources' },
    max: { label: 'Max', description: 'Recherche exhaustive · plus lente, plus de sources' }
  }
};

const de: CopyOverride = {
  actions: {
    copy: 'Kopieren', copied: 'Kopiert', copyCode: 'Code kopieren', edit: 'Bearbeiten', retry: 'Erneut versuchen',
    regenerate: 'Neu generieren', delete: 'Löschen', cancel: 'Abbrechen', close: 'Schließen', save: 'Speichern',
    stop: 'Stoppen', more: 'Mehr', open: 'Öffnen', download: 'Herunterladen', export: 'Exportieren',
    confirm: 'Bestätigen', rename: 'Umbenennen', remove: 'Entfernen', add: 'Hinzufügen', test: 'Testen',
    show: 'Anzeigen', hide: 'Ausblenden', back: 'Zurück', apply: 'Anwenden', revert: 'Zurücksetzen',
    restore: 'Wiederherstellen', reveal: 'Im Ordner zeigen', copyPath: 'Pfad kopieren', continue: 'Fortsetzen',
    load: 'Laden', unload: 'Entladen', refresh: 'Aktualisieren'
  },
  confirm: {
    deleteMessage: { title: 'Nachricht löschen?', message: 'Das kann nicht rückgängig gemacht werden.' },
    deleteChat: { title: 'Chat löschen?', message: 'Das kann nicht rückgängig gemacht werden.' },
    discardChanges: { title: 'Änderungen verwerfen?', message: 'Deine Änderungen gehen verloren.', confirmLabel: 'Verwerfen' }
  },
  empty: {
    noMatches: 'Keine Treffer', noMatchesHint: 'Versuche einen anderen Begriff', noConversations: 'Noch keine Unterhaltungen',
    noMessages: 'Noch keine Nachrichten', noSources: 'Keine Quellen', noActivity: 'Keine Aktivität'
  },
  status: {
    working: 'Arbeitet', thinking: 'Denkt nach', planning: 'Plant', reasoning: 'Überlegt', writing: 'Schreibt',
    searching: 'Sucht', reading: 'Liest', loading: 'Lädt', saving: 'Speichert', listening: 'Hört zu',
    transcribing: 'Transkribiert', processing: 'Verarbeitet', downloading: 'Lädt herunter', extracting: 'Entpackt'
  },
  tool: {
    needsApproval: 'Freigabe nötig', approvalLede: 'Der Lauf pausiert, bis du entscheidest.',
    allow: 'Erlauben', deny: 'Ablehnen', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen', stopped: 'Gestoppt',
    done: 'Fertig', error: 'Fehler', result: 'Ergebnis', truncated: '… (gekürzt)'
  },
  codeRun: { read: 'Lesen', write: 'Schreiben', edit: 'Bearbeiten', bash: 'Ausführen', grep: 'Suchen', ls: 'Auflisten', todo_write: 'Aufgaben aktualisieren', git_status: 'Git-Status', git_diff: 'Git-Diff', approvePlan: 'Plan freigeben', approval: 'Freigabe', approved: 'Freigegeben', denied: 'Abgelehnt', compacting: 'Kontext wird verdichtet', compacted: 'Kontext verdichtet', continuing: 'Ausgabelimit erreicht — geht weiter', planNote: 'Mit der Freigabe beginnt der Agent zu bearbeiten; jede Änderung fragt weiterhin einzeln.', turnLimit: 'Am Rundenlimit gestoppt', interrupted: 'Unterbrochen — die App wurde während des Laufs geschlossen', plan: 'Plan' },
  untitled: { home: 'Neuer Chat', code: 'Neue Unterhaltung', roleplay: 'Neues Rollenspiel' },
  spaces: { home: 'Start', code: 'Code', roleplay: 'Rollenspiel' },
  roleplay: {
    newRoleplay: 'Neues Rollenspiel', characters: 'Figuren', library: 'Figurenbibliothek', newCharacter: 'Neue Figur',
    importCharacter: 'Importieren', pickCharacter: 'Wähle eine Figur, um zu beginnen', pickCharacterHint: 'Figuren, die du erstellst, erscheinen hier.',
    noRoleplays: 'Noch keine Rollenspiel-Sitzungen', noRoleplaysHint: 'Starte eine Szene mit einer Figur, dann erscheint sie hier.',
    enableInSettings: 'Aktiviere Rollenspiel unter Einstellungen → Allgemein.'
  },
  thread: {
    activity: 'Aktivität', jumpToLatest: 'Zum Ende springen', previousVersion: 'Vorherige Version', nextVersion: 'Nächste Version',
    jumpToSelection: 'Zur ursprünglichen Auswahl', generationFailed: 'Generierung fehlgeschlagen', listen: 'Anhören',
    stopListening: 'Stoppen', sources: 'Quellen', outputTokens: 'Ausgabe-Tok'
  },
  composer: {
    placeholder: 'Frag irgendwas', errorPlaceholder: 'Etwas ist schiefgelaufen. Versuch es noch einmal.', send: 'Nachricht senden',
    stop: 'Antwort stoppen', attach: 'Anhängen', dictate: 'Diktieren', dropFiles: 'Dateien hier ablegen',
    dropHint: 'Bilder, PDFs, Dokumente', hint: 'Enter zum Senden · Umschalt+Enter für neue Zeile', selectMode: 'Modus wählen',
    selectSearchMode: 'Suchmodus wählen', documents: 'Dokumente', clearAll: 'Alle entfernen'
  },
  emptyState: {
    greeting: 'Wie kann ich dir heute helfen?',
    suggestions: [
      { id: 'weather', label: 'Wetter', prompt: 'Wie ist das Wetter heute?' },
      { id: 'code', label: 'Code', prompt: 'Hilf mir, eine Funktion zu schreiben, die ' },
      { id: 'write', label: 'Schreiben', prompt: 'Hilf mir beim Schreiben von ' },
      { id: 'analyze', label: 'Analysieren', prompt: 'Analysiere das für mich:\n\n' },
      { id: 'brainstorm', label: 'Ideen', prompt: 'Sammle Ideen für ' }
    ]
  },
  model: {
    loading: 'Modell wird geladen…', none: 'Kein Modell geladen', browseAll: 'Alle Modelle anzeigen',
    changeRuntime: 'Runtime wechseln', configureProvider: 'Anbieter einrichten'
  },
  viewer: {
    loadingPdf: 'PDF wird geladen…', loadingFile: 'Datei wird geladen…', convertingDocument: 'Dokument wird konvertiert…',
    convertingSpreadsheet: 'Tabelle wird konvertiert…', previewUnavailable: 'Vorschau nicht verfügbar'
  },
  search: { chats: 'Chats durchsuchen', placeholder: 'Chats durchsuchen…' },
  searchModes: {
    chat: { label: 'Auto', description: 'Nutzt Werkzeuge und Suche bei Bedarf' },
    search: { label: 'Suche', description: 'Schneller Web-Check' },
    deep: { label: 'Gründlich', description: 'Gründliche Recherche · mehr Quellen' },
    max: { label: 'Max', description: 'Umfassende Recherche · langsamer, mehr Quellen' }
  }
};

const ja: CopyOverride = {
  actions: {
    copy: 'コピー', copied: 'コピーしました', copyCode: 'コードをコピー', edit: '編集', retry: '再試行',
    regenerate: '再生成', delete: '削除', cancel: 'キャンセル', close: '閉じる', save: '保存',
    stop: '停止', more: 'その他', open: '開く', download: 'ダウンロード', export: 'エクスポート',
    confirm: '確認', rename: '名前を変更', remove: '削除', add: '追加', test: 'テスト',
    show: '表示', hide: '非表示', back: '戻る', apply: '適用', revert: '元に戻す',
    restore: '復元', reveal: 'フォルダーで表示', copyPath: 'パスをコピー', continue: '続ける',
    load: '読み込む', unload: 'アンロード', refresh: '更新'
  },
  confirm: {
    deleteMessage: { title: 'メッセージを削除しますか？', message: 'この操作は取り消せません。' },
    deleteChat: { title: 'チャットを削除しますか？', message: 'この操作は取り消せません。' },
    discardChanges: { title: '変更を破棄しますか？', message: '編集内容は失われます。', confirmLabel: '破棄' }
  },
  empty: {
    noMatches: '一致なし', noMatchesHint: '別の語句を試してください', noConversations: 'まだ会話はありません',
    noMessages: 'まだメッセージはありません', noSources: 'ソースなし', noActivity: 'アクティビティなし'
  },
  status: {
    working: '作業中', thinking: '思考中', planning: '計画中', reasoning: '推論中', writing: '執筆中',
    searching: '検索中', reading: '読み込み中', loading: '読み込み中', saving: '保存中', listening: '聞き取り中',
    transcribing: '文字起こし中', processing: '処理中', downloading: 'ダウンロード中', extracting: '展開中'
  },
  tool: {
    needsApproval: '承認が必要', approvalLede: '判断するまで実行は一時停止しています。',
    allow: '許可', deny: '拒否', failed: '失敗', cancelled: 'キャンセル済み', stopped: '停止済み',
    done: '完了', error: 'エラー', result: '結果', truncated: '…（省略）'
  },
  codeRun: { read: '読み取り', write: '書き込み', edit: '編集', bash: '実行', grep: '検索', ls: '一覧', todo_write: 'タスクを更新', git_status: 'Git ステータス', git_diff: 'Git 差分', approvePlan: 'プランを承認', approval: '承認', approved: '承認済み', denied: '拒否', compacting: 'コンテキストを圧縮中', compacted: 'コンテキストを圧縮しました', continuing: '出力上限に達しました — 続行中', planNote: '承認するとエージェントが編集を始めます。各編集は引き続き個別に確認します。', turnLimit: 'ターン上限で停止しました', interrupted: '中断 — 実行中にアプリが終了しました', plan: 'プラン' },
  untitled: { home: '新しいチャット', code: '新しい会話', roleplay: '新しいロールプレイ' },
  spaces: { home: 'ホーム', code: 'コード', roleplay: 'ロールプレイ' },
  roleplay: {
    newRoleplay: '新しいロールプレイ', characters: 'キャラクター', library: 'キャラクターライブラリ', newCharacter: '新しいキャラクター',
    importCharacter: 'インポート', pickCharacter: 'キャラクターを選んで始めましょう', pickCharacterHint: '作成したキャラクターがここに表示されます。',
    noRoleplays: 'ロールプレイのセッションはまだありません', noRoleplaysHint: 'キャラクターとシーンを始めるとここに表示されます。',
    enableInSettings: '設定 → 一般 でロールプレイを有効にしてください。'
  },
  thread: {
    activity: 'アクティビティ', jumpToLatest: '最新へ移動', previousVersion: '前のバージョン', nextVersion: '次のバージョン',
    jumpToSelection: '元の選択へ移動', generationFailed: '生成に失敗しました', listen: '聞く',
    stopListening: '停止', sources: 'ソース', outputTokens: '出力トークン'
  },
  composer: {
    placeholder: '何でも聞いてください', errorPlaceholder: '問題が発生しました。もう一度お試しください。', send: 'メッセージを送信',
    stop: '応答を停止', attach: '添付', dictate: '音声入力', dropFiles: 'ここにファイルをドロップ',
    dropHint: '画像、PDF、ドキュメント', hint: 'Enter で送信 · Shift+Enter で改行', selectMode: 'モードを選択',
    selectSearchMode: '検索モードを選択', documents: 'ドキュメント', clearAll: 'すべてクリア'
  },
  emptyState: {
    greeting: '今日はどのようにお手伝いしましょうか？',
    suggestions: [
      { id: 'weather', label: '天気', prompt: '今日の天気はどうですか？' },
      { id: 'code', label: 'コード', prompt: '次のことをする関数を書くのを手伝って: ' },
      { id: 'write', label: '文章', prompt: '次の文章を書くのを手伝って: ' },
      { id: 'analyze', label: '分析', prompt: 'これを分析してください:\n\n' },
      { id: 'brainstorm', label: 'アイデア', prompt: '次のアイデアを出して: ' }
    ]
  },
  model: {
    loading: 'モデルを読み込み中…', none: 'モデルが読み込まれていません', browseAll: 'すべてのモデルを見る',
    changeRuntime: 'ランタイムを変更', configureProvider: 'プロバイダーを設定'
  },
  viewer: {
    loadingPdf: 'PDF を読み込み中…', loadingFile: 'ファイルを読み込み中…', convertingDocument: 'ドキュメントを変換中…',
    convertingSpreadsheet: 'スプレッドシートを変換中…', previewUnavailable: 'プレビューを表示できません'
  },
  search: { chats: 'チャットを検索', placeholder: 'チャットを検索…' },
  searchModes: {
    chat: { label: '自動', description: '必要に応じてツールと検索を使用' },
    search: { label: '検索', description: 'すばやいウェブ確認' },
    deep: { label: '詳細', description: '徹底調査 · より多くのソース' },
    max: { label: '最大', description: '網羅的な調査 · 低速、より多くのソース' }
  }
};

const zh: CopyOverride = {
  actions: {
    copy: '复制', copied: '已复制', copyCode: '复制代码', edit: '编辑', retry: '重试',
    regenerate: '重新生成', delete: '删除', cancel: '取消', close: '关闭', save: '保存',
    stop: '停止', more: '更多', open: '打开', download: '下载', export: '导出',
    confirm: '确认', rename: '重命名', remove: '移除', add: '添加', test: '测试',
    show: '显示', hide: '隐藏', back: '返回', apply: '应用', revert: '还原',
    restore: '恢复', reveal: '在文件夹中显示', copyPath: '复制路径', continue: '继续',
    load: '加载', unload: '卸载', refresh: '刷新'
  },
  confirm: {
    deleteMessage: { title: '删除消息？', message: '此操作无法撤销。' },
    deleteChat: { title: '删除对话？', message: '此操作无法撤销。' },
    discardChanges: { title: '放弃更改？', message: '你的编辑将丢失。', confirmLabel: '放弃' }
  },
  empty: {
    noMatches: '无匹配结果', noMatchesHint: '换个关键词试试', noConversations: '还没有对话',
    noMessages: '还没有消息', noSources: '无来源', noActivity: '无活动'
  },
  status: {
    working: '处理中', thinking: '思考中', planning: '规划中', reasoning: '推理中', writing: '撰写中',
    searching: '搜索中', reading: '读取中', loading: '加载中', saving: '保存中', listening: '聆听中',
    transcribing: '转写中', processing: '处理中', downloading: '下载中', extracting: '解压中'
  },
  tool: {
    needsApproval: '需要批准', approvalLede: '在你决定之前，运行已暂停。',
    allow: '允许', deny: '拒绝', failed: '失败', cancelled: '已取消', stopped: '已停止',
    done: '完成', error: '错误', result: '结果', truncated: '…（已截断）'
  },
  codeRun: { read: '读取', write: '写入', edit: '编辑', bash: '运行', grep: '搜索', ls: '列出', todo_write: '更新任务', git_status: 'Git 状态', git_diff: 'Git 差异', approvePlan: '批准计划', approval: '批准', approved: '已批准', denied: '已拒绝', compacting: '正在压缩上下文', compacted: '上下文已压缩', continuing: '达到输出上限 — 继续中', planNote: '批准后代理开始编辑；每次编辑仍会单独询问。', turnLimit: '已在轮次上限处停止', interrupted: '已中断 — 运行期间应用已关闭', plan: '计划' },
  untitled: { home: '新对话', code: '新会话', roleplay: '新角色扮演' },
  spaces: { home: '主页', code: '代码', roleplay: '角色扮演' },
  roleplay: {
    newRoleplay: '新角色扮演', characters: '角色', library: '角色库', newCharacter: '新角色',
    importCharacter: '导入', pickCharacter: '选择一个角色开始', pickCharacterHint: '你创建的角色会显示在这里。',
    noRoleplays: '还没有角色扮演会话', noRoleplaysHint: '和角色开始一个场景后会显示在这里。',
    enableInSettings: '在 设置 → 通用 中启用角色扮演。'
  },
  thread: {
    activity: '活动', jumpToLatest: '跳到最新', previousVersion: '上一版本', nextVersion: '下一版本',
    jumpToSelection: '跳到原始选区', generationFailed: '生成失败', listen: '收听',
    stopListening: '停止', sources: '来源', outputTokens: '输出 tok'
  },
  composer: {
    placeholder: '问点什么', errorPlaceholder: '出错了，请重试。', send: '发送消息',
    stop: '停止回复', attach: '附件', dictate: '语音输入', dropFiles: '将文件拖放到此处',
    dropHint: '图片、PDF、文档', hint: 'Enter 发送 · Shift+Enter 换行', selectMode: '选择模式',
    selectSearchMode: '选择搜索模式', documents: '文档', clearAll: '全部清除'
  },
  emptyState: {
    greeting: '今天我能帮你做什么？',
    suggestions: [
      { id: 'weather', label: '天气', prompt: '今天天气怎么样？' },
      { id: 'code', label: '代码', prompt: '帮我写一个函数，用来' },
      { id: 'write', label: '写作', prompt: '帮我写' },
      { id: 'analyze', label: '分析', prompt: '帮我分析一下：\n\n' },
      { id: 'brainstorm', label: '头脑风暴', prompt: '帮我想一些关于这个的点子：' }
    ]
  },
  model: {
    loading: '正在加载模型…', none: '未加载模型', browseAll: '浏览所有模型',
    changeRuntime: '更换运行时', configureProvider: '配置提供商'
  },
  viewer: {
    loadingPdf: '正在加载 PDF…', loadingFile: '正在加载文件…', convertingDocument: '正在转换文档…',
    convertingSpreadsheet: '正在转换表格…', previewUnavailable: '无法预览'
  },
  search: { chats: '搜索对话', placeholder: '搜索对话…' },
  searchModes: {
    chat: { label: '自动', description: '需要时使用工具和搜索' },
    search: { label: '搜索', description: '快速网页查询' },
    deep: { label: '深入', description: '深入研究 · 更多来源' },
    max: { label: '最大', description: '全面研究 · 更慢，更多来源' }
  }
};

export const COPY_OVERRIDES: Record<string, CopyOverride> = { es, 'pt-BR': ptBR, fr, de, ja, zh };

const SAY_EN: SayStrings = {
  nouns: {
    source: ['source', 'sources'],
    file: ['file', 'files'],
    result: ['result', 'results'],
    step: ['step', 'steps'],
    conversation: ['conversation', 'conversations']
  },
  stepOf: (current, total) => `Step ${current} of ${total}`
};

export const SAY_STRINGS: Record<string, SayStrings> = {
  en: SAY_EN,
  es: {
    nouns: { source: ['fuente', 'fuentes'], file: ['archivo', 'archivos'], result: ['resultado', 'resultados'], step: ['paso', 'pasos'], conversation: ['conversación', 'conversaciones'] },
    stepOf: (current, total) => `Paso ${current} de ${total}`
  },
  'pt-BR': {
    nouns: { source: ['fonte', 'fontes'], file: ['arquivo', 'arquivos'], result: ['resultado', 'resultados'], step: ['etapa', 'etapas'], conversation: ['conversa', 'conversas'] },
    stepOf: (current, total) => `Etapa ${current} de ${total}`
  },
  fr: {
    nouns: { source: ['source', 'sources'], file: ['fichier', 'fichiers'], result: ['résultat', 'résultats'], step: ['étape', 'étapes'], conversation: ['conversation', 'conversations'] },
    stepOf: (current, total) => `Étape ${current} sur ${total}`
  },
  de: {
    nouns: { source: ['Quelle', 'Quellen'], file: ['Datei', 'Dateien'], result: ['Ergebnis', 'Ergebnisse'], step: ['Schritt', 'Schritte'], conversation: ['Unterhaltung', 'Unterhaltungen'] },
    stepOf: (current, total) => `Schritt ${current} von ${total}`
  },
  ja: {
    nouns: { source: ['件のソース', '件のソース'], file: ['個のファイル', '個のファイル'], result: ['件の結果', '件の結果'], step: ['ステップ', 'ステップ'], conversation: ['件の会話', '件の会話'] },
    stepOf: (current, total) => `ステップ ${current}/${total}`
  },
  zh: {
    nouns: { source: ['个来源', '个来源'], file: ['个文件', '个文件'], result: ['个结果', '个结果'], step: ['个步骤', '个步骤'], conversation: ['个对话', '个对话'] },
    stepOf: (current, total) => `第 ${current}/${total} 步`
  }
};
