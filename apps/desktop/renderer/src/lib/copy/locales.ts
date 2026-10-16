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
    splitRight: 'Abrir al lado', splitBelow: 'Abrir debajo', splitTooSmall: 'La ventana es demasiado estrecha para dividirla',
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
    needsApproval: 'Requiere aprobación', approvalLede: 'La ejecución está en pausa hasta que decidas.', approvalDestructive: 'Esto puede modificar o eliminar datos.',
    allow: 'Permitir', deny: 'Denegar', failed: 'Falló', cancelled: 'Cancelado', stopped: 'Detenido',
    done: 'Hecho', error: 'Error', result: 'Resultado', truncated: '… (recortado)'
  },
  codeRun: { read: 'Leer', write: 'Escribir', edit: 'Editar', bash: 'Ejecutar', grep: 'Buscar', ls: 'Listar', todo_write: 'Actualizar tareas', git_status: 'Estado de Git', git_diff: 'Diff de Git', browser_open: 'Abrir página', browser_snapshot: 'Leer página', browser_click: 'Clic', browser_fill: 'Escribir', browser_select: 'Elegir opción', browser_press: 'Pulsar tecla', browser_hover: 'Pasar el cursor', browser_scroll: 'Desplazar', browser_wait: 'Esperar a la página', browser_back: 'Volver', browser_reload: 'Recargar', browser_console: 'Revisar consola', browser_screenshot: 'Captura', process_list: 'Listar procesos', process_output: 'Leer salida del proceso', process_stop: 'Detener proceso', message_bot: 'Preguntar', memory_update: 'Recordar', approvePlan: 'Aprobar plan', approval: 'Aprobación', approved: 'Aprobado', denied: 'Denegado', compacting: 'Compactando contexto', compacted: 'Contexto compactado', continuing: 'Límite de salida alcanzado — continuando', planNote: 'Al aprobar, el agente empieza a editar; cada edición sigue pidiendo permiso.', turnLimit: 'Detenido por el límite de turnos', interrupted: 'Interrumpido — la app se cerró durante esta ejecución', plan: 'Plan', noReply: 'El modelo terminó sin responder. Inténtalo de nuevo o cambia a un modelo que maneje mejor las herramientas.' },
  untitled: { home: 'Nuevo chat', code: 'Nueva conversación', roleplay: 'Nuevo rol', design: 'Nuevo diseño' },
  spaces: { label: 'Secciones', home: 'Inicio', code: 'Código', roleplay: 'Rol', design: 'Diseño', bots: 'Bots' },
  roleplay: {
    newRoleplay: 'Nuevo rol', characters: 'Personajes', library: 'Biblioteca de personajes', newCharacter: 'Nuevo personaje',
    importCharacter: 'Importar', pickCharacter: 'Elige un personaje para empezar', pickCharacterHint: 'Los personajes que crees aparecen aquí.',
    noRoleplays: 'Aún no hay sesiones de rol', noRoleplaysHint: 'Empieza una escena con un personaje y aparecerá aquí.',
    enableInSettings: 'Activa Rol en Ajustes → General.'
  },
  design: {
    newDesign: 'Nuevo diseño', noDesigns: 'Aún no hay diseños', noDesignsHint: 'Describe una pantalla y tomará forma aquí.',
    steps: { design_list: 'Listar archivos', design_read: 'Leer', design_write: 'Escribir', design_edit: 'Editar', design_snapshot: 'Guardar versión', design_preview: 'Vista previa', design_inspect: 'Inspeccionar', design_motion: 'Movimiento', design_reference: 'Estudiar referencia', design_view: 'Ver imagen' },
    canvas: { empty: 'Empieza con una pantalla', emptyHint: 'Descríbela en el chat o elige un punto de partida. La página aparece aquí en cuanto se escribe.', reload: 'Recargar vista previa', openFolder: 'Abrir carpeta del diseño', hideChat: 'Ocultar chat', showChat: 'Mostrar chat', previewLabel: 'Vista previa del diseño', viewport: 'Ventana', page: 'Página' },
    suggestions: [
      { id: 'landing', label: 'Página de inicio', prompt: 'Diseña una landing page para un producto. Hero, tres bloques de funciones, precios y un pie de página.' },
      { id: 'dashboard', label: 'Panel', prompt: 'Diseña un panel de analítica con barra lateral, tarjetas de KPI, un gráfico y una tabla de actividad reciente.' },
      { id: 'mobile', label: 'App móvil', prompt: 'Diseña un flujo de bienvenida móvil: pantallas de bienvenida, permisos y registro, de 390px de ancho.' },
      { id: 'pricing', label: 'Precios', prompt: 'Diseña una página de precios con tres planes, un selector mensual/anual y preguntas frecuentes.' },
      { id: 'login', label: 'Iniciar sesión', prompt: 'Diseña una pantalla de inicio de sesión limpia con correo, contraseña y opciones sociales.' },
      { id: 'micro', label: 'Microinteracciones', prompt: 'Diseña las microinteracciones de una interfaz pequeña. Un botón en sus estados de hover, pulsado y foco, un interruptor deslizante y una notificación que entra y sale, todo con tokens de movimiento y una versión con movimiento reducido.' },
    ],
    timeline: {
      title: 'Línea de tiempo', play: 'Reproducir', pause: 'Pausar', replay: 'Repetir', speed: 'Velocidad de reproducción', reduced: 'Vista previa de movimiento reducido',
      reducedHint: 'Vista previa: aquí las duraciones se recortan como lo haría un bloque de movimiento reducido', close: 'Cerrar línea de tiempo', scrub: 'Mover la línea de tiempo', change: 'Cambiar esta animación',
      none: 'Esta página no tiene animaciones.', noneHint: 'Añade una transición o una animación y vuelve a abrir la línea de tiempo.'
    },
    motion: {
      presets: { standard: 'Estándar', decelerate: 'Desacelerar', accelerate: 'Acelerar', emphasized: 'Énfasis', spring: 'Resorte' },
      custom: 'Personalizado'
    },
    viewports: { mobile: 'Móvil', tablet: 'Tableta', desktop: 'Escritorio', fit: 'Ajustar' },
    variants: { title: 'Variantes', none: 'Aún no hay variantes', noneHint: 'Pide opciones, por ejemplo "tres direcciones para la portada".', use: 'Usar esta variante', current: 'Diseño actual', close: 'Cerrar' },
    versions: { title: 'Versiones', none: 'Aún no hay versiones', restore: 'Restaurar', auto: 'Guardada tras un turno', files: 'archivos', restored: 'Versión restaurada' },
    select: { hint: 'Haz clic en un elemento · Mayús+clic añade · Doble clic en texto para editar · Esc para terminar', element: 'Elemento', remove: 'Quitar', clear: 'Limpiar', clearAll: 'Limpiar todo', showMore: 'Mostrar todo', showFewer: 'Mostrar menos' },
    comments: { pin: 'Comentario', placeholder: '¿Qué debería cambiar aquí?', hint: 'Intro guarda · Esc cancela', save: 'Guardar', cancel: 'Cancelar', chip: 'Comentario' },
    zoom: { label: 'Zoom', fit: 'Ajustar al panel', actual: 'Tamaño real', in: 'Acercar', out: 'Alejar' },
    empty: { title: 'Empieza con una pantalla', hint: 'Descríbela en el chat o elige un punto de partida abajo. La página toma forma aquí en cuanto se escribe.', sketching: 'Dibujando la primera pantalla…' },
    resize: { dock: 'Redimensionar el chat · doble clic para restablecer', inspector: 'Redimensionar el inspector · doble clic para restablecer' },
    dock: { title: '¿Qué diseñamos?', hint: 'Una pantalla, un flujo o un producto completo. Descríbelo o empieza desde un punto de partida.', placeholder: 'Describe una pantalla o selecciona un elemento para cambiarlo', starters: 'Puntos de partida' },
    toolbar: {
      viewport: { mobile: 'Móvil · 390px', tablet: 'Tableta · 834px', desktop: 'Escritorio · 1440px', fit: 'Ajustar al panel' },
      zoom: 'Zoom', zoomIn: 'Acercar', zoomOut: 'Alejar', zoomFit: 'Ajustar al panel', zoomReset: 'Tamaño real',
      scheme: { label: 'Esquema de color de la vista previa', auto: 'Auto', light: 'Claro', dark: 'Oscuro' },
      inspector: 'Inspector', showInspector: 'Mostrar inspector', hideInspector: 'Ocultar inspector', more: 'Más', fit: 'Ajustar'
    },
    tools: {
      label: 'Herramientas del lienzo', browse: 'Explorar', select: 'Seleccionar elemento', comment: 'Comentar en el lienzo',
      comments: 'Comentarios', sendComments: 'Enviar comentarios', commentsSent: 'Comentarios añadidos al próximo mensaje'
    },
    prompt: { placeholder: 'Describe un cambio para esto', send: 'Enviar cambio' },
    inspector: {
      element: 'Elemento', tokens: 'Tokens', code: 'Código', none: 'Selecciona un elemento en el lienzo',
      noneHint: 'Su texto, caja y estilos aparecen aquí, y los cambios rápidos van al chat.',
      text: 'Texto', box: 'Caja', styles: 'Estilos', changes: 'Cambios rápidos',
      prominent: 'Hacer esto más destacado', tighten: 'Reducir el espaciado', variants: 'Probar 3 variantes de esto',
      noTokens: 'Aún no hay tokens', tokensHint: 'Pide un archivo de tokens, por ejemplo "define tokens de color, espaciado y radio".',
      colors: 'Colores', space: 'Espaciado', radius: 'Radio', type: 'Tipografía', shadow: 'Sombras', other: 'Otros',
      moreSelected: 'más en la selección', motion: 'Movimiento', updateFailed: 'No se pudo actualizar el token', noSource: 'Nada que mostrar todavía', file: 'Archivo', copy: 'Copiar', copied: 'Copiado'
    },
    export: { button: 'Exportar', copyHtml: 'Copiar HTML', download: 'Descargar HTML', openBrowser: 'Abrir en el navegador', copied: 'HTML copiado', failed: 'La exportación falló' },
    systems: {
      label: 'Sistema de diseño',
      intro: 'Empezar desde un sistema',
      none: 'Sin sistema',
      saveAs: 'Guardar diseño como sistema…',
      import: 'Importar desde una carpeta…',
      specimenAction: 'Generar muestrario',
      specimenPrompt: 'Escribe components.html: una página de muestra de este sistema de diseño con la escala tipográfica, colores, botones, campos y tarjetas. Usa solo los tokens de tokens.css y ninguna URL externa.',
      manage: 'Gestionar sistemas…',
      title: 'Sistemas de diseño',
      description: 'Tokens, pautas y una página de muestra que los diseños pueden reutilizar',
      saveTitle: 'Guardar este diseño como sistema',
      nameLabel: 'Nombre del sistema',
      namePlaceholder: 'p. ej. Marca del estudio',
      descriptionLabel: 'Para qué sirve',
      descriptionPlaceholder: 'Opcional',
      save: 'Guardar sistema',
      saved: 'Sistema de diseño guardado',
      noSave: 'Abre un diseño para guardarlo como sistema.',
      listTitle: 'Sistemas guardados',
      empty: 'Aún no hay sistemas de diseño',
      emptyHint: 'Guarda un diseño como sistema o importa los tokens de una carpeta de proyecto.',
      noSpecimen: 'Aún sin muestrario',
      tokens: 'tokens',
      specimen: 'muestrario',
      fromDesign: 'Desde un diseño',
      fromFolder: 'Desde una carpeta',
      apply: 'Usar aquí',
      applied: 'Sistema aplicado. Los archivos anteriores se guardaron como versión.',
      inUse: 'En uso',
      rename: 'Renombrar',
      delete: 'Eliminar',
      deleteTitle: '¿Eliminar este sistema?',
      deleteMessage: 'Sus archivos salen de la biblioteca. Los diseños que ya lo usan conservan sus copias.',
      deleteConfirm: 'Eliminar sistema',
      imported: 'Sistema importado desde la carpeta'
    },
    handoff: {
      bundle: 'Descargar paquete (.zip)', toCode: 'Entregar a Código…', copyPrompt: 'Copiar prompt de construcción', copyDoc: 'Copiar HANDOFF.md', bundled: 'Paquete guardado', copied: 'Copiado',
      dialog: {
        keepHtml: 'Mantener HTML/CSS',
        title: 'Entregar a Código', description: 'Copia el diseño en un proyecto y abre una conversación en Código con el prompt de construcción. Nada se ejecuta hasta que lo envíes.', project: 'Proyecto',
        noProjects: 'Aún no hay proyectos. Elige una carpeta para añadir uno.', choose: 'Elegir carpeta…', stack: 'Construir con', stackCustom: 'Otra pila, p. ej. Next.js + Tailwind',
        copies: 'Copia el diseño y su HANDOFF.md en una carpeta nueva dentro de', confirm: 'Entregar', working: 'Copiando…',
        cancel: 'Cancelar', needProject: 'Primero elige una carpeta de proyecto.', failed: 'No se pudo entregar el diseño'
      }
    }
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
    changeRuntime: 'Cambiar runtime', configureProvider: 'Configurar un proveedor',
    loadFailed: {
      oom: 'No hay memoria suficiente para cargar este modelo. Reduce el contexto o las capas en GPU, o elige una cuantización más pequeña.',
      port: 'El puerto del servidor local ya está en uso. Cierra el otro llama-server e inténtalo de nuevo.',
      runtime: 'El runtime de llama.cpp falta o no pudo iniciarse. Reinstálalo desde Runtimes.',
      file: 'No se pudo leer este archivo de modelo. Puede estar incompleto o no ser un GGUF válido.',
      generic: 'No se pudo cargar el modelo: {reason}'
    }
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
    splitRight: 'Abrir ao lado', splitBelow: 'Abrir abaixo', splitTooSmall: 'A janela é estreita demais para dividir',
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
    needsApproval: 'Precisa de aprovação', approvalLede: 'A execução está pausada até você decidir.', approvalDestructive: 'Isto pode modificar ou remover dados.',
    allow: 'Permitir', deny: 'Negar', failed: 'Falhou', cancelled: 'Cancelado', stopped: 'Parado',
    done: 'Concluído', error: 'Erro', result: 'Resultado', truncated: '… (truncado)'
  },
  codeRun: { read: 'Ler', write: 'Escrever', edit: 'Editar', bash: 'Executar', grep: 'Pesquisar', ls: 'Listar', todo_write: 'Atualizar tarefas', git_status: 'Status do Git', git_diff: 'Diff do Git', browser_open: 'Abrir página', browser_snapshot: 'Ler página', browser_click: 'Clicar', browser_fill: 'Digitar', browser_select: 'Escolher opção', browser_press: 'Pressionar tecla', browser_hover: 'Passar o mouse', browser_scroll: 'Rolar', browser_wait: 'Aguardar página', browser_back: 'Voltar', browser_reload: 'Recarregar', browser_console: 'Verificar console', browser_screenshot: 'Captura', process_list: 'Listar processos', process_output: 'Ler saída do processo', process_stop: 'Parar processo', message_bot: 'Perguntar', memory_update: 'Lembrar', approvePlan: 'Aprovar plano', approval: 'Aprovação', approved: 'Aprovado', denied: 'Negado', compacting: 'Compactando contexto', compacted: 'Contexto compactado', continuing: 'Limite de saída atingido — continuando', planNote: 'Ao aprovar, o agente começa a editar; cada edição ainda pede permissão.', turnLimit: 'Parado no limite de turnos', interrupted: 'Interrompido — o app fechou durante esta execução', plan: 'Plano', noReply: 'O modelo terminou sem responder. Tente de novo ou troque para um modelo que lide melhor com ferramentas.' },
  untitled: { home: 'Novo chat', code: 'Nova conversa', roleplay: 'Novo roleplay', design: 'Novo design' },
  spaces: { label: 'Seções', home: 'Início', code: 'Código', roleplay: 'Roleplay', design: 'Design', bots: 'Bots' },
  roleplay: {
    newRoleplay: 'Novo roleplay', characters: 'Personagens', library: 'Biblioteca de personagens', newCharacter: 'Novo personagem',
    importCharacter: 'Importar', pickCharacter: 'Escolha um personagem para começar', pickCharacterHint: 'Os personagens que você criar aparecem aqui.',
    noRoleplays: 'Nenhuma sessão de roleplay ainda', noRoleplaysHint: 'Comece uma cena com um personagem e ela aparecerá aqui.',
    enableInSettings: 'Ative o Roleplay em Configurações → Geral.'
  },
  design: {
    newDesign: 'Novo design', noDesigns: 'Nenhum design ainda', noDesignsHint: 'Descreva uma tela e ela toma forma aqui.',
    steps: { design_list: 'Listar arquivos', design_read: 'Ler', design_write: 'Escrever', design_edit: 'Editar', design_snapshot: 'Salvar versão', design_preview: 'Pré-visualizar', design_inspect: 'Inspecionar', design_motion: 'Movimento', design_reference: 'Estudar referência', design_view: 'Ver imagem' },
    canvas: { empty: 'Comece com uma tela', emptyHint: 'Descreva no chat ou escolha um ponto de partida. A página aparece aqui assim que for escrita.', reload: 'Recarregar pré-visualização', openFolder: 'Abrir pasta do design', hideChat: 'Ocultar chat', showChat: 'Mostrar chat', previewLabel: 'Pré-visualização do design', viewport: 'Janela', page: 'Página' },
    suggestions: [
      { id: 'landing', label: 'Landing page', prompt: 'Crie uma landing page para um produto. Hero, três blocos de recursos, preços e um rodapé.' },
      { id: 'dashboard', label: 'Painel', prompt: 'Crie um painel de análise com barra lateral, cards de KPI, um gráfico e uma tabela de atividade recente.' },
      { id: 'mobile', label: 'App móvel', prompt: 'Crie um fluxo de onboarding móvel: telas de boas-vindas, permissões e cadastro, com 390px de largura.' },
      { id: 'pricing', label: 'Preços', prompt: 'Crie uma página de preços com três planos, um seletor mensal/anual e perguntas frequentes.' },
      { id: 'login', label: 'Entrar', prompt: 'Crie uma tela de login limpa com e-mail, senha e opções sociais.' },
      { id: 'micro', label: 'Microinterações', prompt: 'Desenhe as microinterações de uma interface pequena. Um botão nos estados de hover, pressionado e foco, um interruptor deslizante e uma notificação que entra e sai, tudo com tokens de movimento e uma versão com movimento reduzido.' },
    ],
    timeline: {
      title: 'Linha do tempo', play: 'Reproduzir', pause: 'Pausar', replay: 'Repetir', speed: 'Velocidade de reprodução', reduced: 'Prévia de movimento reduzido',
      reducedHint: 'Prévia: aqui as durações são cortadas como um bloco de movimento reduzido faria', close: 'Fechar linha do tempo', scrub: 'Mover a linha do tempo', change: 'Alterar esta animação',
      none: 'Esta página não tem animações.', noneHint: 'Adicione uma transição ou uma animação e abra a linha do tempo de novo.'
    },
    motion: {
      presets: { standard: 'Padrão', decelerate: 'Desacelerar', accelerate: 'Acelerar', emphasized: 'Ênfase', spring: 'Mola' },
      custom: 'Personalizado'
    },
    viewports: { mobile: 'Celular', tablet: 'Tablet', desktop: 'Desktop', fit: 'Ajustar' },
    variants: { title: 'Variantes', none: 'Nenhuma variante ainda', noneHint: 'Peça opções, por exemplo "três direções para o topo".', use: 'Usar esta variante', current: 'Design atual', close: 'Fechar' },
    versions: { title: 'Versões', none: 'Nenhuma versão ainda', restore: 'Restaurar', auto: 'Salva após uma rodada', files: 'arquivos', restored: 'Versão restaurada' },
    select: { hint: 'Clique em um elemento · Shift+clique adiciona · Duplo clique no texto para editar · Esc para terminar', element: 'Elemento', remove: 'Remover', clear: 'Limpar', clearAll: 'Limpar tudo', showMore: 'Mostrar tudo', showFewer: 'Mostrar menos' },
    comments: { pin: 'Comentário', placeholder: 'O que deve mudar aqui?', hint: 'Enter salva · Esc cancela', save: 'Salvar', cancel: 'Cancelar', chip: 'Comentário' },
    zoom: { label: 'Zoom', fit: 'Ajustar ao painel', actual: 'Tamanho real', in: 'Aumentar zoom', out: 'Diminuir zoom' },
    empty: { title: 'Comece com uma tela', hint: 'Descreva no chat ou escolha um ponto de partida abaixo. A página ganha forma aqui assim que for escrita.', sketching: 'Esboçando a primeira tela…' },
    resize: { dock: 'Redimensionar o chat · clique duplo para redefinir', inspector: 'Redimensionar o inspetor · clique duplo para redefinir' },
    dock: { title: 'O que vamos desenhar?', hint: 'Uma tela, um fluxo ou um produto inteiro. Descreva, ou comece por um ponto de partida.', placeholder: 'Descreva uma tela ou selecione um elemento para alterá-lo', starters: 'Pontos de partida' },
    toolbar: {
      viewport: { mobile: 'Celular · 390px', tablet: 'Tablet · 834px', desktop: 'Desktop · 1440px', fit: 'Ajustar ao painel' },
      zoom: 'Zoom', zoomIn: 'Aumentar zoom', zoomOut: 'Diminuir zoom', zoomFit: 'Ajustar ao painel', zoomReset: 'Tamanho real',
      scheme: { label: 'Esquema de cores da pré-visualização', auto: 'Auto', light: 'Claro', dark: 'Escuro' },
      inspector: 'Inspetor', showInspector: 'Mostrar inspetor', hideInspector: 'Ocultar inspetor', more: 'Mais', fit: 'Ajustar'
    },
    tools: {
      label: 'Ferramentas da tela', browse: 'Navegar', select: 'Selecionar elemento', comment: 'Comentar na tela',
      comments: 'Comentários', sendComments: 'Enviar comentários', commentsSent: 'Comentários adicionados à próxima mensagem'
    },
    prompt: { placeholder: 'Descreva uma mudança para isto', send: 'Enviar mudança' },
    inspector: {
      element: 'Elemento', tokens: 'Tokens', code: 'Código', none: 'Selecione um elemento na tela',
      noneHint: 'Texto, caixa e estilos aparecem aqui, e ajustes rápidos vão para o chat.',
      text: 'Texto', box: 'Caixa', styles: 'Estilos', changes: 'Ajustes rápidos',
      prominent: 'Deixar isto mais em destaque', tighten: 'Reduzir o espaçamento', variants: 'Criar 3 variantes disto',
      noTokens: 'Nenhum token ainda', tokensHint: 'Peça um arquivo de tokens, por exemplo "defina tokens de cor, espaçamento e raio".',
      colors: 'Cores', space: 'Espaçamento', radius: 'Raio', type: 'Tipografia', shadow: 'Sombras', other: 'Outros',
      moreSelected: 'a mais na seleção', motion: 'Movimento', updateFailed: 'Não foi possível atualizar o token', noSource: 'Nada para mostrar ainda', file: 'Arquivo', copy: 'Copiar', copied: 'Copiado'
    },
    export: { button: 'Exportar', copyHtml: 'Copiar HTML', download: 'Baixar HTML', openBrowser: 'Abrir no navegador', copied: 'HTML copiado', failed: 'Falha na exportação' },
    systems: {
      label: 'Sistema de design',
      intro: 'Começar de um sistema',
      none: 'Nenhum sistema',
      saveAs: 'Salvar design como sistema…',
      import: 'Importar de uma pasta…',
      specimenAction: 'Gerar espécime',
      specimenPrompt: 'Escreva components.html: uma página espécime deste sistema de design com a escala tipográfica, cores, botões, campos e cards. Use apenas os tokens de tokens.css e nenhuma URL externa.',
      manage: 'Gerenciar sistemas…',
      title: 'Sistemas de design',
      description: 'Tokens, diretrizes e uma página espécime que os designs podem reutilizar',
      saveTitle: 'Salvar este design como sistema',
      nameLabel: 'Nome do sistema',
      namePlaceholder: 'ex.: Marca do estúdio',
      descriptionLabel: 'Para que serve',
      descriptionPlaceholder: 'Opcional',
      save: 'Salvar sistema',
      saved: 'Sistema de design salvo',
      noSave: 'Abra um design para salvá-lo como sistema.',
      listTitle: 'Sistemas salvos',
      empty: 'Nenhum sistema de design ainda',
      emptyHint: 'Salve um design como sistema ou importe os tokens de uma pasta de projeto.',
      noSpecimen: 'Sem espécime ainda',
      tokens: 'tokens',
      specimen: 'espécime',
      fromDesign: 'De um design',
      fromFolder: 'De uma pasta',
      apply: 'Usar aqui',
      applied: 'Sistema aplicado. Os arquivos anteriores foram salvos como versão.',
      inUse: 'Em uso',
      rename: 'Renomear',
      delete: 'Excluir',
      deleteTitle: 'Excluir este sistema?',
      deleteMessage: 'Os arquivos saem da biblioteca. Os designs que já o usam mantêm suas cópias.',
      deleteConfirm: 'Excluir sistema',
      imported: 'Sistema importado da pasta'
    },
    handoff: {
      bundle: 'Baixar pacote (.zip)', toCode: 'Entregar ao Código…', copyPrompt: 'Copiar prompt de criação', copyDoc: 'Copiar HANDOFF.md', bundled: 'Pacote salvo', copied: 'Copiado',
      dialog: {
        keepHtml: 'Manter HTML/CSS',
        title: 'Entregar ao Código', description: 'Copia o design para um projeto e abre uma conversa no Código com o prompt de criação. Nada roda até você enviar.', project: 'Projeto',
        noProjects: 'Nenhum projeto ainda. Escolha uma pasta para adicionar um.', choose: 'Escolher pasta…', stack: 'Construir com', stackCustom: 'Outra stack, ex.: Next.js + Tailwind',
        copies: 'Copia o design e o HANDOFF.md para uma pasta nova dentro de', confirm: 'Entregar', working: 'Copiando…',
        cancel: 'Cancelar', needProject: 'Escolha primeiro uma pasta de projeto.', failed: 'Não foi possível entregar o design'
      }
    }
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
    changeRuntime: 'Trocar runtime', configureProvider: 'Configurar um provedor',
    loadFailed: {
      oom: 'Memória insuficiente para carregar este modelo. Reduza o contexto ou as camadas na GPU, ou escolha uma quantização menor.',
      port: 'A porta do servidor local já está em uso. Feche o outro llama-server e tente novamente.',
      runtime: 'O runtime do llama.cpp está ausente ou não iniciou. Reinstale-o em Runtimes.',
      file: 'Não foi possível ler este arquivo de modelo. Ele pode estar incompleto ou não ser um GGUF válido.',
      generic: 'Falha ao carregar o modelo: {reason}'
    }
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
    splitRight: 'Ouvrir à côté', splitBelow: 'Ouvrir en dessous', splitTooSmall: 'La fenêtre est trop étroite pour être divisée',
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
    needsApproval: 'Approbation requise', approvalLede: 'L’exécution est en pause jusqu’à votre décision.', approvalDestructive: 'Cela peut modifier ou supprimer des données.',
    allow: 'Autoriser', deny: 'Refuser', failed: 'Échec', cancelled: 'Annulé', stopped: 'Arrêté',
    done: 'Terminé', error: 'Erreur', result: 'Résultat', truncated: '… (tronqué)'
  },
  codeRun: { read: 'Lire', write: 'Écrire', edit: 'Modifier', bash: 'Exécuter', grep: 'Rechercher', ls: 'Lister', todo_write: 'Mettre à jour les tâches', git_status: 'État Git', git_diff: 'Diff Git', browser_open: 'Ouvrir la page', browser_snapshot: 'Lire la page', browser_click: 'Cliquer', browser_fill: 'Saisir', browser_select: 'Choisir une option', browser_press: 'Appuyer sur une touche', browser_hover: 'Survoler', browser_scroll: 'Défiler', browser_wait: 'Attendre la page', browser_back: 'Retour', browser_reload: 'Recharger', browser_console: 'Vérifier la console', browser_screenshot: 'Capture', process_list: 'Lister les processus', process_output: 'Lire la sortie', process_stop: 'Arrêter le processus', message_bot: 'Demander', memory_update: 'Retenir', approvePlan: 'Approuver le plan', approval: 'Approbation', approved: 'Approuvé', denied: 'Refusé', compacting: 'Compactage du contexte', compacted: 'Contexte compacté', continuing: 'Limite de sortie atteinte — poursuite', planNote: 'Approuver permet à l’agent de commencer à modifier ; chaque modification demande encore votre accord.', turnLimit: 'Arrêté à la limite de tours', interrupted: 'Interrompu — l’application s’est fermée pendant l’exécution', plan: 'Plan', noReply: 'Le modèle a terminé sans répondre. Réessayez ou passez à un modèle qui gère mieux les outils.' },
  untitled: { home: 'Nouvelle conversation', code: 'Nouvelle conversation', roleplay: 'Nouveau jeu de rôle', design: 'Nouveau design' },
  spaces: { label: 'Sections', home: 'Accueil', code: 'Code', roleplay: 'Jeu de rôle', design: 'Design', bots: 'Bots' },
  roleplay: {
    newRoleplay: 'Nouveau jeu de rôle', characters: 'Personnages', library: 'Bibliothèque de personnages', newCharacter: 'Nouveau personnage',
    importCharacter: 'Importer', pickCharacter: 'Choisissez un personnage pour commencer', pickCharacterHint: 'Les personnages que vous créez apparaissent ici.',
    noRoleplays: 'Aucune session de jeu de rôle', noRoleplaysHint: 'Lancez une scène avec un personnage et elle apparaîtra ici.',
    enableInSettings: 'Activez le jeu de rôle dans Réglages → Général.'
  },
  design: {
    newDesign: 'Nouveau design', noDesigns: 'Aucun design', noDesignsHint: 'Décrivez un écran et il prendra forme ici.',
    steps: { design_list: 'Lister les fichiers', design_read: 'Lire', design_write: 'Écrire', design_edit: 'Modifier', design_snapshot: 'Enregistrer une version', design_preview: 'Aperçu', design_inspect: 'Inspecter', design_motion: 'Mouvement', design_reference: 'Étudier une référence', design_view: 'Voir l’image' },
    canvas: { empty: 'Commencez par un écran', emptyHint: 'Décrivez-le dans le chat ou choisissez un point de départ. La page apparaît ici dès qu’elle est écrite.', reload: 'Recharger l’aperçu', openFolder: 'Ouvrir le dossier du design', hideChat: 'Masquer le chat', showChat: 'Afficher le chat', previewLabel: 'Aperçu du design', viewport: 'Fenêtre', page: 'Page' },
    suggestions: [
      { id: 'landing', label: 'Page d’accueil', prompt: 'Conçois une landing page pour un produit : hero, trois blocs de fonctionnalités, tarifs et pied de page.' },
      { id: 'dashboard', label: 'Tableau de bord', prompt: 'Conçois un tableau de bord analytique avec barre latérale, cartes KPI, un graphique et un tableau d’activité récente.' },
      { id: 'mobile', label: 'App mobile', prompt: 'Conçois un parcours d’accueil mobile : écrans de bienvenue, autorisations et inscription, 390px de large.' },
      { id: 'pricing', label: 'Tarifs', prompt: 'Conçois une page de tarifs avec trois offres, un sélecteur mensuel/annuel et une FAQ.' },
      { id: 'login', label: 'Connexion', prompt: 'Conçois un écran de connexion épuré avec e-mail, mot de passe et connexions sociales.' },
      { id: 'micro', label: 'Micro-interactions', prompt: 'Conçois les micro-interactions d\'une petite interface. Un bouton dans ses états survol, enfoncé et focus, un interrupteur qui glisse et une notification qui entre et sort, le tout avec des jetons de mouvement et une version à mouvement réduit.' },
    ],
    timeline: {
      title: 'Chronologie', play: 'Lire', pause: 'Pause', replay: 'Rejouer', speed: 'Vitesse de lecture', reduced: 'Aperçu du mouvement réduit',
      reducedHint: 'Aperçu : les durées sont raccourcies ici comme le ferait un bloc de mouvement réduit', close: 'Fermer la chronologie', scrub: 'Parcourir la chronologie', change: 'Modifier cette animation',
      none: 'Cette page ne contient aucune animation.', noneHint: 'Ajoutez une transition ou une animation, puis rouvrez la chronologie.'
    },
    motion: {
      presets: { standard: 'Standard', decelerate: 'Décélération', accelerate: 'Accélération', emphasized: 'Accentué', spring: 'Ressort' },
      custom: 'Personnalisé'
    },
    viewports: { mobile: 'Mobile', tablet: 'Tablette', desktop: 'Bureau', fit: 'Ajuster' },
    variants: { title: 'Variantes', none: 'Aucune variante', noneHint: 'Demandez des options, par exemple « trois directions pour l’en-tête ».', use: 'Utiliser cette variante', current: 'Design actuel', close: 'Fermer' },
    versions: { title: 'Versions', none: 'Aucune version', restore: 'Restaurer', auto: 'Enregistrée après un tour', files: 'fichiers', restored: 'Version restaurée' },
    select: { hint: 'Cliquez un élément · Maj+clic ajoute · Double-clic sur un texte pour le modifier · Échap pour terminer', element: 'Élément', remove: 'Retirer', clear: 'Effacer', clearAll: 'Tout effacer', showMore: 'Tout afficher', showFewer: 'Afficher moins' },
    comments: { pin: 'Commentaire', placeholder: 'Que faut-il changer ici ?', hint: 'Entrée enregistre · Échap annule', save: 'Enregistrer', cancel: 'Annuler', chip: 'Commentaire' },
    zoom: { label: 'Zoom', fit: 'Ajuster à la zone', actual: 'Taille réelle', in: 'Zoom avant', out: 'Zoom arrière' },
    empty: { title: 'Commencez par un écran', hint: 'Décrivez-le dans le chat ou choisissez un point de départ ci-dessous. La page prend forme ici dès qu’elle est écrite.', sketching: 'Esquisse du premier écran…' },
    resize: { dock: 'Redimensionner le chat · double-clic pour réinitialiser', inspector: 'Redimensionner l’inspecteur · double-clic pour réinitialiser' },
    dock: { title: 'Que concevons-nous ?', hint: 'Un écran, un parcours ou un produit entier. Décrivez-le ou partez d’un point de départ.', placeholder: 'Décrivez un écran, ou sélectionnez un élément à modifier', starters: 'Points de départ' },
    toolbar: {
      viewport: { mobile: 'Mobile · 390px', tablet: 'Tablette · 834px', desktop: 'Bureau · 1440px', fit: 'Ajuster à la zone' },
      zoom: 'Zoom', zoomIn: 'Zoom avant', zoomOut: 'Zoom arrière', zoomFit: 'Ajuster à la zone', zoomReset: 'Taille réelle',
      scheme: { label: 'Thème de couleur de l’aperçu', auto: 'Auto', light: 'Clair', dark: 'Sombre' },
      inspector: 'Inspecteur', showInspector: 'Afficher l’inspecteur', hideInspector: 'Masquer l’inspecteur', more: 'Plus', fit: 'Ajuster'
    },
    tools: {
      label: 'Outils du canevas', browse: 'Parcourir', select: 'Sélectionner un élément', comment: 'Commenter le canevas',
      comments: 'Commentaires', sendComments: 'Envoyer les commentaires', commentsSent: 'Commentaires ajoutés au prochain message'
    },
    prompt: { placeholder: 'Décrivez une modification', send: 'Envoyer la modification' },
    inspector: {
      element: 'Élément', tokens: 'Jetons', code: 'Code', none: 'Sélectionnez un élément sur le canevas',
      noneHint: 'Son texte, sa boîte et ses styles apparaissent ici, et les modifications rapides partent dans le chat.',
      text: 'Texte', box: 'Boîte', styles: 'Styles', changes: 'Modifications rapides',
      prominent: 'Le rendre plus visible', tighten: 'Resserrer l’espacement', variants: 'Essayer 3 variantes de ceci',
      noTokens: 'Aucun jeton pour l’instant', tokensHint: 'Demandez un fichier de jetons, par exemple « définis les jetons de couleur, d’espacement et de rayon ».',
      colors: 'Couleurs', space: 'Espacement', radius: 'Rayon', type: 'Typographie', shadow: 'Ombres', other: 'Autres',
      moreSelected: 'de plus dans la sélection', motion: 'Mouvement', updateFailed: 'Impossible de mettre à jour le jeton', noSource: 'Rien à afficher pour l’instant', file: 'Fichier', copy: 'Copier', copied: 'Copié'
    },
    export: { button: 'Exporter', copyHtml: 'Copier le HTML', download: 'Télécharger le HTML', openBrowser: 'Ouvrir dans le navigateur', copied: 'HTML copié', failed: 'Échec de l’exportation' },
    systems: {
      label: 'Système de design',
      intro: 'Partir d’un système',
      none: 'Aucun système',
      saveAs: 'Enregistrer le design comme système…',
      import: 'Importer depuis un dossier…',
      specimenAction: 'Générer un spécimen',
      specimenPrompt: 'Écris components.html : une page de spécimen de ce système de design, avec l’échelle typographique, les couleurs, les boutons, les champs et les cartes. Utilise uniquement les tokens de tokens.css, sans URL externe.',
      manage: 'Gérer les systèmes…',
      title: 'Systèmes de design',
      description: 'Tokens, consignes et une page de spécimen que les designs peuvent réutiliser',
      saveTitle: 'Enregistrer ce design comme système',
      nameLabel: 'Nom du système',
      namePlaceholder: 'ex. Marque du studio',
      descriptionLabel: 'À quoi il sert',
      descriptionPlaceholder: 'Facultatif',
      save: 'Enregistrer le système',
      saved: 'Système de design enregistré',
      noSave: 'Ouvre un design pour l’enregistrer comme système.',
      listTitle: 'Systèmes enregistrés',
      empty: 'Aucun système de design pour l’instant',
      emptyHint: 'Enregistre un design comme système, ou importe les tokens d’un dossier de projet.',
      noSpecimen: 'Pas encore de spécimen',
      tokens: 'tokens',
      specimen: 'spécimen',
      fromDesign: 'Depuis un design',
      fromFolder: 'Depuis un dossier',
      apply: 'Utiliser ici',
      applied: 'Système appliqué. Les fichiers précédents sont enregistrés comme version.',
      inUse: 'Utilisé',
      rename: 'Renommer',
      delete: 'Supprimer',
      deleteTitle: 'Supprimer ce système ?',
      deleteMessage: 'Ses fichiers quittent la bibliothèque. Les designs qui l’utilisent gardent leurs copies.',
      deleteConfirm: 'Supprimer le système',
      imported: 'Système importé depuis le dossier'
    },
    handoff: {
      bundle: 'Télécharger le paquet (.zip)', toCode: 'Transmettre à Code…', copyPrompt: 'Copier le prompt de construction', copyDoc: 'Copier HANDOFF.md', bundled: 'Paquet enregistré', copied: 'Copié',
      dialog: {
        keepHtml: 'Garder HTML/CSS',
        title: 'Transmettre à Code', description: 'Copie le design dans un projet, puis ouvre une conversation Code avec le prompt de construction. Rien ne s’exécute avant votre envoi.', project: 'Projet',
        noProjects: 'Aucun projet pour l’instant. Choisissez un dossier pour en ajouter un.', choose: 'Choisir un dossier…', stack: 'Construire avec', stackCustom: 'Une autre pile, p. ex. Next.js + Tailwind',
        copies: 'Copie le design et son HANDOFF.md dans un nouveau dossier sous', confirm: 'Transmettre', working: 'Copie en cours…',
        cancel: 'Annuler', needProject: 'Choisissez d’abord un dossier de projet.', failed: 'Impossible de transmettre le design'
      }
    }
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
    changeRuntime: 'Changer de runtime', configureProvider: 'Configurer un fournisseur',
    loadFailed: {
      oom: 'Mémoire insuffisante pour charger ce modèle. Réduisez le contexte ou les couches GPU, ou choisissez une quantification plus petite.',
      port: "Le port du serveur local est déjà utilisé. Fermez l'autre llama-server et réessayez.",
      runtime: "Le runtime llama.cpp est absent ou n'a pas démarré. Réinstallez-le depuis Runtimes.",
      file: "Impossible de lire ce fichier de modèle. Il est peut-être incomplet ou n'est pas un GGUF valide.",
      generic: 'Échec du chargement du modèle : {reason}'
    }
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
    splitRight: 'Daneben öffnen', splitBelow: 'Darunter öffnen', splitTooSmall: 'Das Fenster ist zu schmal zum Teilen',
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
    needsApproval: 'Freigabe nötig', approvalLede: 'Der Lauf pausiert, bis du entscheidest.', approvalDestructive: 'Das kann Daten ändern oder löschen.',
    allow: 'Erlauben', deny: 'Ablehnen', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen', stopped: 'Gestoppt',
    done: 'Fertig', error: 'Fehler', result: 'Ergebnis', truncated: '… (gekürzt)'
  },
  codeRun: { read: 'Lesen', write: 'Schreiben', edit: 'Bearbeiten', bash: 'Ausführen', grep: 'Suchen', ls: 'Auflisten', todo_write: 'Aufgaben aktualisieren', git_status: 'Git-Status', git_diff: 'Git-Diff', browser_open: 'Seite öffnen', browser_snapshot: 'Seite lesen', browser_click: 'Klicken', browser_fill: 'Eingeben', browser_select: 'Option wählen', browser_press: 'Taste drücken', browser_hover: 'Überfahren', browser_scroll: 'Scrollen', browser_wait: 'Auf Seite warten', browser_back: 'Zurück', browser_reload: 'Neu laden', browser_console: 'Konsole prüfen', browser_screenshot: 'Screenshot', process_list: 'Prozesse auflisten', process_output: 'Prozessausgabe lesen', process_stop: 'Prozess stoppen', message_bot: 'Fragen', memory_update: 'Merken', approvePlan: 'Plan freigeben', approval: 'Freigabe', approved: 'Freigegeben', denied: 'Abgelehnt', compacting: 'Kontext wird verdichtet', compacted: 'Kontext verdichtet', continuing: 'Ausgabelimit erreicht — geht weiter', planNote: 'Mit der Freigabe beginnt der Agent zu bearbeiten; jede Änderung fragt weiterhin einzeln.', turnLimit: 'Am Rundenlimit gestoppt', interrupted: 'Unterbrochen — die App wurde während des Laufs geschlossen', plan: 'Plan', noReply: 'Das Modell hat ohne Antwort beendet. Versuche es erneut oder wechsle zu einem Modell, das Werkzeuge besser beherrscht.' },
  untitled: { home: 'Neuer Chat', code: 'Neue Unterhaltung', roleplay: 'Neues Rollenspiel', design: 'Neues Design' },
  spaces: { label: 'Bereiche', home: 'Start', code: 'Code', roleplay: 'Rollenspiel', design: 'Design', bots: 'Bots' },
  roleplay: {
    newRoleplay: 'Neues Rollenspiel', characters: 'Figuren', library: 'Figurenbibliothek', newCharacter: 'Neue Figur',
    importCharacter: 'Importieren', pickCharacter: 'Wähle eine Figur, um zu beginnen', pickCharacterHint: 'Figuren, die du erstellst, erscheinen hier.',
    noRoleplays: 'Noch keine Rollenspiel-Sitzungen', noRoleplaysHint: 'Starte eine Szene mit einer Figur, dann erscheint sie hier.',
    enableInSettings: 'Aktiviere Rollenspiel unter Einstellungen → Allgemein.'
  },
  design: {
    newDesign: 'Neues Design', noDesigns: 'Noch keine Designs', noDesignsHint: 'Beschreibe einen Screen, und er entsteht hier.',
    steps: { design_list: 'Dateien auflisten', design_read: 'Lesen', design_write: 'Schreiben', design_edit: 'Bearbeiten', design_snapshot: 'Version speichern', design_preview: 'Vorschau', design_inspect: 'Untersuchen', design_motion: 'Bewegung', design_reference: 'Referenz ansehen', design_view: 'Bild ansehen' },
    canvas: { empty: 'Mit einem Screen beginnen', emptyHint: 'Beschreibe ihn im Chat oder wähle einen Einstieg. Die Seite erscheint hier, sobald sie geschrieben ist.', reload: 'Vorschau neu laden', openFolder: 'Design-Ordner öffnen', hideChat: 'Chat ausblenden', showChat: 'Chat einblenden', previewLabel: 'Design-Vorschau', viewport: 'Viewport', page: 'Seite' },
    suggestions: [
      { id: 'landing', label: 'Landingpage', prompt: 'Gestalte eine Landingpage für ein Produkt: Hero, drei Feature-Blöcke, Preise und ein Footer.' },
      { id: 'dashboard', label: 'Dashboard', prompt: 'Gestalte ein Analyse-Dashboard mit Seitenleiste, KPI-Karten, einem Diagramm und einer Tabelle der letzten Aktivität.' },
      { id: 'mobile', label: 'Mobile App', prompt: 'Gestalte ein mobiles Onboarding: Willkommens-, Berechtigungs- und Registrierungsscreen, 390px breit.' },
      { id: 'pricing', label: 'Preise', prompt: 'Gestalte eine Preisseite mit drei Tarifen, einem Monat/Jahr-Umschalter und einer FAQ.' },
      { id: 'login', label: 'Anmelden', prompt: 'Gestalte einen klaren Anmeldescreen mit E-Mail, Passwort und Social-Login.' },
      { id: 'micro', label: 'Mikrointeraktionen', prompt: 'Gestalte die Mikrointeraktionen einer kleinen Oberfläche. Ein Button in den Zuständen Hover, Gedrückt und Fokus, ein gleitender Schalter und eine Meldung, die ein- und ausfährt, alles mit Bewegungstokens und einer Fassung für reduzierte Bewegung.' },
    ],
    timeline: {
      title: 'Zeitleiste', play: 'Abspielen', pause: 'Pausieren', replay: 'Wiederholen', speed: 'Wiedergabegeschwindigkeit', reduced: 'Vorschau reduzierte Bewegung',
      reducedHint: 'Vorschau: Hier werden Dauern so gekürzt, wie es ein Block für reduzierte Bewegung täte', close: 'Zeitleiste schließen', scrub: 'Zeitleiste durchsuchen', change: 'Diese Animation ändern',
      none: 'Diese Seite hat keine Animationen.', noneHint: 'Füge einen Übergang oder eine Animation hinzu und öffne die Zeitleiste erneut.'
    },
    motion: {
      presets: { standard: 'Standard', decelerate: 'Verlangsamen', accelerate: 'Beschleunigen', emphasized: 'Betont', spring: 'Feder' },
      custom: 'Benutzerdefiniert'
    },
    viewports: { mobile: 'Mobil', tablet: 'Tablet', desktop: 'Desktop', fit: 'Anpassen' },
    variants: { title: 'Varianten', none: 'Noch keine Varianten', noneHint: 'Bitte um Optionen, zum Beispiel „drei Richtungen für den Hero“.', use: 'Diese Variante verwenden', current: 'Aktuelles Design', close: 'Schließen' },
    versions: { title: 'Versionen', none: 'Noch keine Versionen', restore: 'Wiederherstellen', auto: 'Nach einem Durchgang gespeichert', files: 'Dateien', restored: 'Version wiederhergestellt' },
    select: { hint: 'Element anklicken · Umschalt+Klick fügt hinzu · Doppelklick auf Text zum Bearbeiten · Esc zum Beenden', element: 'Element', remove: 'Entfernen', clear: 'Leeren', clearAll: 'Alles leeren', showMore: 'Alle anzeigen', showFewer: 'Weniger anzeigen' },
    comments: { pin: 'Kommentar', placeholder: 'Was soll hier geändert werden?', hint: 'Enter speichert · Esc bricht ab', save: 'Speichern', cancel: 'Abbrechen', chip: 'Kommentar' },
    zoom: { label: 'Zoom', fit: 'An Fenster anpassen', actual: 'Originalgröße', in: 'Vergrößern', out: 'Verkleinern' },
    empty: { title: 'Mit einem Screen beginnen', hint: 'Beschreibe ihn im Chat oder wähle unten einen Einstieg. Die Seite nimmt hier Gestalt an, sobald sie geschrieben ist.', sketching: 'Der erste Screen wird skizziert…' },
    resize: { dock: 'Chat-Breite ändern · Doppelklick setzt zurück', inspector: 'Inspektor-Breite ändern · Doppelklick setzt zurück' },
    dock: { title: 'Was sollen wir gestalten?', hint: 'Ein Screen, ein Ablauf oder ein ganzes Produkt. Beschreibe es oder starte mit einer Vorlage.', placeholder: 'Beschreibe einen Screen oder wähle ein Element zum Ändern aus', starters: 'Einstiege' },
    toolbar: {
      viewport: { mobile: 'Mobil · 390px', tablet: 'Tablet · 834px', desktop: 'Desktop · 1440px', fit: 'An Fenster anpassen' },
      zoom: 'Zoom', zoomIn: 'Vergrößern', zoomOut: 'Verkleinern', zoomFit: 'An Fenster anpassen', zoomReset: 'Originalgröße',
      scheme: { label: 'Farbschema der Vorschau', auto: 'Auto', light: 'Hell', dark: 'Dunkel' },
      inspector: 'Inspektor', showInspector: 'Inspektor einblenden', hideInspector: 'Inspektor ausblenden', more: 'Mehr', fit: 'Anpassen'
    },
    tools: {
      label: 'Canvas-Werkzeuge', browse: 'Durchsuchen', select: 'Element auswählen', comment: 'Auf dem Canvas kommentieren',
      comments: 'Kommentare', sendComments: 'Kommentare senden', commentsSent: 'Kommentare der nächsten Nachricht hinzugefügt'
    },
    prompt: { placeholder: 'Beschreibe eine Änderung', send: 'Änderung senden' },
    inspector: {
      element: 'Element', tokens: 'Tokens', code: 'Code', none: 'Wähle ein Element auf dem Canvas aus',
      noneHint: 'Text, Box und Stile erscheinen hier, schnelle Änderungen gehen an den Chat.',
      text: 'Text', box: 'Box', styles: 'Stile', changes: 'Schnelle Änderungen',
      prominent: 'Stärker hervorheben', tighten: 'Abstände verkleinern', variants: '3 Varianten davon ausprobieren',
      noTokens: 'Noch keine Tokens', tokensHint: 'Bitte um eine Token-Datei, zum Beispiel „Farb-, Abstands- und Radius-Tokens definieren“.',
      colors: 'Farben', space: 'Abstände', radius: 'Radius', type: 'Typografie', shadow: 'Schatten', other: 'Sonstiges',
      moreSelected: 'weitere ausgewählt', motion: 'Bewegung', updateFailed: 'Das Token konnte nicht aktualisiert werden', noSource: 'Noch nichts anzuzeigen', file: 'Datei', copy: 'Kopieren', copied: 'Kopiert'
    },
    export: { button: 'Exportieren', copyHtml: 'HTML kopieren', download: 'HTML herunterladen', openBrowser: 'Im Browser öffnen', copied: 'HTML kopiert', failed: 'Export fehlgeschlagen' },
    systems: {
      label: 'Designsystem',
      intro: 'Mit einem System beginnen',
      none: 'Kein System',
      saveAs: 'Design als System speichern…',
      import: 'Aus einem Ordner importieren…',
      specimenAction: 'Muster erzeugen',
      specimenPrompt: 'Schreibe components.html: eine Musterseite für dieses Designsystem mit Typoskala, Farben, Buttons, Eingabefeldern und Karten. Verwende nur die Tokens aus tokens.css und keine externen URLs.',
      manage: 'Systeme verwalten…',
      title: 'Designsysteme',
      description: 'Tokens, Richtlinien und eine Musterseite, die Designs wiederverwenden können',
      saveTitle: 'Dieses Design als System speichern',
      nameLabel: 'Systemname',
      namePlaceholder: 'z. B. Studiomarke',
      descriptionLabel: 'Wofür es gedacht ist',
      descriptionPlaceholder: 'Optional',
      save: 'System speichern',
      saved: 'Designsystem gespeichert',
      noSave: 'Öffne ein Design, um es als System zu speichern.',
      listTitle: 'Gespeicherte Systeme',
      empty: 'Noch keine Designsysteme',
      emptyHint: 'Speichere ein Design als System oder importiere die Tokens eines Projektordners.',
      noSpecimen: 'Noch kein Muster',
      tokens: 'Tokens',
      specimen: 'Muster',
      fromDesign: 'Aus einem Design',
      fromFolder: 'Aus einem Ordner',
      apply: 'Hier verwenden',
      applied: 'System angewendet. Frühere Dateien sind als Version gespeichert.',
      inUse: 'In Verwendung',
      rename: 'Umbenennen',
      delete: 'Löschen',
      deleteTitle: 'Dieses System löschen?',
      deleteMessage: 'Seine Dateien verlassen die Bibliothek. Designs, die es schon verwenden, behalten ihre Kopien.',
      deleteConfirm: 'System löschen',
      imported: 'System aus dem Ordner importiert'
    },
    handoff: {
      bundle: 'Paket herunterladen (.zip)', toCode: 'An Code übergeben…', copyPrompt: 'Build-Prompt kopieren', copyDoc: 'HANDOFF.md kopieren', bundled: 'Paket gespeichert', copied: 'Kopiert',
      dialog: {
        keepHtml: 'HTML/CSS beibehalten',
        title: 'An Code übergeben', description: 'Kopiert das Design in ein Projekt und öffnet eine Code-Unterhaltung mit dem Build-Prompt. Nichts läuft, bevor du sendest.', project: 'Projekt',
        noProjects: 'Noch keine Projekte. Wähle einen Ordner, um eines hinzuzufügen.', choose: 'Ordner wählen…', stack: 'Bauen mit', stackCustom: 'Anderer Stack, z. B. Next.js + Tailwind',
        copies: 'Kopiert das Design und seine HANDOFF.md in einen neuen Ordner unter', confirm: 'Übergeben', working: 'Wird kopiert…',
        cancel: 'Abbrechen', needProject: 'Wähle zuerst einen Projektordner.', failed: 'Design konnte nicht übergeben werden'
      }
    }
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
    changeRuntime: 'Runtime wechseln', configureProvider: 'Anbieter einrichten',
    loadFailed: {
      oom: 'Nicht genug Speicher für dieses Modell. Verringere Kontextlänge oder GPU-Layer oder wähle eine kleinere Quantisierung.',
      port: 'Der Port des lokalen Servers ist belegt. Beende den anderen llama-server und versuche es erneut.',
      runtime: 'Die llama.cpp-Runtime fehlt oder konnte nicht starten. Installiere sie unter Runtimes neu.',
      file: 'Diese Modelldatei konnte nicht gelesen werden. Sie ist evtl. unvollständig oder kein gültiges GGUF.',
      generic: 'Das Modell konnte nicht geladen werden: {reason}'
    }
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
    splitRight: '横に開く', splitBelow: '下に開く', splitTooSmall: 'ウィンドウが狭すぎて分割できません',
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
    needsApproval: '承認が必要', approvalLede: '判断するまで実行は一時停止しています。', approvalDestructive: 'データを変更・削除する可能性があります。',
    allow: '許可', deny: '拒否', failed: '失敗', cancelled: 'キャンセル済み', stopped: '停止済み',
    done: '完了', error: 'エラー', result: '結果', truncated: '…（省略）'
  },
  codeRun: { read: '読み取り', write: '書き込み', edit: '編集', bash: '実行', grep: '検索', ls: '一覧', todo_write: 'タスクを更新', git_status: 'Git ステータス', git_diff: 'Git 差分', browser_open: 'ページを開く', browser_snapshot: 'ページを読む', browser_click: 'クリック', browser_fill: '入力', browser_select: '選択', browser_press: 'キーを押す', browser_hover: 'ホバー', browser_scroll: 'スクロール', browser_wait: 'ページを待つ', browser_back: '戻る', browser_reload: '再読み込み', browser_console: 'コンソール確認', browser_screenshot: 'スクリーンショット', process_list: 'プロセス一覧', process_output: '出力を読む', process_stop: 'プロセス停止', message_bot: '依頼', memory_update: '記憶', approvePlan: 'プランを承認', approval: '承認', approved: '承認済み', denied: '拒否', compacting: 'コンテキストを圧縮中', compacted: 'コンテキストを圧縮しました', continuing: '出力上限に達しました — 続行中', planNote: '承認するとエージェントが編集を始めます。各編集は引き続き個別に確認します。', turnLimit: 'ターン上限で停止しました', interrupted: '中断 — 実行中にアプリが終了しました', plan: 'プラン', noReply: 'モデルが応答せずに終了しました。もう一度試すか、ツールに強いモデルに切り替えてください。' },
  untitled: { home: '新しいチャット', code: '新しい会話', roleplay: '新しいロールプレイ', design: '新しいデザイン' },
  spaces: { label: 'セクション', home: 'ホーム', code: 'コード', roleplay: 'ロールプレイ', design: 'デザイン', bots: 'ボット' },
  roleplay: {
    newRoleplay: '新しいロールプレイ', characters: 'キャラクター', library: 'キャラクターライブラリ', newCharacter: '新しいキャラクター',
    importCharacter: 'インポート', pickCharacter: 'キャラクターを選んで始めましょう', pickCharacterHint: '作成したキャラクターがここに表示されます。',
    noRoleplays: 'ロールプレイのセッションはまだありません', noRoleplaysHint: 'キャラクターとシーンを始めるとここに表示されます。',
    enableInSettings: '設定 → 一般 でロールプレイを有効にしてください。'
  },
  design: {
    newDesign: '新しいデザイン', noDesigns: 'デザインはまだありません', noDesignsHint: '画面を説明すると、ここで形になります。',
    steps: { design_list: 'ファイル一覧', design_read: '読み取り', design_write: '書き込み', design_edit: '編集', design_snapshot: 'バージョンを保存', design_preview: 'プレビュー', design_inspect: '検査', design_motion: 'モーション', design_reference: '参考を調べる', design_view: '画像を表示' },
    canvas: { empty: '画面から始める', emptyHint: 'チャットで説明するか、スターターを選んでください。書き出されるとすぐここに表示されます。', reload: 'プレビューを再読み込み', openFolder: 'デザインのフォルダを開く', hideChat: 'チャットを隠す', showChat: 'チャットを表示', previewLabel: 'デザインのプレビュー', viewport: 'ビューポート', page: 'ページ' },
    suggestions: [
      { id: 'landing', label: 'ランディングページ', prompt: '製品のランディングページをデザインして。ヒーロー、3つの機能ブロック、料金、フッター付き。' },
      { id: 'dashboard', label: 'ダッシュボード', prompt: 'サイドバー、KPIカード、グラフ、最近のアクティビティ表を備えた分析ダッシュボードをデザインして。' },
      { id: 'mobile', label: 'モバイルアプリ', prompt: 'モバイルのオンボーディングをデザインして：ようこそ、権限、登録の画面、幅390px。' },
      { id: 'pricing', label: '料金', prompt: '3つのプラン、月額/年額の切り替え、FAQ付きの料金ページをデザインして。' },
      { id: 'login', label: 'サインイン', prompt: 'メール、パスワード、ソーシャルログイン付きのすっきりしたサインイン画面をデザインして。' },
      { id: 'micro', label: 'マイクロインタラクション', prompt: '小さなUIのマイクロインタラクションをデザインしてください。ホバー、押下、フォーカスの状態のボタン、スライドするトグル、出入りするトーストを、モーショントークンと動きを減らした版で作ってください。' },
    ],
    timeline: {
      title: 'タイムライン', play: '再生', pause: '一時停止', replay: '最初から', speed: '再生速度', reduced: '動きを減らすプレビュー',
      reducedHint: 'プレビュー: ここでは動きを減らす設定と同じように時間を短縮します', close: 'タイムラインを閉じる', scrub: 'タイムラインをシーク', change: 'このアニメーションを変更',
      none: 'このページにはアニメーションがありません。', noneHint: 'トランジションかアニメーションを追加してから、タイムラインを開き直してください。'
    },
    motion: {
      presets: { standard: '標準', decelerate: '減速', accelerate: '加速', emphasized: '強調', spring: 'スプリング' },
      custom: 'カスタム'
    },
    viewports: { mobile: 'モバイル', tablet: 'タブレット', desktop: 'デスクトップ', fit: 'フィット' },
    variants: { title: 'バリアント', none: 'バリアントはまだありません', noneHint: '選択肢を依頼してください。例:「ヒーローの3つの方向性」', use: 'このバリアントを使う', current: '現在のデザイン', close: '閉じる' },
    versions: { title: 'バージョン', none: 'バージョンはまだありません', restore: '復元', auto: 'ターン終了後に保存', files: 'ファイル', restored: 'バージョンを復元しました' },
    select: { hint: '要素をクリック · Shift+クリックで追加 · テキストをダブルクリックで編集 · Escで終了', element: '要素', remove: '削除', clear: 'クリア', clearAll: 'すべてクリア', showMore: 'すべて表示', showFewer: '折りたたむ' },
    comments: { pin: 'コメント', placeholder: 'ここで何を変えますか?', hint: 'Enterで保存 · Escでキャンセル', save: '保存', cancel: 'キャンセル', chip: 'コメント' },
    zoom: { label: 'ズーム', fit: 'ウィンドウに合わせる', actual: '実寸', in: '拡大', out: '縮小' },
    empty: { title: '画面から始める', hint: 'チャットで説明するか、下のスターターから選んでください。書き出されるとすぐ、ここに形になります。', sketching: '最初の画面をスケッチ中…' },
    resize: { dock: 'チャットの幅を変更 · ダブルクリックで元に戻す', inspector: 'インスペクターの幅を変更 · ダブルクリックで元に戻す' },
    dock: { title: '何をデザインしましょうか?', hint: '画面、フロー、または製品全体。説明するか、スターターから始めてください。', placeholder: '画面を説明するか、変更する要素を選択してください', starters: 'スターター' },
    toolbar: {
      viewport: { mobile: 'モバイル · 390px', tablet: 'タブレット · 834px', desktop: 'デスクトップ · 1440px', fit: 'ウィンドウに合わせる' },
      zoom: 'ズーム', zoomIn: '拡大', zoomOut: '縮小', zoomFit: 'ウィンドウに合わせる', zoomReset: '実寸',
      scheme: { label: 'プレビューの配色', auto: '自動', light: 'ライト', dark: 'ダーク' },
      inspector: 'インスペクター', showInspector: 'インスペクターを表示', hideInspector: 'インスペクターを隠す', more: 'その他', fit: '合わせる'
    },
    tools: {
      label: 'キャンバスツール', browse: '閲覧', select: '要素を選択', comment: 'キャンバスにコメント',
      comments: 'コメント', sendComments: 'コメントを送信', commentsSent: 'コメントを次のメッセージに追加しました'
    },
    prompt: { placeholder: 'この要素への変更を入力', send: '変更を送信' },
    inspector: {
      element: '要素', tokens: 'トークン', code: 'コード', none: 'キャンバス上の要素を選択してください',
      noneHint: 'テキスト、ボックス、スタイルがここに表示され、簡単な変更はチャットに送られます。',
      text: 'テキスト', box: 'ボックス', styles: 'スタイル', changes: 'クイック変更',
      prominent: 'より目立たせる', tighten: '余白を詰める', variants: 'これの3つのバリアントを試す',
      noTokens: 'トークンはまだありません', tokensHint: '例:「色、余白、角丸のトークンを定義して」とトークンファイルを依頼してください。',
      colors: '色', space: '余白', radius: '角丸', type: 'タイプ', shadow: '影', other: 'その他',
      moreSelected: '件を追加で選択', motion: 'モーション', updateFailed: 'トークンを更新できませんでした', noSource: 'まだ表示するものがありません', file: 'ファイル', copy: 'コピー', copied: 'コピーしました'
    },
    export: { button: '書き出す', copyHtml: 'HTMLをコピー', download: 'HTMLをダウンロード', openBrowser: 'ブラウザで開く', copied: 'HTMLをコピーしました', failed: '書き出しに失敗しました' },
    systems: {
      label: 'デザインシステム',
      intro: 'システムから始める',
      none: 'システムなし',
      saveAs: 'デザインをシステムとして保存…',
      import: 'フォルダーから読み込む…',
      specimenAction: 'スペシメンを生成',
      specimenPrompt: 'components.html を書いてください。このデザインシステムのスペシメンページとして、タイプスケール、色、ボタン、入力欄、カードを示してください。tokens.css のトークンだけを使い、外部URLは使わないでください。',
      manage: 'システムを管理…',
      title: 'デザインシステム',
      description: 'デザインが再利用できるトークン、ガイドライン、スペシメンページ',
      saveTitle: 'このデザインをシステムとして保存',
      nameLabel: 'システム名',
      namePlaceholder: '例: スタジオのブランド',
      descriptionLabel: '用途',
      descriptionPlaceholder: '任意',
      save: 'システムを保存',
      saved: 'デザインシステムを保存しました',
      noSave: 'デザインを開くと、システムとして保存できます。',
      listTitle: '保存済みのシステム',
      empty: 'デザインシステムはまだありません',
      emptyHint: 'デザインをシステムとして保存するか、プロジェクトフォルダーのトークンを読み込みます。',
      noSpecimen: 'スペシメンはまだありません',
      tokens: 'トークン',
      specimen: 'スペシメン',
      fromDesign: 'デザインから',
      fromFolder: 'フォルダーから',
      apply: 'ここで使う',
      applied: 'システムを適用しました。以前のファイルはバージョンとして保存されています。',
      inUse: '使用中',
      rename: '名前を変更',
      delete: '削除',
      deleteTitle: 'このシステムを削除しますか？',
      deleteMessage: 'ファイルはライブラリから削除されます。すでに使っているデザインはコピーを保持します。',
      deleteConfirm: 'システムを削除',
      imported: 'フォルダーからシステムを読み込みました'
    },
    handoff: {
      bundle: 'バンドルをダウンロード (.zip)', toCode: 'Code に引き継ぐ…', copyPrompt: 'ビルド用プロンプトをコピー', copyDoc: 'HANDOFF.md をコピー', bundled: 'バンドルを保存しました', copied: 'コピーしました',
      dialog: {
        keepHtml: 'HTML/CSS のまま',
        title: 'Code に引き継ぐ', description: 'デザインをプロジェクトにコピーし、ビルド用プロンプトを入れたコード会話を開きます。送信するまで何も実行されません。', project: 'プロジェクト',
        noProjects: 'プロジェクトはまだありません。フォルダーを選んで追加してください。', choose: 'フォルダーを選択…', stack: '構築に使う技術', stackCustom: '別の構成（例: Next.js + Tailwind）',
        copies: 'デザインと HANDOFF.md を次の下の新しいフォルダーにコピーします：', confirm: '引き継ぐ', working: 'コピー中…',
        cancel: 'キャンセル', needProject: '先にプロジェクトのフォルダーを選んでください。', failed: 'デザインを引き継げませんでした'
      }
    }
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
    changeRuntime: 'ランタイムを変更', configureProvider: 'プロバイダーを設定',
    loadFailed: {
      oom: 'このモデルを読み込むメモリが足りません。コンテキスト長や GPU レイヤーを減らすか、小さい量子化を選んでください。',
      port: 'ローカルサーバーのポートが使用中です。別の llama-server を終了してから再試行してください。',
      runtime: 'llama.cpp ランタイムが見つからないか、起動できませんでした。ランタイムから再インストールしてください。',
      file: 'このモデルファイルを読み込めませんでした。不完全か、有効な GGUF ではない可能性があります。',
      generic: 'モデルを読み込めませんでした: {reason}'
    }
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
    splitRight: '在旁边打开', splitBelow: '在下方打开', splitTooSmall: '窗口太窄，无法拆分',
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
    needsApproval: '需要批准', approvalLede: '在你决定之前，运行已暂停。', approvalDestructive: '这可能会修改或删除数据。',
    allow: '允许', deny: '拒绝', failed: '失败', cancelled: '已取消', stopped: '已停止',
    done: '完成', error: '错误', result: '结果', truncated: '…（已截断）'
  },
  codeRun: { read: '读取', write: '写入', edit: '编辑', bash: '运行', grep: '搜索', ls: '列出', todo_write: '更新任务', git_status: 'Git 状态', git_diff: 'Git 差异', browser_open: '打开页面', browser_snapshot: '读取页面', browser_click: '点击', browser_fill: '输入', browser_select: '选择选项', browser_press: '按键', browser_hover: '悬停', browser_scroll: '滚动', browser_wait: '等待页面', browser_back: '返回', browser_reload: '重新加载', browser_console: '检查控制台', browser_screenshot: '截图', process_list: '列出进程', process_output: '读取进程输出', process_stop: '停止进程', message_bot: '询问', memory_update: '记住', approvePlan: '批准计划', approval: '批准', approved: '已批准', denied: '已拒绝', compacting: '正在压缩上下文', compacted: '上下文已压缩', continuing: '达到输出上限 — 继续中', planNote: '批准后代理开始编辑；每次编辑仍会单独询问。', turnLimit: '已在轮次上限处停止', interrupted: '已中断 — 运行期间应用已关闭', plan: '计划', noReply: '模型未作答就结束了。请重试，或换用更擅长工具调用的模型。' },
  untitled: { home: '新对话', code: '新会话', roleplay: '新角色扮演', design: '新设计' },
  spaces: { label: '分区', home: '主页', code: '代码', roleplay: '角色扮演', design: '设计', bots: '机器人' },
  roleplay: {
    newRoleplay: '新角色扮演', characters: '角色', library: '角色库', newCharacter: '新角色',
    importCharacter: '导入', pickCharacter: '选择一个角色开始', pickCharacterHint: '你创建的角色会显示在这里。',
    noRoleplays: '还没有角色扮演会话', noRoleplaysHint: '和角色开始一个场景后会显示在这里。',
    enableInSettings: '在 设置 → 通用 中启用角色扮演。'
  },
  design: {
    newDesign: '新设计', noDesigns: '还没有设计', noDesignsHint: '描述一个界面，它会在这里成形。',
    steps: { design_list: '列出文件', design_read: '读取', design_write: '写入', design_edit: '编辑', design_snapshot: '保存版本', design_preview: '预览', design_inspect: '检查', design_motion: '动效', design_reference: '研究参考', design_view: '查看图片' },
    canvas: { empty: '从一个页面开始', emptyHint: '在聊天中描述它，或选择一个起点。页面一写好就会显示在这里。', reload: '重新加载预览', openFolder: '打开设计文件夹', hideChat: '隐藏聊天', showChat: '显示聊天', previewLabel: '设计预览', viewport: '视口', page: '页面' },
    suggestions: [
      { id: 'landing', label: '落地页', prompt: '为一个产品设计落地页：主视觉、三个功能区块、价格和页脚。' },
      { id: 'dashboard', label: '仪表盘', prompt: '设计一个分析仪表盘，包含侧边栏、KPI 卡片、一张图表和最近活动表格。' },
      { id: 'mobile', label: '移动应用', prompt: '设计一个移动端引导流程：欢迎、权限和注册页面，宽 390px。' },
      { id: 'pricing', label: '价格', prompt: '设计一个价格页，包含三个套餐、月付/年付切换和常见问题。' },
      { id: 'login', label: '登录', prompt: '设计一个简洁的登录页，包含邮箱、密码和社交登录选项。' },
      { id: 'micro', label: '微交互', prompt: '为一个小型界面设计微交互：按钮的悬停、按下和聚焦状态，一个滑动开关，以及进入和退出的提示。全部使用动效令牌，并提供减少动态效果的版本。' },
    ],
    timeline: {
      title: '时间线', play: '播放', pause: '暂停', replay: '重播', speed: '播放速度', reduced: '减少动态效果预览',
      reducedHint: '预览：这里按减少动态效果的设置缩短时长', close: '关闭时间线', scrub: '拖动时间线', change: '更改此动画',
      none: '此页面没有动画。', noneHint: '添加过渡或动画，然后重新打开时间线。'
    },
    motion: {
      presets: { standard: '标准', decelerate: '减速', accelerate: '加速', emphasized: '强调', spring: '弹簧' },
      custom: '自定义'
    },
    viewports: { mobile: '手机', tablet: '平板', desktop: '桌面', fit: '适应' },
    variants: { title: '变体', none: '还没有变体', noneHint: '请求多个方案，例如“首屏的三种方向”。', use: '使用此变体', current: '当前设计', close: '关闭' },
    versions: { title: '版本', none: '还没有版本', restore: '恢复', auto: '每轮结束后保存', files: '个文件', restored: '版本已恢复' },
    select: { hint: '点击元素 · Shift+点击添加 · 双击文字编辑 · Esc 结束', element: '元素', remove: '移除', clear: '清除', clearAll: '全部清除', showMore: '全部显示', showFewer: '收起' },
    comments: { pin: '评论', placeholder: '这里要改什么？', hint: 'Enter 保存 · Esc 取消', save: '保存', cancel: '取消', chip: '评论' },
    zoom: { label: '缩放', fit: '适应面板', actual: '实际大小', in: '放大', out: '缩小' },
    empty: { title: '从一个页面开始', hint: '在聊天中描述它，或从下方的起点中选择。页面一写好就会在这里成形。', sketching: '正在绘制第一个界面…' },
    resize: { dock: '调整对话宽度 · 双击恢复', inspector: '调整检查器宽度 · 双击恢复' },
    dock: { title: '我们要设计什么？', hint: '一个界面、一个流程，或整个产品。描述一下，或从起点开始。', placeholder: '描述一个界面，或选择一个元素进行修改', starters: '起点' },
    toolbar: {
      viewport: { mobile: '手机 · 390px', tablet: '平板 · 834px', desktop: '桌面 · 1440px', fit: '适应面板' },
      zoom: '缩放', zoomIn: '放大', zoomOut: '缩小', zoomFit: '适应面板', zoomReset: '实际大小',
      scheme: { label: '预览配色', auto: '自动', light: '浅色', dark: '深色' },
      inspector: '检查器', showInspector: '显示检查器', hideInspector: '隐藏检查器', more: '更多', fit: '适应'
    },
    tools: {
      label: '画布工具', browse: '浏览', select: '选择元素', comment: '在画布上评论',
      comments: '评论', sendComments: '发送评论', commentsSent: '评论已添加到下一条消息'
    },
    prompt: { placeholder: '描述要做的修改', send: '发送修改' },
    inspector: {
      element: '元素', tokens: '令牌', code: '代码', none: '在画布上选择一个元素',
      noneHint: '它的文字、盒模型和样式会显示在这里，快速修改会发送到聊天。',
      text: '文字', box: '盒模型', styles: '样式', changes: '快速修改',
      prominent: '让它更醒目', tighten: '收紧间距', variants: '为此尝试 3 个变体',
      noTokens: '还没有令牌', tokensHint: '请求一个令牌文件，例如“定义颜色、间距和圆角令牌”。',
      colors: '颜色', space: '间距', radius: '圆角', type: '字体', shadow: '阴影', other: '其他',
      moreSelected: '个已选中', motion: '动效', updateFailed: '无法更新令牌', noSource: '暂无内容', file: '文件', copy: '复制', copied: '已复制'
    },
    export: { button: '导出', copyHtml: '复制 HTML', download: '下载 HTML', openBrowser: '在浏览器中打开', copied: 'HTML 已复制', failed: '导出失败' },
    systems: {
      label: '设计系统',
      intro: '从一个系统开始',
      none: '无系统',
      saveAs: '将设计保存为系统…',
      import: '从文件夹导入…',
      specimenAction: '生成样式页',
      specimenPrompt: '请编写 components.html：此设计系统的样式页，展示字号层级、颜色、按钮、输入框和卡片。只使用 tokens.css 中的变量，不要使用外部网址。',
      manage: '管理系统…',
      title: '设计系统',
      description: '可供设计复用的变量、指南和样式页',
      saveTitle: '将此设计保存为系统',
      nameLabel: '系统名称',
      namePlaceholder: '例如：工作室品牌',
      descriptionLabel: '用途',
      descriptionPlaceholder: '可选',
      save: '保存系统',
      saved: '设计系统已保存',
      noSave: '打开一个设计，即可将其保存为系统。',
      listTitle: '已保存的系统',
      empty: '还没有设计系统',
      emptyHint: '将设计保存为系统，或从项目文件夹导入变量。',
      noSpecimen: '还没有样式页',
      tokens: '变量',
      specimen: '样式页',
      fromDesign: '来自设计',
      fromFolder: '来自文件夹',
      apply: '在此使用',
      applied: '已应用系统。之前的文件已保存为一个版本。',
      inUse: '使用中',
      rename: '重命名',
      delete: '删除',
      deleteTitle: '删除此系统？',
      deleteMessage: '其文件将从库中移除。已在使用它的设计会保留各自的副本。',
      deleteConfirm: '删除系统',
      imported: '已从文件夹导入系统'
    },
    handoff: {
      bundle: '下载打包文件 (.zip)', toCode: '交给代码…', copyPrompt: '复制构建提示词', copyDoc: '复制 HANDOFF.md', bundled: '打包文件已保存', copied: '已复制',
      dialog: {
        keepHtml: '保持 HTML/CSS',
        title: '交给代码', description: '将设计复制到项目中，然后打开一个带有构建提示词的代码会话。发送之前不会执行任何操作。', project: '项目',
        noProjects: '还没有项目。选择一个文件夹来添加。', choose: '选择文件夹…', stack: '构建方式', stackCustom: '其他技术栈，例如 Next.js + Tailwind',
        copies: '将设计及其 HANDOFF.md 复制到以下路径下的新文件夹：', confirm: '交付', working: '复制中…',
        cancel: '取消', needProject: '请先选择项目文件夹。', failed: '无法交付设计'
      }
    }
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
    changeRuntime: '更换运行时', configureProvider: '配置提供商',
    loadFailed: {
      oom: '内存不足，无法加载此模型。请降低上下文长度或 GPU 层数，或选择更小的量化版本。',
      port: '本地服务器端口已被占用。请关闭另一个 llama-server 后重试。',
      runtime: 'llama.cpp 运行时缺失或启动失败。请在运行时中重新安装。',
      file: '无法读取此模型文件。它可能不完整或不是有效的 GGUF。',
      generic: '模型加载失败：{reason}'
    }
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
