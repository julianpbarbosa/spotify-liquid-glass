// liquid-glass.js — extensão do Spicetify do projeto "Spotify Liquid Glass"
//
// O CSS (theme/user.css) cuida da aparência. Esta extensão faz o que o CSS não consegue:
//  - lê a música tocando e as cores da capa (luz de fundo, brilho, cor dinâmica);
//  - cria elementos novos: cabeçalho de boas-vindas, botão de paleta, minimizar/fechar,
//    volume em botão giratório, capas com cara de caixinha de CD e disco de vinil;
//  - desenha efeitos em canvas (aura sonora da barra lateral, ondas, luz nos cabeçalhos);
//  - ajusta o layout por medida (painel "Tocando agora" responsivo, alinhamento da barra de cima);
//  - esconde a barra de título do Spotify (F8 liga/desliga) e fala com a janela.
//
// Desempenho: um único agendador roda as tarefas (rápido quando há atividade, bem devagar parado,
// pausado com o app escondido); o fundo animado do Spicy é copiado em miniatura e o fundo do Hazy
// é desenhado já desfocado (uma vez por música), em vez de filtros pesados ao vivo na placa de vídeo.
// O CSS NÃO é mais copiado para cá: ele vem só do theme/user.css (a extensão só confere a versão).
//
// Depuração: no Console do DevTools, rode  jcDebug().  Teste de desempenho: botão na janelinha de cores, F9 ou jcPerf().
//
// Instalar: copie para %appdata%\spicetify\Extensions\
//   spicetify config extensions liquid-glass.js
//   spicetify apply
(async function liquidGlass() {
    while (!(window.Spicetify && Spicetify.Platform && Spicetify.Platform.History)) {
        await new Promise(r => setTimeout(r, 200));
    }

    const BANNER = 'div[data-testid="background-image"]';
    // Rolador principal, o mesmo que o próprio Hazy observa (hazy.js)
    const MAIN_VIEWPORT = '#main-view [data-overlayscrollbars-viewport], .Root__main-view [data-overlayscrollbars-viewport]';
    const AT_TOP_PX = 24;
    const root = document.documentElement;

    // ---- agendador único -------------------------------------------------------------------
    // Antes cada tarefa tinha o seu setInterval (uns 20, todos varrendo a tela de 0,5 a 1 s mesmo
    // sem nada mudar). Agora há UM relógio: as tarefas rodam no ritmo normal enquanto há atividade
    // (rolar, clicar, trocar de página/música, redimensionar, elementos novos na tela) e, depois de
    // alguns segundos parado, passam para um ritmo bem mais lento. Com o app escondido não rodam.
    const ACTIVE_MS = 5000;
    const tasks = [];
    let lastAct = performance.now(), boost = false, tickT = 0, tickAt = 0;
    // troca de tela: o Spotify monta a página nova em vários pedaços. Enquanto chegam elementos novos,
    // as tarefas (que medem a página e forçam o navegador a recalcular o layout) esperam ela assentar.
    let lastMut = 0, burstAt = 0;
    // fxPause: o teste de desempenho desliga as tarefas e animações do tema por alguns segundos.
    // lite: "modo leve" (escolhido na janelinha de cores): sem aura, ondas e cópias animadas do fundo.
    let fxPause = false, lite = false;
    try { lite = localStorage.getItem('jc-lite') === '1'; } catch (e) { /* sem armazenamento */ }
    if (lite) root.setAttribute('data-jc-lite', '');
    const taskStat = new Map();   // tempo gasto por tarefa (aparece no teste de desempenho)
    function timed(name, fn) {   // mede também os laços de animação (aura, ondas, cópia do fundo)
        const key = { fn: { name } };
        return function () {
            const s0 = performance.now();
            try { return fn.apply(this, arguments); } finally {
                const dt = performance.now() - s0, st = taskStat.get(key) || { n: 0, tot: 0, max: 0 };
                st.n++; st.tot += dt; if (dt > st.max) st.max = dt; taskStat.set(key, st);
            }
        };
    }
    const SETTLE_MS = 300, SETTLE_MAX = 2500;
    function act() {
        lastAct = performance.now();
        boost = true;
        if (!tickAt || tickAt > lastAct + 120) kick(60);
    }
    function kick(ms) {
        clearTimeout(tickT);
        tickAt = performance.now() + ms;
        tickT = setTimeout(tick, ms);
    }
    // opt: true ou 'live' = roda sempre, mesmo na troca de tela (tarefas leves, sem medir a página);
    //      'mut:main side' = só roda se mudou alguma dessas regiões da tela desde a última vez (elementos
    //      novos ou imagem carregada ali), ou a janela, ou a página aberta. No Spotify cada medida da página
    //      pode custar centenas de ms: sem mudança, nada a medir. Regiões: main (área do meio), side (barra
    //      lateral), panel (painel da direita), bar (player), nav (barra de cima).
    const mutR = { main: 1, side: 1, panel: 1, bar: 1, nav: 1, mainimg: 1 };   // mainimg: imagem carregou na área do meio
    let mutG = 1;   // janela redimensionada ou outra página aberta: vale para todas
    const REGION_SEL = '#main-view, #Desktop_LeftSidebar_Id, #Desktop_PanelContainer_Id, .Root__right-sidebar, aside.main-nowPlayingBar-container, [data-testid="now-playing-bar"], #global-nav-bar';
    function regionOf(el) {
        const r = el && el.closest ? el.closest(REGION_SEL) : null;
        if (!r) return null;
        if (r.id === 'main-view') return 'main';
        if (r.id === 'Desktop_LeftSidebar_Id') return 'side';
        if (r.id === 'global-nav-bar') return 'nav';
        if (r.id === 'Desktop_PanelContainer_Id' || r.classList.contains('Root__right-sidebar')) return 'panel';
        return 'bar';
    }
    function every(fn, ms, idleMs, opt) {
        const regs = typeof opt === 'string' && opt.indexOf('mut:') === 0 ? opt.slice(4).trim().split(/\s+/) : null;
        const t = { fn, ms, live: opt === true || opt === 'live', mut: !!regs, regs, seen: '', idle: idleMs || Math.min(4000, Math.max(2000, ms * 3)), due: performance.now() + Math.min(ms, 400) };
        tasks.push(t);
        if (!tickAt) kick(50);
        return t;
    }
    // As tarefas medem a página (getBoundingClientRect, getComputedStyle). Rodando logo DEPOIS de um
    // quadro (requestAnimationFrame + setTimeout 0) o layout já está pronto e a medida sai de graça;
    // no meio do caminho ela obrigava o navegador a refazer o layout da página inteira.
    let runPending = false;
    function tick() {
        tickAt = 0;
        if (document.hidden) { kick(1000); return; }
        if (runPending) return;
        runPending = true;
        // requestIdleCallback: o navegador chama quando NÃO tem nada para fazer (o Spotify terminou de montar
        // a tela, o quadro já foi desenhado): as tarefas do tema nunca disputam com o próprio Spotify
        if (window.requestIdleCallback) requestIdleCallback(runDue, { timeout: 400 });
        else requestAnimationFrame(() => setTimeout(runDue, 0));
    }
    function runDue(deadline) {
        runPending = false;
        const t0 = performance.now();
        const idleLeft = () => (deadline && !deadline.didTimeout ? deadline.timeRemaining() : 4 - (performance.now() - t0));
        if (document.hidden) { kick(1000); return; }
        const active = t0 - lastAct < ACTIVE_MS;
        const settling = t0 - lastMut < SETTLE_MS && t0 - burstAt < SETTLE_MAX;
        if (boost) {   // houve atividade: o que estava esperando no ritmo lento volta ao normal
            boost = false;
            tasks.forEach((t) => { if (t.due > t0 + t.ms) t.due = t0 + t.ms; });
        }
        let next = 1e9, ran = 0;
        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            if (t.due <= performance.now()) {
                if ((settling || fxPause) && !t.live) { next = Math.min(next, SETTLE_MS); continue; }
                if (ran && idleLeft() < 3) { next = Math.min(next, 25); continue; }   // acabou a folga: o resto fica para a próxima
                // depois de cada mudança a tarefa ainda roda 3 vezes (uma marca o que a outra usa, imagens
                // terminam de carregar); aí descansa até a próxima mudança (ou 20 s, por garantia)
                if (t.mut) {
                    const sig = mutG + ':' + t.regs.map((k) => mutR[k]).join(',');
                    if (t.seen !== sig) { t.seen = sig; t.stable = 0; } else t.stable = (t.stable || 0) + 1;
                    if (t.stable >= 3 && performance.now() - (t.ranAt || 0) < 20000) { t.due = performance.now() + t.ms; next = Math.min(next, t.ms); continue; }
                    if (t.stable >= 3) t.stable = 0;
                }
                t.ranAt = performance.now();
                const s0 = performance.now(); ran++;
                try { t.fn(); } catch (e) { t.err = (e && e.message) || String(e); }   // uma tarefa com erro não derruba as outras
                const st = taskStat.get(t) || { n: 0, tot: 0, max: 0 }, dt = performance.now() - s0;
                st.n++; st.tot += dt; if (dt > st.max) st.max = dt; taskStat.set(t, st);
                // freio automático: uma tarefa que ficou pesada (página enorme, computador lento) passa a
                // rodar mais espaçada (até 8x); quando volta a ser leve, volta ao ritmo normal
                t.slow = dt > 40 ? Math.min(8, (t.slow || 1) * 2) : dt < 12 ? Math.max(1, (t.slow || 1) / 2) : (t.slow || 1);
                t.due = performance.now() + (active ? t.ms : t.idle) * (t.live ? 1 : t.slow);
            }
            next = Math.min(next, Math.max(25, t.due - performance.now()));
        }
        kick(Math.min(next, 1000));
    }
    ['scroll', 'wheel', 'pointerdown', 'keydown', 'resize', 'load', 'visibilitychange', 'fullscreenchange'].forEach((ev) => {
        const tgt = (ev === 'resize' || ev === 'visibilitychange' || ev === 'fullscreenchange') ? (ev === 'resize' ? window : document) : document;
        tgt.addEventListener(ev, act, { capture: true, passive: true });
    });
    // elementos criados pelo próprio tema (classe jc-..., canvases) não contam como "a página mudou"
    const mutCount = {};   // quantas mudanças por região (aparece no teste de desempenho)
    const ours = (n) => n.tagName === 'CANVAS' || n.tagName === 'STYLE' || /(^|\s)jc-/.test((n.getAttribute && n.getAttribute('class')) || '');
    try {   // elementos novos na tela (página carregando, lista rolando, painel abrindo) = atividade
        new MutationObserver((recs) => {
            for (let i = 0; i < recs.length && i < 12; i++) {
                const r = recs[i];
                if (!r.addedNodes.length && !r.removedNodes.length) continue;
                const tg = r.target;
                if (!tg || tg.nodeType !== 1 || tg.closest('#SpicyLyricsPage, #SpicyLyricsNPVCard, .jc-hero, .jc-pal-pop, canvas')) continue;
                // elementos que entraram OU saíram (ex.: o ícone de "tocando" some quando a música muda)
                const nodes = r.addedNodes.length ? r.addedNodes : r.removedNodes;
                for (let k = 0; k < nodes.length; k++) if (nodes[k].nodeType === 1 && !ours(nodes[k])) {
                    const reg = regionOf(tg);
                    if (!reg) break;   // dicas, menus e avisos soltos no <body>: não mexem nas tarefas
                    mutR[reg]++; mutCount[reg] = (mutCount[reg] || 0) + 1;
                    if (reg === 'main') {   // só a área do meio conta como "página montando"
                        const now = performance.now();
                        if (now - lastMut > 400) burstAt = now;
                        lastMut = now;
                    }
                    act(); return;
                }
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* sem observador: o ritmo lento continua cobrindo */ }
    try {
        Spicetify.Platform.History.listen(() => { mutG++; act(); });
        window.addEventListener('resize', () => { mutG++; });
        document.addEventListener('load', (e) => {   // imagem carregou (capa nova, lista reaproveitada)
            const reg = e.target && e.target.tagName === 'IMG' ? regionOf(e.target) : null;
            if (!reg) return;
            mutCount[reg + '-img'] = (mutCount[reg + '-img'] || 0) + 1;
            if (reg === 'main') {   // as capas da página ainda chegando = página ainda montando (as tarefas esperam)
                mutR.mainimg++;
                const now = performance.now();
                if (now - lastMut > 400) burstAt = now;
                lastMut = now;
            } else mutR[reg]++;
        }, true);
        if (Spicetify.Player && Spicetify.Player.addEventListener) {
            Spicetify.Player.addEventListener('songchange', () => { mutR.bar++; mutR.panel++; act(); songSoon(); });
            Spicetify.Player.addEventListener('onplaypause', () => { mutR.bar++; act(); });
        }
    } catch (e) { /* sem eventos */ }

    // ---- medir sem travar ------------------------------------------------------------------------
    // getBoundingClientRect/offsetWidth/getComputedStyle no meio de uma animação obrigam o navegador a
    // refazer o layout da página na hora; no Spotify (página enorme) isso custava de 100 a 600 ms.
    // Aqui: visibilidade por IntersectionObserver, tamanho por ResizeObserver (os dois chegam prontos,
    // depois do layout que o navegador já ia fazer) e o resto lido logo após um quadro (cleanRead).
    const cleanRead = (fn) => requestAnimationFrame(() => setTimeout(fn, 0));
    // ---- um relógio só para as animações (aura, ondas, mistura do fundo) ----------------------
    // Cada animação com o seu setTimeout fazia o navegador montar um quadro novo para cada uma, em
    // momentos diferentes (até ~80 quadros/s somando tudo). Aqui todas rodam juntas, na mesma grade de
    // 40 ms: um quadro só por vez, com todas as mudanças dentro.
    const FX_GRID = 40;
    const fx = {};
    let fxT = 0, fxAt = 0;
    function fxKick() {
        let due = Infinity;
        for (const k in fx) if (fx[k].on && fx[k].due < due) due = fx[k].due;
        if (due === Infinity) return;
        if (fxT && fxAt <= due) return;
        clearTimeout(fxT);
        fxAt = due;
        fxT = setTimeout(fxRun, Math.max(0, due - performance.now()));
    }
    function fxSet(name, d) {   // a animação diz quando quer rodar de novo (ms); negativo = parar
        const f = fx[name];
        if (!f) return;
        if (d < 0) { f.on = false; return; }
        f.due = Math.ceil((performance.now() + d - 12) / FX_GRID) * FX_GRID;   // -12: o setTimeout atrasa uns ms; sem isso pularia uma volta da grade
        f.set = true;
    }
    function fxStart(name, fn, d) {
        const f = fx[name] || (fx[name] = { fn, due: 0, on: false });
        f.fn = fn;
        if (!f.on) { f.on = true; f.due = Math.ceil((performance.now() + (d || 0)) / FX_GRID) * FX_GRID; }
        fxKick();
    }
    function fxRun() {
        fxT = 0;
        const now = performance.now();
        for (const k in fx) {
            const f = fx[k];
            if (!f.on || f.due > now + 8) continue;
            f.set = false;
            try { f.fn(); } catch (e) { /* enfeite */ }
            if (f.on && !f.set) f.due = Math.ceil((performance.now() + FX_GRID - 12) / FX_GRID) * FX_GRID;
        }
        fxKick();
    }
    const visMap = new WeakMap(), sizeMap = new WeakMap();
    let visIO = null, sizeRO = null;
    try { visIO = new IntersectionObserver((es) => es.forEach((e) => visMap.set(e.target, e.isIntersecting))); } catch (e) { /* sem observador */ }
    try {
        sizeRO = new ResizeObserver((es) => es.forEach((e) => {
            const b = e.borderBoxSize && e.borderBoxSize[0];
            sizeMap.set(e.target, b ? { w: b.inlineSize, h: b.blockSize } : { w: e.contentRect.width, h: e.contentRect.height });
            if (e.target.__onSize) e.target.__onSize();
        }));
    } catch (e) { /* sem observador */ }
    function isVis(el) {   // visível na tela? (a primeira resposta é "sim" até o observador avisar)
        if (!visIO) return true;
        if (!visMap.has(el)) { visMap.set(el, true); visIO.observe(el); }
        return visMap.get(el);
    }
    function sizeOf(el) {   // tamanho da caixa (px CSS) ou null enquanto o observador não respondeu
        if (!sizeRO) { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; }
        if (!sizeMap.has(el)) { sizeMap.set(el, null); sizeRO.observe(el); }
        return sizeMap.get(el);
    }
    // cor de destaque usada pelos canvases (aura, ondas): lida do CSS a cada 3 s, logo após um quadro
    let pcvColor = '255, 255, 255', pcvAt = -1e9, pcvPending = false;
    function pcv() {
        const now = performance.now();
        if (now - pcvAt > 3000 && !pcvPending) {
            pcvPending = true;
            cleanRead(() => {
                pcvPending = false; pcvAt = performance.now();
                const c = getComputedStyle(root).getPropertyValue('--jc-pc-v').trim();
                if (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(c)) pcvColor = c;
            });
        }
        return pcvColor;
    }
    const setRootVar = (k, v) => { if (root.style.getPropertyValue(k) !== v) root.style.setProperty(k, v); };

    // ao trocar de música: cores, brilho, fundo e boas-vindas atualizam já (algumas vezes, porque a capa
    // nova e as variáveis do Hazy chegam em momentos diferentes), sem esperar o ritmo das tarefas
    let songT = [];
    function songSoon() {
        songT.forEach(clearTimeout);
        songT = [80, 350, 900, 1800, 3500].map((ms) => setTimeout(() => {
            try { setGlow('player', findPlayerArt()).catch(() => {}); } catch (e) { /* enfeite */ }
            try { bakeCheck(); } catch (e) { /* enfeite */ }
            if (ms === 350 || ms === 1800) { try { homeHero(); } catch (e) { /* enfeite */ } }
            pcvAt = -1e9;
        }, ms));
    }

    const setY = (px) => {
        const b = document.querySelector(BANNER);
        if (b) b.style.setProperty('--banner-y', px + 'px');
    };

    const setAtTop = (scrollTop) => {   // só mexe no <html> quando muda (era a cada evento de rolagem)
        const v = scrollTop < AT_TOP_PX ? '1' : '0';
        if (root.getAttribute('data-at-top') !== v) root.setAttribute('data-at-top', v);
    };

    // ---- Barra do título (play + nome da playlist/álbum/artista) ----
    // Procura, a partir do título, o ancestral mais externo que parece ser a
    // barra: posicionado (sticky/absolute/fixed), 40–110px de altura, sem conter
    // o cabeçalho grande da página.
    let topbar = null;

    function findTopbar() {
        const title = document.querySelector('.main-entityHeader-topbarTitle');
        if (!title) return null;
        let best = null;
        let e = title.parentElement;
        for (let i = 0; e && i < 10; i++, e = e.parentElement) {
            if (e.matches('.main-view-container, [data-overlayscrollbars-viewport]')) break;
            if (e.querySelector('.main-entityHeader-container')) break;
            const h = e.getBoundingClientRect().height;
            if (h > 110) break;
            if (h >= 40 && /sticky|absolute|fixed/.test(getComputedStyle(e).position)) best = e;
        }
        return best;
    }

    function tagTopbar() {
        const el = findTopbar();
        if (el === topbar) return;
        if (topbar && topbar.isConnected) topbar.removeAttribute('data-jc-topbar');
        topbar = el;
        if (el) el.setAttribute('data-jc-topbar', '');
    }

    // ================= LUZ DE FUNDO (ambient glow) =================
    // Dois alvos: "cover" (capa na página de álbum/playlist) e "player" (arte
    // na barra de reprodução). Para cada um: acha a imagem, lê as cores dos 4
    // quadrantes e grava no elemento --gc-tl/tr/bl/br/m/l/r. O CSS faz o resto.

    // <helpers>
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0;
        const l = (max + min) / 2;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h /= 6;
        }
        return [h, s, l];
    }

    function hslToRgb(h, s, l) {
        if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const f = (t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
    }

    // Média de cor costuma sair "lavada": realça a saturação e mantém a
    // luminosidade numa faixa em que o brilho aparece sobre fundo escuro.
    function vivid(r, g, b) {
        const [h, s0, l0] = rgbToHsl(r, g, b);
        return hslToRgb(h, Math.min(1, s0 * 1.45), clamp(l0, 0.4, 0.62));
    }
    // </helpers>

    // Pede a imagem pelo CDN que aceita CORS (o mesmo que o Hazy usa).
    function normSrc(src) {
        const m = String(src).match(/\/image\/([0-9a-f]{40})/i);
        return m ? 'https://i.scdn.co/image/' + m[1] : src;
    }

    function loadImg(src) {
        return new Promise((resolve) => {
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = () => resolve(im);
            im.onerror = () => resolve(null);
            im.src = src;
        });
    }

    const glowCache = new Map();

    // Cores dos quadrantes de um bloco (uma imagem, ou várias em colagem).
    function glowColors(wrapper, imgs) {
        const wr = wrapper.getBoundingClientRect();
        if (!wr.width || !wr.height) return Promise.resolve(null);
        const items = imgs.map((i) => {
            const r = i.getBoundingClientRect();
            return {
                src: normSrc(i.currentSrc || i.src),
                srcOriginal: i.currentSrc || i.src,
                x: (r.left - wr.left) / wr.width,
                y: (r.top - wr.top) / wr.height,
                w: r.width / wr.width,
                h: r.height / wr.height,
            };
        });
        const key = JSON.stringify(items.map((i) => [i.src, +i.x.toFixed(2), +i.y.toFixed(2), +i.w.toFixed(2), +i.h.toFixed(2)]));
        if (glowCache.has(key)) return glowCache.get(key);

        const p = (async () => {
            // tenta o CDN com CORS; se falhar, a URL original
            const loaded = await Promise.all(items.map(async (it) => {
                const first = await loadImg(it.src);
                return first || await loadImg(it.srcOriginal || it.src);
            }));
            const N = 32;
            const c = document.createElement('canvas');
            c.width = c.height = N;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            let any = false;
            loaded.forEach((im, k) => {
                if (!im) return;
                any = true;
                const it = items[k];
                ctx.drawImage(im, it.x * N, it.y * N, it.w * N, it.h * N);
            });
            if (!any) return null;
            let data;
            try { data = ctx.getImageData(0, 0, N, N).data; } catch (e) { return null; }

            // quadrantes: 0=tl 1=tr 2=bl 3=br  (r, g, b, contagem)
            const q = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
            for (let y = 0; y < N; y++) {
                for (let x = 0; x < N; x++) {
                    const i = (y * N + x) * 4;
                    if (data[i + 3] < 128) continue;
                    const k = (y < N / 2 ? 0 : 2) + (x < N / 2 ? 0 : 1);
                    q[k][0] += data[i]; q[k][1] += data[i + 1]; q[k][2] += data[i + 2]; q[k][3]++;
                }
            }
            const total = q.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]], [0, 0, 0, 0]);
            if (!total[3]) return null;
            const avg = (a, fb) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : fb);
            const mean = avg(total);
            const sum = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
            const fmt = (rgb) => vivid(rgb[0], rgb[1], rgb[2]).join(', ');
            return {
                tl: fmt(avg(q[0], mean)),
                tr: fmt(avg(q[1], mean)),
                bl: fmt(avg(q[2], mean)),
                br: fmt(avg(q[3], mean)),
                m: fmt(mean),
                l: fmt(avg(sum(q[0], q[2]), mean)),   // metade esquerda
                r: fmt(avg(sum(q[1], q[3]), mean)),   // metade direita
            };
        })();

        if (glowCache.size > 60) glowCache.clear();
        glowCache.set(key, p);
        return p;
    }

    // Plano B quando o canvas é bloqueado (CORS): pede as cores ao próprio
    // Spotify, que não depende de CORS. Só para imagens simples.
    async function colorsViaSpotify(img) {
        try {
            const m = String(img.currentSrc || img.src).match(/\/image\/([0-9a-f]{40})/i);
            if (!m || !Spicetify.colorExtractor) return null;
            const c = await Spicetify.colorExtractor('spotify:image:' + m[1]);
            if (!c) return null;
            const hex = (h) => {
                const v = parseInt(String(h || '').replace('#', ''), 16);
                return Number.isNaN(v) ? null : [(v >> 16) & 255, (v >> 8) & 255, v & 255];
            };
            const list = ['VIBRANT', 'LIGHT_VIBRANT', 'PROMINENT', 'VIBRANT_NON_ALARMING', 'DESATURATED']
                .map((k) => hex(c[k])).filter(Boolean);
            if (!list.length) return null;
            const pick = (i) => list[i % list.length];
            const prom = hex(c.PROMINENT) || list[0];
            const f = (rgb) => vivid(rgb[0], rgb[1], rgb[2]).join(', ');
            return { tl: f(pick(0)), tr: f(pick(1)), bl: f(prom), br: f(pick(2)), m: f(prom), l: f(pick(0)), r: f(pick(1)) };
        } catch (e) {
            return null;
        }
    }

    // Maior ancestral com o mesmo tamanho da imagem (ou a colagem 2x2 de uma
    // playlist), para o brilho não ser cortado pelo overflow de um wrapper menor.
    function coverWrapper(img) {
        let el = img;
        for (let i = 0; i < 6; i++) {
            const p = el.parentElement;
            if (!p || p === document.body) break;
            const er = el.getBoundingClientRect();
            const pr = p.getBoundingClientRect();
            const same = Math.abs(pr.width - er.width) <= 3 && Math.abs(pr.height - er.height) <= 3;
            const n = p.querySelectorAll('img').length;
            const collage = n >= 2 && n <= 4 && pr.height > 0 && pr.width <= 420 && Math.abs(pr.width / pr.height - 1) < 0.1;
            if (same || collage) el = p; else break;
        }
        return el;
    }

    const squareish = (r, min, max) =>
        r.height > 0 && r.width >= min && r.width <= max && Math.abs(r.width / r.height - 1) < 0.12;

    // Imagem redonda/arredondada (avatar de artista, círculos do banner da rádio)
    // não é "capa". Capa de álbum tem canto quase reto.
    function isRound(el, r) {
        const rad = getComputedStyle(el).borderTopLeftRadius || '0';
        const v = parseFloat(rad) || 0;
        const px = rad.endsWith('%') ? (v / 100) * r.width : v;
        return px >= r.width * 0.2;
    }


    // Cor "viva" da música (para a barra de tempo): a mais saturada da paleta,
    // com saturação e brilho reforçados. Capa cinza/preto e branco -> prata clara.
    function vividOf(cols) {
        // devolve { v: cor viva (barra de tempo), d: cor funda (ícone do play) }
        let best = null, bestScore = -1;
        Object.values(cols).forEach((c) => {
            const p = String(c).split(',').map((n) => parseFloat(n) / 255);
            if (p.length < 3 || p.some((n) => !isFinite(n))) return;
            const mx = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]);
            const l = (mx + mn) / 2, d = mx - mn;
            const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
            let h = 0;
            if (d) {
                if (mx === p[0]) h = ((p[1] - p[2]) / d) % 6;
                else if (mx === p[1]) h = (p[2] - p[0]) / d + 2;
                else h = (p[0] - p[1]) / d + 4;
                h = (h * 60 + 360) % 360;
            }
            const score = s * (1 - Math.abs(l - 0.5));
            if (score > bestScore) { bestScore = score; best = { h, s, l }; }
        });
        if (!best || best.s < 0.12) return { v: '232, 236, 248', d: '58, 60, 70' };
        const hsl = (h, s, l) => {
            const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
            const seg = Math.floor(h / 60) % 6;
            const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
            return rgb.map((v) => Math.round((v + m) * 255)).join(', ');
        };
        return {
            v: hsl(best.h, Math.max(best.s, 0.88), Math.min(0.6, Math.max(0.5, best.l))),
            d: hsl(best.h, Math.max(best.s, 0.75), 0.38),
        };
    }

    const COVER_PATH = /^\/(album|playlist|show|episode|collection)/;
    const currentPath = () =>
        (Spicetify.Platform.History.location && Spicetify.Platform.History.location.pathname) || '';

    function coverCandidates() {
        const main = document.querySelector('.main-view-container');
        if (!main) return { main: null, scope: null, list: [] };
        const scope = main.querySelector('.main-entityHeader-container') || main;
        const mainTop = main.getBoundingClientRect().top;
        const list = Array.from(scope.querySelectorAll('img')).map((i) => {
            const r = i.getBoundingClientRect();
            const why =
                !i.complete || !i.naturalWidth ? 'imagem ainda não carregou'
                : i.closest(BANNER) ? 'dentro do banner'
                : !squareish(r, 100, 420) ? 'tamanho/forma não é de capa'
                : isRound(i, r) ? 'imagem redonda'
                // sem cabeçalho identificável, só vale o que está perto do topo da página
                : scope === main && r.top - mainTop > 420 ? 'longe do topo'
                : '';
            return { img: i, r, why };
        });
        return { main, scope, list };
    }

    // Estrutura confirmada no DevTools (página de álbum):
    //   .main-entityHeader-container
    //     .main-entityHeader-contentWrapper
    //       button.main-entityHeader-imageContainer      <- recebe o brilho
    //         div.main-entityHeader-image
    //           img.main-entityHeader-image (srcset, loading=lazy)
    const COVER_IMG_SEL = '.main-view-container .main-entityHeader-container .main-entityHeader-image img';

    const usableCover = (i) => {
        if (!i.complete || !i.naturalWidth) return false;
        const r = i.getBoundingClientRect();
        return r.width >= 100 && r.width <= 420 && !i.closest(BANNER) && !isRound(i, r);
    };

    function findCover() {
        // 1) Seletor exato (qualquer cabeçalho de entidade, não só o primeiro)
        let img = Array.from(document.querySelectorAll(COVER_IMG_SEL)).find(usableCover);
        let wrapper = null;
        if (img) {
            wrapper = img.closest('.main-entityHeader-imageContainer') || coverWrapper(img);
        } else {
            // 2) Plano B por heurística (outras estruturas de página)
            if (!COVER_PATH.test(currentPath())) return null;
            const cands = coverCandidates().list.filter((c) => !c.why);
            if (!cands.length) return null;
            cands.sort((a, b) => b.r.width - a.r.width);
            img = cands[0].img;
            wrapper = coverWrapper(img);
        }
        const imgs = wrapper === img ? [img] : Array.from(wrapper.querySelectorAll('img')).filter((i) => i.complete && i.naturalWidth);
        return imgs.length ? { wrapper, imgs } : null;
    }

    const PLAYER_LEFT = '.main-nowPlayingBar-left, [data-testid="now-playing-widget"]';

    function findPlayerArt() {
        const bar = document.querySelector(PLAYER_LEFT);
        if (!bar) return null;
        const cands = Array.from(bar.querySelectorAll('img')).filter((i) => {
            if (!i.complete || !i.naturalWidth) return false;
            return squareish(i.getBoundingClientRect(), 36, 140);
        });
        if (!cands.length) return null;
        cands.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
        const img = cands[0];
        return { wrapper: coverWrapper(img), imgs: [img] };
    }

    // Distância (px) da borda esquerda da arte até a borda direita do último
    // botão do bloco da esquerda (o de curtir/salvar). O brilho vai até lá.
    function playerReach(artRect) {
        const left = document.querySelector(PLAYER_LEFT);
        let right = artRect.right;
        if (left) {
            left.querySelectorAll('button, [role="button"]').forEach((b) => {
                const r = b.getBoundingClientRect();
                if (r.width > 0 && r.right > right && r.right - artRect.left < 560) right = r.right;
            });
        }
        return clamp(right - artRect.left, 160, 520);
    }

    // Bloco arredondado onde a barra do player vive. O brilho é recortado nele,
    // acompanhando a curvatura, em vez de vazar pelas bordas.
    let clipEl = null;
    function markClip(wrapper) {
        let found = null;
        for (let e = wrapper.parentElement; e && e !== document.body; e = e.parentElement) {
            const rad = parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0;
            if (rad >= 6 && e.getBoundingClientRect().width >= 600) { found = { el: e, fallback: false }; break; }
        }
        if (!found) {
            const f = wrapper.closest('.main-nowPlayingBar-container, .Root__now-playing-bar');
            if (f) found = { el: f, fallback: true };
        }
        const el = found && found.el;
        if (clipEl && clipEl !== el && clipEl.isConnected) clipEl.removeAttribute('data-jc-clip');
        clipEl = el || null;
        if (el) el.setAttribute('data-jc-clip', found.fallback ? 'fallback' : 'rounded');
    }

    // O brilho se estende por baixo do título/artista; sobe esses elementos de
    // camada para o texto não ficar tingido por cima.
    let aboveEls = [];
    function markAbove(wrapper) {
        aboveEls.forEach((e) => e.isConnected && e.removeAttribute('data-jc-above'));
        aboveEls = [];
        const cell = wrapper.closest(PLAYER_LEFT);
        if (!cell) return;
        let e = wrapper;
        for (let i = 0; i < 6 && e && e !== cell && e.parentElement; i++, e = e.parentElement) {
            Array.from(e.parentElement.children).forEach((s) => {
                if (s !== e) { s.setAttribute('data-jc-above', ''); aboveEls.push(s); }
            });
        }
    }

    // Cores de destaque (--np-*: bordas, botões, barra de tempo, brilhos). Normalmente são as da
    // capa que toca no player. Quando o painel da direita mostra um clipe (ou um fundo) de OUTRA
    // cor (capa vermelha, clipe verde escuro), os destaques seguem o clipe, para não brigar com ele;
    // só a luz da capa embaixo à esquerda (--gc-* no próprio quadro da capa e --al-*) fica na cor do álbum.
    let albumCols = null, clipCols = null, clipOn = false, clipYes = 0, clipNo = 0, clipBusy = false, clipApplied = '', clipNpAt = 0;
    function setNpVars(cols) {
        Object.keys(cols).forEach((k) => setRootVar('--np-' + k, cols[k]));
        const vv = vividOf(cols);
        setRootVar('--np-vivid', vv.v);
        setRootVar('--np-deep', vv.d);
        pcvAt = -1e9;
    }
    function applyNp() {
        const c = clipOn && clipCols ? clipCols : albumCols;
        if (!c) return;
        clipApplied = clipOn ? c.m : '';
        setNpVars(c);
    }

    const glowCur = { cover: null, player: null };
    const glowSig = { cover: '', player: '' };
    const glowTok = { cover: 0, player: 0 };

    async function setGlow(kind, target) {
        if (!target) {
            if (glowCur[kind]) {
                if (glowCur[kind].isConnected) glowCur[kind].removeAttribute('data-jc-glow');
                glowCur[kind] = null;
                glowSig[kind] = '';
            }
            if (kind === 'cover') ['tl', 'tr', 'bl', 'br', 'm', 'l', 'r'].forEach((k) => document.documentElement.style.removeProperty('--pg-' + k));
            return;
        }
        const { wrapper, imgs } = target;
        const r = wrapper.getBoundingClientRect();
        const reach = kind === 'player' ? playerReach(r) : 0;
        const sig = imgs.map((i) => i.currentSrc || i.src).join('|')
            + '@' + Math.round(r.width) + 'x' + Math.round(r.height)
            + '@' + Math.round(reach / 4);   // o botão de curtir muda de lugar com o tamanho do título
        if (glowCur[kind] === wrapper && glowSig[kind] === sig && wrapper.getAttribute('data-jc-glow') === kind) return;

        const tok = ++glowTok[kind];
        let cols = await glowColors(wrapper, imgs);
        if (!cols && imgs.length === 1) cols = await colorsViaSpotify(imgs[0]);
        if (tok !== glowTok[kind] || !wrapper.isConnected) return;
        if (!cols) {
            // Sem cores da imagem (CORS/CDN): usa a cor do tema em vez de não mostrar nada
            let c = '110, 110, 200';
            try {
                const v = getComputedStyle(document.documentElement).getPropertyValue('--spice-button').trim().replace('#', '');
                if (/^[0-9a-f]{6}$/i.test(v)) c = [0, 2, 4].map((n) => parseInt(v.slice(n, n + 2), 16)).join(', ');
            } catch (e) { /* mantém o padrão */ }
            cols = { tl: c, tr: c, bl: c, br: c, m: c, l: c, r: c };
            console.warn('[jc-glow] não consegui extrair as cores da imagem; usando cor do tema', kind);
        }

        if (glowCur[kind] && glowCur[kind] !== wrapper && glowCur[kind].isConnected) {
            glowCur[kind].removeAttribute('data-jc-glow');
        }
        // As cores da música tocando ficam disponíveis no CSS inteiro (--np-m, --np-tl...),
        // para o anel da faixa atual, a barra de progresso e o botão de play.
        if (kind === 'player') {
            // a luz da capa (embaixo à esquerda) é sempre a cor do álbum
            ['m', 'bl', 'tl'].forEach((k) => setRootVar('--al-' + k, cols[k]));
            albumCols = cols;
            applyNp();
        }
        // Cores da capa da página aberta (--pg-*): o play da página mistura com --np-*
        if (kind === 'cover') {
            Object.keys(cols).forEach((k) => setRootVar('--pg-' + k, cols[k]));
        }
        const size = Math.max(r.width, r.height);
        wrapper.style.setProperty('--g-off', Math.round(size * 0.12) + 'px');
        wrapper.style.setProperty('--g-blur', Math.round(size * 0.45) + 'px');
        wrapper.style.setProperty('--g-wide', Math.round(size * 0.9) + 'px');
        Object.keys(cols).forEach((k) => wrapper.style.setProperty('--gc-' + k, cols[k]));

        if (kind === 'player') {
            // duas manchas largas: uma perto da arte e outra perto do botão de curtir
            wrapper.style.setProperty('--gp-ax', Math.round(reach * 0.30) + 'px');
            wrapper.style.setProperty('--gp-as', Math.round(Math.max(reach * 0.30, 40)) + 'px');
            wrapper.style.setProperty('--gp-bx', Math.round(reach * 0.62) + 'px');
            wrapper.style.setProperty('--gp-bs', Math.round(Math.max(reach * 0.38 - r.width, 40)) + 'px');
            wrapper.style.setProperty('--gp-blur', Math.round(Math.max(r.width * 0.8, 50)) + 'px');
            markClip(wrapper);
            markAbove(wrapper);
        }

        wrapper.setAttribute('data-jc-glow', kind);
        glowCur[kind] = wrapper;
        glowSig[kind] = sig;
    }

    function updateGlow() {
        if (document.hidden) return;
        try {
            setGlow('cover', findCover()).catch(() => {});
            setGlow('player', findPlayerArt()).catch(() => {});
        } catch (e) { /* silencioso: o brilho é enfeite, nunca deve quebrar o app */ }
    }

    // Para depurar: jcDebug() no Console do DevTools devolve o estado interno (cor, painel, boas-vindas...)
    window.jcDebug = () => ({
        caminho: currentPath(), brilhoNaCapa: !!glowCur.cover, brilhoNoPlayer: !!glowCur.player,
        linhaTocando: waveInfo, boasVindas: heroInfo, painelAgora: npvInfo,
        clipe: { on: clipOn, sim: clipYes, nao: clipNo, album: albumCols && albumCols.m, clipe: clipCols && clipCols.m },
    });

    // ---------------------------------------------------------------------
    // Barra de progresso própria + faixa tocando.
    // - grava --jc-progress (0..1) em [data-testid="playback-progressbar"];
    //   o CSS (seção 14) desenha a barra fina em degradê e a bolinha.
    // - marca a linha da faixa tocando (data-jc-playing).
    // ---------------------------------------------------------------------
    const PB_SEL = '[data-testid="playback-progressbar"]';
    const player = () => { try { return Spicetify.Player; } catch (e) { return null; } };

    const progressTick = () => {   // 5x por segundo basta (a barra anda ~3px/s) e não pesa nas letras
        if (document.hidden) return;
        const pl = player();
        if (!pl || typeof pl.getProgressPercent !== 'function') return;
        const el = document.querySelector(PB_SEL);
        if (!el) return;
        let v = pl.getProgressPercent();
        if (!isFinite(v)) return;
        const str = Math.max(0, Math.min(1, v)).toFixed(4);
        if (el.style.getPropertyValue('--jc-progress') !== str) el.style.setProperty('--jc-progress', str);
    };

    const clearPlaying = (row) => {
        row.removeAttribute('data-jc-playing');
        row.querySelectorAll('[data-jc-numcell]').forEach((n) => n.removeAttribute('data-jc-numcell'));
    };

    // Marca a linha da faixa tocando (data-jc-playing) e a célula do número (data-jc-numcell); o CSS
    // faz o anel e troca o equalizador nativo por um ponto colorido.
    let waveInfo = {};
    function updatePlaying() {
        try {
            const pl = player();
            if (!pl) return;
            const playing = typeof pl.isPlaying === 'function' ? pl.isPlaying() : true;
            if (playing) root.removeAttribute('data-jc-paused'); else root.setAttribute('data-jc-paused', '1');

            const item = pl.data && (pl.data.item || pl.data.track);
            const uri = item && item.uri ? String(item.uri) : '';
            const id = uri.startsWith('spotify:track:') ? uri.split(':')[2] : '';
            const name = item && (item.name || (item.metadata && item.metadata.title)) ? String(item.name || item.metadata.title) : '';
            waveInfo = { uri, name, via: null, cells: 0 };

            // linha da faixa: pelo link dela (rápido); plano B: a linha cujo texto tem o nome.
            // (a barra lateral também usa role="row", por isso o #main-view)
            let row = null;
            if (id) {
                const a = document.querySelector('#main-view a[href*="/track/' + id + '"]');
                row = a ? a.closest('[role="row"]') : null;
                if (row) waveInfo.via = 'link';
            }
            if (!row && name) {
                for (const r of document.querySelectorAll('#main-view [role="row"]')) {
                    if (r.getAttribute('aria-rowindex') !== '1' && (r.textContent || '').includes(name)) { row = r; waveInfo.via = 'nome'; break; }
                }
            }
            document.querySelectorAll('#main-view [role="row"][data-jc-playing]').forEach((r) => { if (r !== row) clearPlaying(r); });
            if (!row) return;
            if (row.getAttribute('data-jc-playing') !== '1') row.setAttribute('data-jc-playing', '1');
            let cells = Array.from(row.querySelectorAll('[role="gridcell"]'));
            if (cells.length < 3) cells = Array.from(row.querySelectorAll('[aria-colindex]'));
            if (cells.length < 3) {
                const inner = row.querySelector('[data-testid="tracklist-row"]') || row.firstElementChild;
                cells = inner ? Array.from(inner.children) : [];
            }
            waveInfo.cells = cells.length;
            if (cells.length < 2) return;
            // 1ª célula (#): o CSS troca o equalizador nativo por um ponto colorido
            if (!cells[0].hasAttribute('data-jc-numcell')) cells[0].setAttribute('data-jc-numcell', '');
        } catch (e) { waveInfo = { erro: String(e && e.message || e) }; }
    }

    try {
        Spicetify.Player.addEventListener('songchange', () => { setTimeout(updatePlaying, 300); });
        Spicetify.Player.addEventListener('onplaypause', updatePlaying);
    } catch (e) { /* sem eventos: o intervalo cobre */ }
    every(updatePlaying, 700, 0, 'mut: main bar');
    every(progressTick, 200, 200, true);   // a barra anda sempre: não entra no ritmo lento nem espera a troca de tela

    // ---------------------------------------------------------------------
    // Pequenos ajustes de layout feitos por marcação (o CSS usa os atributos):
    // - data-jc-connect : faixa "Tocando em <dispositivo>" abaixo do player;
    //   o CSS a leva para baixo dos controles de volume, sem bloco novo.
    // - data-jc-sh      : miniaturas da barra lateral ("sq" quadrada, "rd" redonda);
    //   só as quadradas ganham cantos arredondados maiores.
    // ---------------------------------------------------------------------
    function tagLayout() {
        try {
            // página de letras do Spicy (tela cheia no centro): o CSS pinta a barra do player com o mesmo fundo
            const onLyrics = !!document.querySelector('#main-view #SpicyLyricsPage') || /^\/SpicyLyrics/i.test(currentPath() || '');
            if (onLyrics !== root.hasAttribute('data-jc-lyricspage')) {
                if (onLyrics) root.setAttribute('data-jc-lyricspage', ''); else root.removeAttribute('data-jc-lyricspage');
            }
            const bar = document.querySelector('[data-testid="now-playing-bar"]');
            if (bar) {
                Array.from(bar.children).filter((c) => {
                    if (c.classList.contains('main-nowPlayingBar-nowPlayingBar') || c.hasAttribute('data-jc-connect')) return false;
                    const h = c.getBoundingClientRect().height;
                    return h > 0 && h <= 48 && !!(c.textContent || '').trim();
                }).forEach((c) => c.setAttribute('data-jc-connect', '1'));
            }
            // capa do player (embaixo à esquerda): marca o contêiner para o CSS deixar maior
            const pa = findPlayerArt();
            if (pa && pa.wrapper && !pa.wrapper.hasAttribute('data-jc-npart')) {
                document.querySelectorAll('[data-jc-npart]').forEach((n) => n.removeAttribute('data-jc-npart'));
                pa.wrapper.setAttribute('data-jc-npart', '');
            }
            const marks = [];   // lê todas e só depois marca (marcar no meio fazia o navegador refazer o layout a cada capa)
            document.querySelectorAll('#Desktop_LeftSidebar_Id img:not([data-jc-sh])').forEach((img) => {
                const w = img.clientWidth;
                if (!w) return;
                const r = getComputedStyle(img).borderTopLeftRadius || '0px';
                marks.push([img, (r.includes('%') ? parseFloat(r) >= 40 : parseFloat(r) >= w / 2 - 1) ? 'rd' : 'sq']);
            });
            marks.forEach(([img, v]) => img.setAttribute('data-jc-sh', v));
        } catch (e) { /* enfeite */ }
    }
    every(tagLayout, 1500, 0, 'mut: side bar');

    // ---------------------------------------------------------------------
    // Volume em botão giratório (knob). O controle deslizante nativo fica
    // escondido (data-jc-volslider) e o knob entra no lugar dele.
    // Ângulo: -135° (≈7h, mínimo) até +135° (≈5h, máximo), sentido horário.
    // Arraste girando, use a roda do mouse ou as setas do teclado.
    // ---------------------------------------------------------------------
    const getVol = () => { try { const v = Spicetify.Player.getVolume(); return isFinite(v) ? v : null; } catch (e) { return null; } };
    const setVol = (v) => { try { Spicetify.Player.setVolume(Math.max(0, Math.min(1, v))); } catch (e) { /* sem API */ } };
    let knobDrag = null;
    let volBeforeMute = 0.5;
    // ---- motor do volume -------------------------------------------------
    // O valor "de verdade" do player só atualiza depois de uma ida e volta ao
    // Spotify; ler getVolume() a cada giro da roda devolvia números velhos e
    // o botão travava/voltava. Aqui o alvo é local: a roda, o arrasto e o
    // teclado só mexem nele; um laço por quadro suaviza o caminho até o alvo
    // e manda o valor ao player no máximo ~40x por segundo.
    const LINE_PX = 150;   // arrasto reto: 150px de ponta a ponta = 0 a 100%
    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    const volDrv = { t: null, s: null, sent: null, raf: 0, last: 0, sentAt: 0, touch: 0 };
    const volBusy = () => volDrv.raf !== 0 || !!knobDrag || performance.now() - volDrv.touch < 900;
    const volBase = () => (volBusy() && volDrv.t !== null) ? volDrv.t : (getVol() ?? volDrv.t ?? 0.5);
    function volTo(v, ease) {
        const now = performance.now();
        if (!volBusy()) { const g = getVol(); volDrv.s = g !== null ? g : (volDrv.s ?? 0.5); }
        volDrv.t = clamp01(v);
        volDrv.touch = now;
        if (!ease || volDrv.s === null) volDrv.s = volDrv.t;
        paintKnob(volDrv.s);
        if (!volDrv.raf) { volDrv.last = now; volDrv.raf = requestAnimationFrame(volStep); }
    }
    function volStep(ts) {
        volDrv.raf = 0;
        const dt = Math.min(64, Math.max(1, ts - volDrv.last)); volDrv.last = ts;
        const d = volDrv.t - volDrv.s;
        if (Math.abs(d) < 0.0015) volDrv.s = volDrv.t;
        else volDrv.s += d * (1 - Math.exp(-dt / 60));
        paintKnob(volDrv.s);
        const fin = volDrv.s === volDrv.t;
        if (volDrv.sent !== volDrv.s && (ts - volDrv.sentAt >= 24 || volDrv.sentAt === 0)) {
            setVol(volDrv.s); volDrv.sent = volDrv.s; volDrv.sentAt = ts;
        }
        volDrv.touch = performance.now();
        if (!fin || volDrv.sent !== volDrv.s) volDrv.raf = requestAnimationFrame(volStep);
    }
    const KNOB_SVG = '<svg class="jc-knob-icon" viewBox="0 0 16 16" aria-hidden="true">' +
        '<path class="spk" d="M2 6h2.5L8 3v10L4.5 10H2z"/>' +
        '<path class="w1" d="M10.3 6.2a2.6 2.6 0 0 1 0 3.6"/>' +
        '<path class="w2" d="M12.2 4.4a5.2 5.2 0 0 1 0 7.2"/>' +
        '<path class="x" d="M10.5 6l3.5 4M14 6l-3.5 4"/></svg>';
    function mountKnob() {
        try {
            const right = document.querySelector('.main-nowPlayingBar-right');
            if (!right) return;
            let knob = right.querySelector('.jc-knob');
            // já montado e no lugar: só atualiza o desenho
            if (knob && knob.previousElementSibling && knob.previousElementSibling.hasAttribute('data-jc-volslider')) {
                knobEl = knob;
                if (!volBusy()) { const v = getVol(); if (v !== null) paintKnob(v); }
                return;
            }
            const pb = right.querySelector('[data-testid="progress-bar"]');
            if (pb) {
                // sobe até o filho direto do bloco que tem o botão de mudo
                let n = pb;
                while (n.parentElement && n.parentElement !== right && !n.parentElement.querySelector(':scope > button, :scope > div > button')) n = n.parentElement;
                if (!n.hasAttribute('data-jc-volslider')) n.setAttribute('data-jc-volslider', '');
                // botão de mudo nativo: o knob faz o papel dele (clique no centro)
                const par = n.parentElement;
                if (par) {
                    const mute = par.querySelector(':scope > button, :scope > div > button');
                    if (mute && !mute.closest('.jc-knob') && !mute.hasAttribute('data-jc-volmute')) mute.setAttribute('data-jc-volmute', '');
                    // bloco do volume (e embrulhos de um filho só): largura automática, sem vão do lado
                    for (let v = par; v && v !== right; v = v.parentElement) {
                        if (!v.hasAttribute('data-jc-volroot')) v.setAttribute('data-jc-volroot', '');
                        if (v.parentElement && v.parentElement.children.length > 1) break;
                    }
                }
                if (!knob) {
                    knob = document.createElement('div');
                    knob.className = 'jc-knob';
                    knob.tabIndex = 0;
                    knob.setAttribute('role', 'slider');
                    knob.setAttribute('aria-label', 'Volume (gire; clique no centro para mudo)');
                    knob.setAttribute('aria-valuemin', '0');
                    knob.setAttribute('aria-valuemax', '100');
                    knob.innerHTML = '<div class="jc-knob-dial"></div>' + KNOB_SVG + '<span class="jc-knob-tip"></span>';
                    const geo = (e) => {
                        const r = knob.getBoundingClientRect();
                        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
                        return { a: Math.atan2(dx, -dy) * 180 / Math.PI, d: Math.hypot(dx, dy) / (r.width / 2) };
                    };
                    const angleToV = (a, last) => {
                        if (a > 135 || a < -135) return last < 0.5 ? 0 : 1;   // zona morta embaixo
                        return (a + 135) / 270;
                    };
                    knob.addEventListener('pointerdown', (e) => {
                        if (e.button > 0) return;
                        e.preventDefault();
                        knob.focus({ preventScroll: true });
                        knob.setPointerCapture(e.pointerId);
                        const g = geo(e);
                        const kr = knob.getBoundingClientRect();
                        // nada muda ainda: o gesto decide o modo depois de ~4px
                        knobDrag = { mode: null, x: e.clientX, y: e.clientY, x0: 0, v0: 0, a0: g.a, last: volBase(), center: g.d < 0.55,
                                     rx: e.clientX - (kr.left + kr.width / 2), ry: e.clientY - (kr.top + kr.height / 2), moved: false };
                        knob.setAttribute('data-drag', '');
                    });
                    knob.addEventListener('pointermove', (e) => {
                        if (!knobDrag) return;
                        const gm = geo(e);
                        if (!knobDrag.mode) {
                            const dx = e.clientX - knobDrag.x, dy = e.clientY - knobDrag.y;
                            if (Math.hypot(dx, dy) < 4) return;
                            knobDrag.moved = true;
                            // Dois jeitos de mexer:
                            //  - girar (como um botão de verdade): o movimento é "de lado" em relação ao
                            //    centro, ou seja, segue a borda do botão (tangente);
                            //  - linha reta: o movimento vai para dentro/para fora do botão (ex.: apertar no
                            //    lado esquerdo e arrastar para a esquerda) ou começa no centro / embaixo
                            //    (zona morta do giro). Direita sobe, esquerda desce.
                            const rl = Math.hypot(knobDrag.rx, knobDrag.ry) || 1;
                            const tan = Math.abs(knobDrag.rx * dy - knobDrag.ry * dx) / rl;
                            const rad = Math.abs(knobDrag.rx * dx + knobDrag.ry * dy) / rl;
                            const spin = !knobDrag.center && Math.abs(knobDrag.a0) <= 135 && tan >= rad * 0.5;
                            if (spin) knobDrag.mode = 'dial';
                            else { knobDrag.mode = 'line'; knobDrag.x0 = e.clientX; knobDrag.v0 = knobDrag.last; knobDrag.orb = { a: gm.a, acc: 0 }; }
                        }
                        if (knobDrag.mode === 'line') {
                            // se o gesto começou "reto" mas o mouse passou a rodar em volta do botão
                            // (mais de ~60° perto dele), vira giro, sem pular o volume
                            const o = knobDrag.orb;
                            if (gm.d >= 0.5 && gm.d <= 4) {
                                if (o.a !== null) {
                                    let da = gm.a - o.a;
                                    if (da > 180) da -= 360; else if (da < -180) da += 360;
                                    o.acc += da;
                                }
                                o.a = gm.a;
                            } else { o.a = null; o.acc = 0; }
                            if (Math.abs(o.acc) > 60 && Math.abs(gm.a) <= 135) {
                                knobDrag.mode = 'dial';
                                knobDrag.off = knobDrag.last - angleToV(gm.a, knobDrag.last);
                            }
                        }
                        if (knobDrag.mode === 'line') {
                            const v = clamp01(knobDrag.v0 + (e.clientX - knobDrag.x0) / LINE_PX);
                            knobDrag.last = v; volTo(v, false);
                        } else {
                            let v = angleToV(gm.a, knobDrag.last);
                            if (knobDrag.off) { if (Math.abs(gm.a) > 135) return; v = clamp01(v + knobDrag.off); }
                            else if (Math.abs(v - knobDrag.last) > 0.6) return;   // não pula de 0 para 100 cruzando o fundo
                            knobDrag.last = v; volTo(v, false);
                        }
                    });
                    const end = (e) => {
                        const d = knobDrag;
                        knobDrag = null;
                        knob.removeAttribute('data-drag');
                        if (!d || d.moved || e.type !== 'pointerup') return;
                        if (d.center) {   // clique no centro = mudo
                            const cur = volBase();
                            if (cur > 0.001) { volBeforeMute = cur; volTo(0, true); }
                            else volTo(volBeforeMute > 0.01 ? volBeforeMute : 0.5, true);
                        } else volTo(angleToV(d.a0, d.last), true);   // clique na borda = vai para aquele ponto
                    };
                    knob.addEventListener('pointerup', end);
                    knob.addEventListener('pointercancel', end);
                    const flash = () => {
                        knob.setAttribute('data-drag', '');
                        clearTimeout(knob.__flash);
                        knob.__flash = setTimeout(() => { if (!knobDrag) knob.removeAttribute('data-drag'); }, 900);
                    };
                    let wheelAt = 0;
                    knob.addEventListener('wheel', (e) => {
                        e.preventDefault();
                        flash();
                        // normaliza pixel/linha/página; 100px (um "clique" da roda) = 5%
                        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
                        const raw = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? -e.deltaY : e.deltaX) * unit;
                        if (!raw) return;
                        const now = performance.now(), gap = now - wheelAt; wheelAt = now;
                        // roda girada depressa anda mais rápido; touchpad (passos pequenos) não é acelerado
                        const acc = Math.abs(raw) >= 40 ? (gap < 35 ? 2.2 : gap < 90 ? 1.5 : 1) : 1;
                        volTo(volBase() + raw * 0.0005 * acc, true);
                    }, { passive: false });
                    knob.addEventListener('keydown', (e) => {
                        const d = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
                        if (d === undefined) return;
                        e.preventDefault();
                        flash();
                        volTo(volBase() + d, true);
                    });
                    n.insertAdjacentElement('afterend', knob);
                }
            }
            if (knob && !volBusy()) { const v = getVol(); if (v !== null) paintKnob(v); }
        } catch (e) { /* enfeite */ }
    }
    let knobEl = null;
    function paintKnob(v) {
        const knob = (knobEl && knobEl.isConnected) ? knobEl : (knobEl = document.querySelector('.jc-knob'));
        if (!knob) return;
        const s = v.toFixed(3);
        if (knob.style.getPropertyValue('--v') !== s) knob.style.setProperty('--v', s);
        const pct = Math.round(v * 100);
        knob.setAttribute('aria-valuenow', String(pct));
        const lvl = pct === 0 ? '0' : pct < 50 ? '1' : '2';
        if (knob.getAttribute('data-level') !== lvl) knob.setAttribute('data-level', lvl);
        const tip = knob.querySelector('.jc-knob-tip');
        const t = pct === 0 ? 'Mudo' : pct + '%';
        if (tip && tip.textContent !== t) tip.textContent = t;
    }

    // ---------------------------------------------------------------------
    // Sem barra de título (o que a extensão "No Controls" fazia): tira o "..."
    // (menu) e os botões minimizar/maximizar/fechar. A barra é nativa, não
    // existe no DOM: pede ao Spotify para encolher a barra para 1px e esconder
    // os botões. O Spotify refaz isso ao mudar o zoom, fechar o painel da
    // direita ou sair da tela cheia; por isso reaplica de tempos em tempos.
    // F8 liga/desliga. Alt+F4 continua fechando o app.
    // ---------------------------------------------------------------------
    let tbHide = true, tbObjs = null, tbScanAt = 0;
    function tbApply() {
        try {
            root.classList.toggle('jc-notb', tbHide);
            const P = Spicetify.Platform;
            if (!P) return;
            const run = (f) => { try { const r = f(); if (r && r.catch) r.catch(() => { /* sem resposta */ }); } catch (e) { /* API ausente */ } };
            if (!tbObjs || performance.now() - tbScanAt > 30000) {   // quais objetos da plataforma sabem mexer na barra: procuro de vez em quando, não a cada chamada
                tbScanAt = performance.now();
                const seen = new Set();
                const found = [];
                for (const k of Object.keys(P)) {
                    const o = P[k];
                    if (o && typeof o === 'object' && !seen.has(o)) {
                        seen.add(o);
                        if (typeof o.setTitlebarHeight === 'function' || typeof o.setWindowButtonsVisibility === 'function' || (o._updateUiClient && typeof o._updateUiClient === 'object')) found.push(o);
                    }
                }
                tbObjs = found.length ? found : null;
                if (!tbObjs) return;
            }
            for (const o of tbObjs) {
                try {
                    if (typeof o.setTitlebarHeight === 'function') run(() => o.setTitlebarHeight(tbHide ? 1 : 64));
                    if (typeof o.setWindowButtonsVisibility === 'function') run(() => o.setWindowButtonsVisibility(!tbHide));
                    const u = o._updateUiClient;
                    if (u && typeof u === 'object') {
                        if (typeof u.updateTitlebarHeight === 'function') run(() => u.updateTitlebarHeight({ height: tbHide ? 1 : 64 }));
                        if (typeof u.setButtonsVisibility === 'function') run(() => u.setButtonsVisibility({ showButtons: !tbHide }));
                    }
                } catch (e) { /* objeto estranho: segue para o próximo */ }
            }
        } catch (e) { /* enfeite */ }
    }
    // Sem os botões da janela, o Hazy continua reservando 64px na esquerda (para o "...") e 144px na
    // direita (para minimizar/maximizar/fechar). O CSS tira essa reserva; aqui eu meço e acerto o
    // que sobrar: voltar/avançar alinhados com a borda da barra lateral, e a foto de perfil a 22px
    // da borda direita da tela.
    function navAlign() {
        try {
            const put = (name, v) => { const t = (Math.round(v * 10) / 10) + 'px'; if (root.style.getPropertyValue(name) !== t) root.style.setProperty(name, t); };
            const shifted = (el) => { const l = parseFloat(getComputedStyle(el).translate); return isFinite(l) ? l : 0; };   // quanto o CSS já empurrou (translate: "6px 0px" ou "none")
            if (!tbHide) { put('--jc-nav-ldx', 0); put('--jc-nav-rdx', 0); return; }
            const W = root.clientWidth;
            // esquerda: o menor grupo que tem voltar + avançar
            const back = document.querySelector('#global-nav-bar [data-testid="top-bar-back-button"], .main-globalNav-historyButtonsContainer button');
            const fwd = document.querySelector('#global-nav-bar [data-testid="top-bar-forward-button"]');
            if (back) {
                let g = back.closest('.main-globalNav-historyButtonsWrapper') || back.closest('.main-globalNav-historyButtonsContainer');
                if (!g && fwd) { g = back.parentElement; while (g && !g.contains(fwd)) g = g.parentElement; }
                if (g && !g.hasAttribute('data-jc-navl')) g.setAttribute('data-jc-navl', '');
                const r = back.getBoundingClientRect();
                // com o mouse em cima os botões crescem um pouquinho: não meço nesse momento
                if (g && r.width && !g.matches(':hover') && !g.matches(':focus-within')) {
                    const first = document.querySelector('#Desktop_LeftSidebar_Id [data-jc-cd="in"]');
                    const target = first ? first.getBoundingClientRect().left - 8 : 12;   // a dobradiça do estojo fica 8px antes da capa
                    const cur = shifted(g);
                    const dx = target - (r.left - cur);
                    if (Math.abs(dx - cur) > 1.2) put('--jc-nav-ldx', dx);
                }
            }
            // direita: grupo de botões + foto de perfil
            const prof = document.querySelector('#global-nav-bar [data-testid="user-widget-link"]');
            if (prof) {
                const g = prof.closest('.main-globalNav-contentRight') || prof.closest('.main-actionButtons') || prof.parentElement;
                if (g && !g.hasAttribute('data-jc-navr')) g.setAttribute('data-jc-navr', '');
                const r = prof.getBoundingClientRect();
                if (g && r.width && !g.matches(':hover') && !g.matches(':focus-within') && !root.hasAttribute('data-jc-palopen')) {
                    const cur = shifted(g);
                    const dx = (W - 22) - (r.right - cur);   // foto de perfil a 22px da borda direita
                    if (Math.abs(dx - cur) > 1.2) put('--jc-nav-rdx', dx);
                }
            }
        } catch (e) { /* enfeite */ }
    }
    every(navAlign, 3000, 8000, 'mut: nav side');
    window.addEventListener('resize', () => setTimeout(navAlign, 120));
    {
        let tbT = 0;
        const tbSoon = () => { clearTimeout(tbT); tbT = setTimeout(tbApply, 250); };
        tbApply();
        [150, 500, 1200, 2500, 5000, 9000].forEach((ms) => setTimeout(tbApply, ms));
        every(tbApply, 4000, 10000);
        window.addEventListener('resize', tbSoon);
        document.addEventListener('fullscreenchange', tbSoon);
        document.addEventListener('click', tbSoon, true);
        try { Spicetify.Platform.History.listen(tbSoon); } catch (e) { /* sem histórico */ }
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'F8' || e.ctrlKey || e.altKey || e.metaKey) return;
            e.preventDefault();
            tbHide = !tbHide;
            tbApply();
            navAlign();
            try { Spicetify.showNotification && Spicetify.showNotification(tbHide ? 'Barra de título escondida (F8 mostra)' : 'Barra de título visível (F8 esconde)'); } catch (er) { /* sem aviso */ }
        }, true);
    }

    // ---------------------------------------------------------------------
    // Início: cabeçalho de boas-vindas (saudação pela hora, data e a música
    // tocando agora, com capa). Entra antes dos atalhos da página inicial.
    // ---------------------------------------------------------------------
    let heroInfo = null;
    // ---- textos personalizados do cabeçalho de boas-vindas ----
    const HERO_ICONS = {
        heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 0 1 19.4 13Z" fill="currentColor"/></svg>',
        mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c.6 4.3 2.7 6.4 7 7-4.3.6-6.4 2.7-7 7-.6-4.3-2.7-6.4-7-7 4.3-.6 6.4-2.7 7-7Z" fill="currentColor"/></svg>',
        prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 6v12L3 12Z M20 6v12l-8-6Z" fill="currentColor"/></svg>',
        next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 6v12l8-6Z M4 6v12l8-6Z" fill="currentColor"/></svg>',
        play: '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z" fill="currentColor"/></svg>',
        pause: '<svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>',
    };
    const heroPick = (list, seed) => { let h = 0; const t = String(seed || ''); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return list[h % list.length]; };
    function heroTexts(now, it, playing, nm) {
        const h = now.getHours(), wd = now.getDay();
        const per = h < 5 ? 'madrugada' : h < 12 ? 'manhã' : h < 18 ? 'tarde' : 'noite';
        const quem = nm ? ', ' + nm : '';
        let hello;
        if (wd === 5 && h >= 17) hello = 'Sextou' + quem + '!';
        else if (wd === 6 && h >= 10 && h < 19) hello = 'Bom sábado' + quem + '!';
        else if (wd === 0 && h >= 10 && h < 19) hello = 'Bom domingo' + quem + '!';
        else if (h < 5) hello = 'Ainda acordado' + quem + '?';
        else hello = (h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite') + quem + '!';
        const song = it ? (it.name || (it.metadata && it.metadata.title) || '') : '';
        const artist = it ? ((it.artists && it.artists[0] && it.artists[0].name) || (it.metadata && it.metadata.artist_name) || '') : '';
        let sub;
        if (it && playing && artist) {
            sub = heroPick([
                artist + ' para embalar a sua ' + per + '.',
                'Que trilha boa: ' + song + ', de ' + artist + '.',
                'Curtindo ' + artist + '? Tem muito mais de onde veio essa.',
                song + ' no volume certo para a sua ' + per + '.',
                'Sua ' + per + ' está com a cara de ' + artist + '.',
            ], (it.uri || song) + per);
        } else if (it && song) {
            sub = 'Pausado em ' + song + '. Que tal continuar de onde parou?';
        } else {
            sub = { madrugada: 'Uma trilha calma para a madrugada?', 'manhã': 'Que tal começar o dia com uma playlist?', tarde: 'Hora de descobrir algo novo.', noite: 'Algo para relaxar hoje à noite?' }[per];
        }
        const dia = now.toLocaleDateString('pt-BR', { weekday: 'long' });
        const data = now.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
        const hora = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return { date: dia + ' • ' + data + ' • ' + hora, hello, sub, artist, per };
    }
    const fmtTime = (ms) => { const t = Math.max(0, Math.floor((ms || 0) / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
    function heroGo(path) { try { Spicetify.Platform.History.push(path); } catch (e) { /* sem navegação */ } }
    function heroClick(ev) {
        const b = ev.target.closest('[data-act]');
        let it = null;
        try { it = Spicetify.Player.data.item; } catch (e) { /* nada tocando */ }
        if (b) {
            ev.stopPropagation();
            const act = b.getAttribute('data-act');
            try {
                if (act === 'liked') heroGo('/collection/tracks');
                else if (act === 'search') heroGo('/search');
                else if (act === 'artist') {
                    const au = it && ((it.artists && it.artists[0] && it.artists[0].uri) || (it.metadata && it.metadata.artist_uri));
                    if (au) heroGo('/artist/' + String(au).split(':').pop());
                } else if (act === 'prev') Spicetify.Player.back();
                else if (act === 'next') Spicetify.Player.next();
                else if (act === 'play') Spicetify.Player.togglePlay();
            } catch (e) { /* ação indisponível */ }
            return;
        }
        if (ev.target.closest('.jc-hero-np')) {
            const alb = it && (it.album && it.album.uri || it.metadata && it.metadata.album_uri);
            if (alb) heroGo('/album/' + String(alb).split(':').pop());
        }
    }
    function homeHero() {
        try {
            const path = currentPath();
            const isHome = path === '/' || path === '' || /^\/home/i.test(path);
            const old = document.querySelector('#main-view .jc-hero');
            if (!isHome) { if (old) old.remove(); return; }
            const mv = document.querySelector('#main-view');
            if (!mv) return;
            // Lugar: no TOPO da área do meio, antes da faixa de filtros (Tudo, Música,
            // Podcasts...), que fica logo abaixo dele e continua grudando no topo ao rolar.
            let host = null, before = null;
            const homeSec = mv.querySelector('[data-testid="home-page"]');
            const chip = mv.querySelector('.e-10860-legacy-chip, [class*="legacy-chip"], [data-encore-id="chip"]');
            if (chip && homeSec) {
                for (let e = chip; e && e !== mv; e = e.parentElement) {
                    const p = e.parentElement;
                    if (p && p.contains(homeSec) && !e.contains(homeSec)) { host = p; before = e; break; }
                }
            }
            document.querySelectorAll('[data-jc-chipsbar]').forEach((el) => { if (el !== before) el.removeAttribute('data-jc-chipsbar'); });
            if (before && !before.hasAttribute('data-jc-chipsbar')) before.setAttribute('data-jc-chipsbar', '');
            // sem filtros: no começo do conteúdo da página inicial (como antes)
            if (!host) {
                host = mv.querySelector('[data-testid="home-page"] .main-home-content')
                    || mv.querySelector('.main-home-content')
                    || homeSec;
                if (!host) {
                    const sec = mv.querySelector('section[data-testid="component-shelf"], section[aria-label]');
                    host = sec ? sec.parentElement : null;
                }
                before = host ? host.firstChild : null;
            }
            heroInfo = { path, host: host ? (host.className || host.tagName).toString().slice(0, 80) : null, antes: before && before.className ? String(before.className).slice(0, 60) : null };
            if (!host) return;
            let hero = old;
            if (hero && !hero.querySelector('.jc-hero-actions')) { hero.remove(); hero = null; }   // versão antiga
            if (hero && (hero.parentElement !== host || (before && hero.nextElementSibling !== before && hero !== before))) {
                host.insertBefore(hero, before);
            }
            if (!hero) {
                hero = document.createElement('div');
                hero.className = 'jc-hero';
                hero.innerHTML = '<canvas class="jc-hero-bg" width="2" height="2" aria-hidden="true"></canvas>' +
                    '<div class="jc-hero-text">' +
                        '<div class="jc-hero-date"></div><div class="jc-hero-hello"></div><div class="jc-hero-sub"></div>' +
                        '<div class="jc-hero-actions">' +
                            '<button type="button" class="jc-hero-chip" data-act="liked">' + HERO_ICONS.heart + '<span>Músicas Curtidas</span></button>' +
                            '<button type="button" class="jc-hero-chip" data-act="artist">' + HERO_ICONS.mic + '<span class="jc-hero-chip-artist"></span></button>' +
                            '<button type="button" class="jc-hero-chip" data-act="search">' + HERO_ICONS.spark + '<span>Descobrir algo novo</span></button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="jc-hero-np" role="button" tabindex="0" title="Abrir o álbum que está tocando">' +
                        '<img alt="">' +
                        '<div class="jc-hero-np-info">' +
                            '<div class="jc-hero-np-k">Tocando agora</div><div class="jc-hero-np-t"></div><div class="jc-hero-np-a"></div>' +
                            '<div class="jc-hero-np-bar"><i></i></div>' +
                            '<div class="jc-hero-np-time"><span class="c">0:00</span><span class="d">0:00</span></div>' +
                            '<div class="jc-hero-np-ctl">' +
                                '<button type="button" data-act="prev" aria-label="Anterior">' + HERO_ICONS.prev + '</button>' +
                                '<button type="button" data-act="play" class="jc-hero-np-play" aria-label="Tocar ou pausar">' + HERO_ICONS.play + HERO_ICONS.pause + '</button>' +
                                '<button type="button" data-act="next" aria-label="Próxima">' + HERO_ICONS.next + '</button>' +
                            '</div>' +
                        '</div>' +
                        '<div class="jc-hero-np-next"></div>' +
                    '</div>';
                hero.addEventListener('click', heroClick);
                host.insertBefore(hero, before);
            }
            const now = new Date();
            const u = document.querySelector('[data-testid="user-widget-link"]');
            let nm = u ? (u.getAttribute('aria-label') || '').trim().split(/\s+/)[0] : '';
            // só um primeiro nome de verdade (o Spotify usa o id da conta quando não há nome)
            if (!/^\p{L}[\p{L}'’-]{1,19}$/u.test(nm)) nm = '';
            else nm = nm.charAt(0).toUpperCase() + nm.slice(1);
            let it = null, playing = false;
            try { it = Spicetify.Player.data.item; playing = !!Spicetify.Player.isPlaying(); } catch (e) { /* nada tocando */ }
            const tx = heroTexts(now, it, playing, nm);
            const set = (sel, t) => { const el = hero.querySelector(sel); if (el && el.textContent !== t) el.textContent = t; };
            set('.jc-hero-date', tx.date);
            set('.jc-hero-hello', tx.hello);
            set('.jc-hero-sub', tx.sub);
            const chipA = hero.querySelector('[data-act="artist"]');
            if (chipA) chipA.style.display = tx.artist ? '' : 'none';
            set('.jc-hero-chip-artist', tx.artist ? 'Mais de ' + tx.artist : '');
            const np = hero.querySelector('.jc-hero-np');
            if (it) {
                np.style.display = '';
                const md = it.metadata || {};
                set('.jc-hero-np-k', playing ? 'Tocando agora' : 'Pausado');
                set('.jc-hero-np-t', it.name || md.title || '');
                set('.jc-hero-np-a', (it.artists && it.artists.map((x) => x.name).join(', ')) || md.artist_name || '');
                let src = md.image_xlarge_url || md.image_large_url || md.image_url || '';
                if (!src) { const art = findPlayerArt(); src = (art && art.imgs[0] && art.imgs[0].src) || ''; }   // medir a capa só se faltar a URL
                src = src.replace(/^spotify:image:/, 'https://i.scdn.co/image/');
                const img = np.querySelector('img');
                if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
                // a seguir (fila)
                let nx = '';
                try {
                    const q = (Spicetify.Queue && Spicetify.Queue.nextTracks) || [];
                    const n0 = q.find((x) => x && x.contextTrack && x.contextTrack.metadata && x.contextTrack.metadata.title);
                    if (n0) nx = 'A seguir: ' + n0.contextTrack.metadata.title + (n0.contextTrack.metadata.artist_name ? ' · ' + n0.contextTrack.metadata.artist_name : '');
                } catch (e) { nx = ''; }
                set('.jc-hero-np-next', nx);
                hero.querySelector('.jc-hero-np-next').style.display = nx ? '' : 'none';
            } else np.style.display = 'none';
            heroProgress(hero);
        } catch (e) { heroInfo = { erro: String(e && e.message || e) }; }
    }
    // barra de tempo e play/pause do "Tocando agora" (atualizados várias vezes por segundo)
    function heroProgress(hero) {
        try {
            const P = Spicetify.Player;
            const d = P.getDuration ? P.getDuration() : 0, c = P.getProgress ? P.getProgress() : 0;
            const pct = d > 0 ? Math.max(0, Math.min(100, c / d * 100)) : 0;
            const bar = hero.querySelector('.jc-hero-np-bar > i');
            if (bar) bar.style.width = pct.toFixed(2) + '%';
            const tc = hero.querySelector('.jc-hero-np-time .c'), td = hero.querySelector('.jc-hero-np-time .d');
            const a = fmtTime(c), b = fmtTime(d);
            if (tc && tc.textContent !== a) tc.textContent = a;
            if (td && td.textContent !== b) td.textContent = b;
            const pl = !!P.isPlaying();
            if (hero.classList.contains('jc-playing') !== pl) hero.classList.toggle('jc-playing', pl);
            const k = hero.querySelector('.jc-hero-np-k'), kt = pl ? 'Tocando agora' : 'Pausado';
            if (k && k.textContent !== kt) k.textContent = kt;
        } catch (e) { /* sem player */ }
    }
    every(homeHero, 1000, 0, 'live');

    // Fundo animado do painel da direita (o canvas do Spicy no "Tocando agora"): ele aparece também
    // no cabeçalho de boas-vindas, no cabeçalho com foto (artista), atrás da barra do player e
    // serve de leitura para a cor do clipe. Em vez de uma cópia grande para cada um (feita 12x por
    // segundo, com um desfoque de CSS por cima), faço UMA cópia pequena (160 px de largura, na placa
    // de vídeo) ~7x por segundo e pinto todos com ela; o fundo já é um borrão de cores, então
    // esticar a cópia pequena fica igual. Sem o painel aberto: degradê nas cores da música (CSS).
    let npvBgEl = null, npvBgAt = 0;
    function npvBgCanvas() {
        const now = performance.now();
        if (npvBgEl && npvBgEl.isConnected && now - npvBgAt < 600) return npvBgEl;
        npvBgAt = now;
        const pan = document.getElementById('Desktop_PanelContainer_Id');
        if (!pan || !isVis(pan)) return (npvBgEl = null);
        const list = Array.from(pan.querySelectorAll(':scope > canvas.spicy-dynamic-bg'))
            .filter((c) => !c.classList.contains('transition_Out') && !c.classList.contains('is-pending') && c.width > 1 && c.height > 1);
        return (npvBgEl = list[list.length - 1] || null);
    }
    const BG_W = 160, BG_MS = 200;
    let bgBusy = false, bgBusyAt = 0, bgN = 0, bgFilt = '', bgFiltAt = 0, bgClipAt = 0;
    const bgT = { at: 0, lyr: false, hero: null, ban: null, host: null };
    function bgTargets() {   // destinos da cópia, procurados no máximo a cada 0,4 s
        const now = performance.now();
        if (now - bgT.at < 400) return bgT;
        bgT.at = now;
        bgT.lyr = root.hasAttribute('data-jc-lyricspage');
        bgT.hero = bgT.lyr ? null : document.querySelector('#main-view .jc-hero');
        bgT.ban = bgT.lyr ? null : document.querySelector('.Root div[data-testid="background-image"]');
        bgT.host = document.querySelector('.jc-lyrbar');
        return bgT;
    }
    const onScreen = isVis;
    function bgFilter(src) {   // brilho/saturação que o Spicy aplica ao canvas dele, mais uma suavizada leve
        const now = performance.now();
        if (now - bgFiltAt > 5000) {
            bgFiltAt = now;
            const f = getComputedStyle(src).filter;
            bgFilt = (f && f !== 'none' ? f + ' ' : '') + 'blur(1px)';
        }
        return bgFilt;
    }
    // A cópia do fundo do Spicy é tirada só ~5x por segundo (copiar o canvas animado tem custo), mas a tela
    // passa de uma cópia para a seguinte aos poucos (mistura as duas ~30x por segundo, em miniatura): o
    // movimento fica contínuo como o original, sem copiar mais vezes.
    const bgBlendSet = new Set();
    let bgBlendOn = false;
    function bgPaint(cv, bmp, y0, y1, filt) {   // guarda a faixa y0..y1 (frações da altura) da cópia como "próxima" do canvas cv
        const sy = Math.round(bmp.height * y0), sh = Math.max(1, Math.round(bmp.height * (y1 - y0)));
        if (cv.width !== bmp.width || cv.height !== sh) { cv.width = bmp.width; cv.height = sh; cv.__prev = null; }
        const ctx = cv.__ctx || (cv.__ctx = cv.getContext('2d'));
        if (!ctx) return false;
        // a "próxima" vira a "anterior" e a nova cópia entra como "próxima"
        let nx = cv.__prev && cv.__prev.width === bmp.width && cv.__prev.height === sh ? cv.__prev : null;
        if (!nx) { nx = document.createElement('canvas'); nx.width = bmp.width; nx.height = sh; }
        const nctx = nx.getContext('2d');
        nctx.filter = filt;
        nctx.clearRect(0, 0, nx.width, nx.height);
        nctx.drawImage(bmp, 0, sy, bmp.width, sh, 0, 0, bmp.width, sh);
        nctx.filter = 'none';
        const now = performance.now();
        cv.__prev = cv.__next || null;
        cv.__next = nx;
        cv.__ivl = cv.__capT ? Math.max(120, Math.min(700, now - cv.__capT)) : 200;
        cv.__capT = now;
        cv.__done = false;
        if (!cv.__prev) { ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(nx, 0, 0); cv.__done = true; }
        bgBlendSet.add(cv);
        if (!bgBlendOn) { bgBlendOn = true; fxStart('mistura', () => bgBlend(), 0); }
        return true;
    }
    function bgBlend() {
        if (!bgBlendSet.size || lite) { bgBlendOn = false; fxSet('mistura', -1); return; }
        fxSet('mistura', document.hidden || fxPause ? 400 : FX_GRID);
        if (document.hidden || fxPause) return;
        const now = performance.now();
        bgBlendSet.forEach((cv) => {
            if (!cv.isConnected) { bgBlendSet.delete(cv); return; }
            if (cv.__done || !cv.__next) return;
            const t = Math.min(1, (now - cv.__capT) / cv.__ivl);
            const ctx = cv.__ctx;
            ctx.globalAlpha = 1;
            if (cv.__prev && t < 1) ctx.drawImage(cv.__prev, 0, 0);
            ctx.globalAlpha = cv.__prev && t < 1 ? t : 1;
            ctx.drawImage(cv.__next, 0, 0);
            ctx.globalAlpha = 1;
            if (t >= 1) cv.__done = true;
        });
    }
    // devolve true se copiou (a cópia é pedida de novo logo); false se não há o que copiar (volta ao ritmo lento)
    function bgStep() {
        bgN++;
        const T = bgTargets();
        const host = T.host;
        if (T.lyr) return bgLyr(host);
        let hero = null, ban = null;
        if (T.hero && T.hero.isConnected && onScreen(T.hero)) { if (bgN % 4 === 0) heroProgress(T.hero); hero = T.hero; }
        if (T.ban && T.ban.isConnected && onScreen(T.ban)) ban = T.ban;
        const src = npvBgCanvas();
        if (!src) {   // sem painel: tudo volta ao degradê do CSS
            if (T.hero) { const c = T.hero.querySelector(':scope > canvas.jc-hero-bg'); if (c && c.style.opacity !== '0') c.style.opacity = '0'; }
            if (T.ban) { const c = T.ban.querySelector(':scope > canvas.jc-hdr-bg'); if (c) c.classList.remove('jc-on'); }
            if (host && host.hasAttribute('data-jc-npvbg')) host.removeAttribute('data-jc-npvbg');
            if (clipYes || clipOn) { clipYes = 0; clipSetOn(false); }
            return !!hero;
        }
        if (typeof createImageBitmap !== 'function') return false;
        const now = performance.now();
        const wantBar = !!host && (bgN % 2 === 0 || (!hero && !ban));            // a barra do player: metade do ritmo
        const clipDue = !root.hasAttribute('data-jc-palette') && !!albumCols && now - bgClipAt > 1200;
        if (!hero && !ban && !wantBar && !clipDue) return false;
        if (bgBusy && now - bgBusyAt < 2000) return true;
        bgBusy = true; bgBusyAt = now;
        const w = BG_W, h = Math.max(8, Math.round(w * src.height / Math.max(1, src.width)));
        createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' }).then((bmp) => {
            try {
                const f = bgFilter(src);
                if (hero) {
                    let cv = hero.querySelector(':scope > canvas.jc-hero-bg');
                    if (!cv) {
                        cv = document.createElement('canvas');
                        cv.className = 'jc-hero-bg'; cv.width = 2; cv.height = 2; cv.setAttribute('aria-hidden', 'true');
                        hero.insertBefore(cv, hero.firstChild);
                    }
                    if (bgPaint(cv, bmp, 0.25, 0.75, f) && cv.style.opacity !== '1') cv.style.opacity = '1';
                }
                if (ban) {
                    let cv = ban.querySelector(':scope > canvas.jc-hdr-bg');
                    if (!cv) {
                        cv = document.createElement('canvas');
                        cv.className = 'jc-hdr-bg'; cv.width = 2; cv.height = 2; cv.setAttribute('aria-hidden', 'true');
                        ban.appendChild(cv);
                    }
                    if (bgPaint(cv, bmp, 0.25, 0.75, f) && !cv.classList.contains('jc-on')) cv.classList.add('jc-on');
                }
                if (wantBar) {
                    const cv = host.querySelector('.jc-lyrbar-cv');
                    if (cv && bgPaint(cv, bmp, 0.25, 0.75, f) && !host.hasAttribute('data-jc-npvbg')) host.setAttribute('data-jc-npvbg', '');
                }
                if (clipDue) { bgClipAt = now; clipAnalyze(bmp); }
            } finally { bmp.close(); }
        }).catch(() => {
            if (T.hero) { const c = T.hero.querySelector(':scope > canvas.jc-hero-bg'); if (c) c.style.opacity = '0'; }
        }).finally(() => { bgBusy = false; });
        return true;
    }
    // página de letras: a barra do player continua o fundo animado das letras (faixa de baixo do canvas deles)
    function bgLyr(host) {
        if (!host) return false;
        const cv = host.querySelector('.jc-lyrbar-cv');
        const src = lyrSource();
        if (!cv) return false;
        if (!src || src.kind !== 'canvas' || typeof createImageBitmap !== 'function') { if (cv.style.opacity !== '0') cv.style.opacity = '0'; return false; }
        const now = performance.now();
        if (bgBusy && now - bgBusyAt < 2000) return true;
        bgBusy = true; bgBusyAt = now;
        const el = src.el, sw = el.width, sh = el.height, sy = Math.floor(sh * 0.8), shh = Math.max(1, sh - sy);
        createImageBitmap(el, 0, sy, sw, shh, { resizeWidth: BG_W, resizeHeight: Math.max(4, Math.round(BG_W * shh / Math.max(1, sw))), resizeQuality: 'low' }).then((bmp) => {
            try {
                const f = getComputedStyle(el).filter;
                if (bgPaint(cv, bmp, 0, 1, (f && f !== 'none' ? f + ' ' : '') + 'blur(1px)')) cv.style.opacity = '1';
            } finally { bmp.close(); }
        }).catch(() => { cv.style.opacity = '0'; }).finally(() => { bgBusy = false; });
        return true;
    }
    function bgLoop() {
        let wait = 600;
        try { if (!document.hidden && !fxPause && !lite) wait = bgStep() ? BG_MS : 450; } catch (e) { bgBusy = false; }
        setTimeout(bgLoop, document.hidden ? 1000 : wait);
    }
    bgLoop = timed('fundoSpicy', bgLoop);
    bgBlend = timed('suavizacao', bgBlend);
    setTimeout(bgLoop, 600);


    // ---------------------------------------------------------------------
    // Cor do clipe: a cada ~1,2 s leio as cores do fundo animado do painel da direita (a mesma cópia
    // pequena que pinta o cabeçalho de boas-vindas). Se a cor dele é bem diferente da capa (ex.: clipe
    // verde escuro, capa vermelha) por 2 leituras seguidas, os destaques passam a seguir o clipe; volta
    // à capa quando as cores voltam a combinar (3 leituras) ou o painel fecha. Paleta fixa: não mexe.
    // ---------------------------------------------------------------------
    const clipCv = document.createElement('canvas');
    clipCv.width = clipCv.height = 24;
    const clipCtx = clipCv.getContext('2d', { willReadFrequently: true });
    function clipSetOn(on) {
        if (on === clipOn) return;
        clipOn = on;
        if (on) root.setAttribute('data-jc-clipmode', ''); else root.removeAttribute('data-jc-clipmode');
        applyNp();
    }
    function clipAnalyze(bmp) {
        try {
            clipCtx.clearRect(0, 0, 24, 24);
            clipCtx.drawImage(bmp, 0, 0, 24, 24);
            const data = clipCtx.getImageData(0, 0, 24, 24).data;
            const N = 24, q = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
            for (let y = 0; y < N; y++) {
                for (let x = 0; x < N; x++) {
                    const i = (y * N + x) * 4;
                    if (data[i + 3] < 128) continue;
                    const k = (y < N / 2 ? 0 : 2) + (x < N / 2 ? 0 : 1);
                    q[k][0] += data[i]; q[k][1] += data[i + 1]; q[k][2] += data[i + 2]; q[k][3]++;
                }
            }
            const sum = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
            const total = q.reduce(sum, [0, 0, 0, 0]);
            if (!total[3]) return;
            const avg = (a, fb) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : fb);
            const mean = avg(total);
            const fmt = (rgb) => vivid(rgb[0], rgb[1], rgb[2]).join(', ');
            const cols = {
                tl: fmt(avg(q[0], mean)), tr: fmt(avg(q[1], mean)), bl: fmt(avg(q[2], mean)), br: fmt(avg(q[3], mean)),
                m: fmt(mean), l: fmt(avg(sum(q[0], q[2]), mean)), r: fmt(avg(sum(q[1], q[3]), mean)),
            };
            const [hc, sc] = rgbToHsl(mean[0], mean[1], mean[2]);
            const ap = albumCols.m.split(',').map(Number);
            const [ha, sa] = rgbToHsl(ap[0], ap[1], ap[2]);
            let dh = Math.abs(ha - hc); dh = Math.min(dh, 1 - dh) * 360;
            const differs = (sc >= 0.16 && sa >= 0.3 && dh > 55) || (sc < 0.1 && sa > 0.45);
            if (differs) { clipYes++; clipNo = 0; } else { clipNo++; clipYes = 0; }
            clipCols = cols;
            if (!clipOn && clipYes >= 2) clipSetOn(true);
            else if (clipOn && clipNo >= 3) clipSetOn(false);
            else if (clipOn) {
                // acompanha o clipe, mas só mexe nas variáveis quando a cor muda de verdade
                const a = clipApplied.split(',').map(Number), b = cols.m.split(',').map(Number);
                const nowC = performance.now();
                if ((a.length < 3 || Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 45) && nowC - clipNpAt > 8000) { clipNpAt = nowC; applyNp(); }
            }
        } catch (e) { /* sem leitura: fica a cor da capa */ }
    }

    // Capas dos cartões (álbuns, playlists...) com cara de caixinha de CD: marco o
    // quadro da imagem (data-jc-cd); o CSS desenha a dobradiça e o reflexo.
    // Fotos redondas (artistas) ficam de fora.
    function cdStruct(card, mv) {   // estrutura do cartão: calculada uma vez e guardada nele
        let w = card.querySelector('.NMt6sLFwXdQoCRD6zzVJ, .main-cardImage-imageWrapper, [data-encore-id="cardImage"]');
        const img = card.querySelector('img');
        if (w && w.tagName === 'IMG') w = w.parentElement;
        if (!w && img && img.parentElement) w = img.parentElement.parentElement;
        if (!w || w === card) return null;
        // cartões grandes: com o mouse em cima a capa vai um pouco para o lado e um disco de vinil sai
        // de trás dela (data-jc-disc). A caixa que se mexe leva junto o botão de play.
        let box = w;
        const btn = card.querySelector('button[data-encore-id="buttonPrimary"]');
        if (btn && !w.contains(btn)) {
            let x = w;
            while (x.parentElement && x.parentElement !== card && !x.parentElement.contains(btn)) x = x.parentElement;
            const c = x.parentElement;
            // a caixa da capa + play não tem texto (o nome do álbum fica fora dela): decide sem medir
            if (c && c !== card && c.contains(btn) && !(c.textContent || '').trim()) box = c;
        }
        // do cartão até o item da grade (o último que tem só esse cartão dentro): data-jc-lift libera o
        // disco para sair da borda e levanta o item sob o mouse por cima dos vizinhos
        let top = card;
        for (let x = card; x && x !== mv; x = x.parentElement) {
            top = x;
            const par = x.parentElement;
            if (!par || par === mv || par.querySelectorAll('[data-encore-id="card"]').length > 1) break;
        }
        const chain = [];
        for (let x = card; x; x = x.parentElement) { chain.push(x); if (x === top) break; }
        return { w, img, box, top, chain, src: null, round: false };
    }
    const ROUND_CLS = '.gyHofA9F4_gDYkeEmIwO, .main-cardImage-circular';
    const roundRad = (el) => !!el && /50%|9999/.test(getComputedStyle(el).borderTopLeftRadius);
    // artista e perfil têm capa redonda: decide pelo link (sem ler estilo); só se não houver link lê o estilo
    const roundOf = (el, img) => {
        const a = el.closest('a[href]') || el.querySelector('a[href]');
        const h = a ? a.getAttribute('href') || '' : '';
        if (/\/(artist|user)\//.test(h)) return true;
        if (h) return !!((img && img.matches(ROUND_CLS)) || el.matches(ROUND_CLS));
        return roundRad(img || el);
    };
    function tagCdCases() {
        try {
            if (root.hasAttribute('data-jc-lyricspage')) return;
            const W = [];   // escritas, aplicadas todas no fim: [elemento, atributo, valor ou null]
            const want = (el, at, v) => { const cur = el.getAttribute(at); if (v === null ? cur !== null : cur !== v) W.push([el, at, v]); };
            const mv = document.querySelector('#main-view');
            if (mv) {
                // 1) leituras, só de cartões novos ou que trocaram de imagem (a lista reaproveita cartões ao rolar)
                const rows = [];
                mv.querySelectorAll('[data-encore-id="card"]').forEach((card) => {
                    let S = card.__jcS;
                    if (!S || !S.w.isConnected || !card.contains(S.w) || !card.contains(S.box)) { S = card.__jcS = cdStruct(card, mv); if (!S) return; }
                    const src = S.img ? (S.img.getAttribute('src') || '') : '';
                    if (S.src === src && S.done) return;
                    S.src = src;
                    S.round = S.w.matches(ROUND_CLS) || (S.img && S.img.matches(ROUND_CLS)) || roundOf(card, S.img);
                    rows.push([card, S]);
                });
                mv.querySelectorAll('[data-encore-id="card"]').forEach((card) => { const S = card.__jcS; if (S && !S.round && S.top.parentElement) { sizeOf(S.top); sizeOf(S.top.parentElement); } });
                const sc = [];
                mv.querySelectorAll('.view-homeShortcutsGrid-shortcut img:not([src*="equaliser"])').forEach((img) => {
                    const box = img.closest('.view-homeShortcutsGrid-imageWrapper') || img.parentElement;
                    if (!box || box.getAttribute('data-jc-cd') === 'in') return;
                    const src = img.getAttribute('src') || '';
                    if (img.__jcRd === undefined || img.__jcRdSrc !== src) { img.__jcRdSrc = src; img.__jcRd = roundOf(img.closest('.view-homeShortcutsGrid-shortcut') || img, img); }
                    if (!img.__jcRd) sc.push(box);
                });
                // 2) escritas
                rows.forEach(([card, S]) => {
                    const old = card.__jcDisc;
                    if (old && old !== S.box) { want(old, 'data-jc-disc', null); want(old, 'data-jc-flip', null); }
                    card.__jcDisc = S.box;
                    want(S.w, 'data-jc-cd', null);   // sem estojo de CD nos cartões
                    (card.__jcLift || []).forEach((el) => { if (S.chain.indexOf(el) < 0) want(el, 'data-jc-lift', null); });
                    card.__jcLift = S.chain;
                    if (S.round) {
                        want(S.box, 'data-jc-disc', null); want(S.box, 'data-jc-flip', null);
                        S.chain.forEach((el) => want(el, 'data-jc-lift', null));
                    } else {
                        want(S.box, 'data-jc-disc', '');
                        S.chain.forEach((el) => want(el, 'data-jc-lift', ''));
                    }
                    S.done = true;
                });
                sc.forEach((box) => want(box, 'data-jc-cd', 'in'));
            }
            // barra lateral: só as miniaturas quadradas (álbuns e playlists)
            document.querySelectorAll('#Desktop_LeftSidebar_Id img[data-jc-sh]').forEach((img) => {
                const box = img.parentElement;
                if (box) want(box, 'data-jc-cd', img.getAttribute('data-jc-sh') === 'sq' ? 'in' : null);
            });
            W.forEach(([el, at, v]) => { if (v === null) el.removeAttribute(at); else el.setAttribute(at, v); });
        } catch (e) { /* enfeite */ }
    }
    // o disco sai pela esquerda no último cartão da fileira (não há espaço à direita): decidido só
    // quando o mouse entra no cartão, medindo aquele cartão (antes eram todos, toda hora)
    let flipCard = null;
    document.addEventListener('pointerover', (e) => {
        const card = e.target && e.target.closest ? e.target.closest('#main-view [data-encore-id="card"]') : null;
        if (card === flipCard) return;
        flipCard = card;
        const S = card && card.__jcS;
        if (!S || S.round || !S.top.parentElement) return;
        try {
            // é o último da fileira? (pela largura da grade e do item, que o ResizeObserver já sabe)
            const cont = S.top.parentElement, cw = sizeOf(cont), iw = sizeOf(S.top);
            if (!cw || !iw || !iw.w) return;
            const cols = Math.max(1, Math.floor((cw.w + 20) / (iw.w + 20)));
            const idx = Array.prototype.indexOf.call(cont.children, S.top);
            const flip = cols > 1 && idx >= 0 && idx % cols === cols - 1;
            if (flip !== S.box.hasAttribute('data-jc-flip')) { if (flip) S.box.setAttribute('data-jc-flip', ''); else S.box.removeAttribute('data-jc-flip'); }
        } catch (er) { /* enfeite */ }
    }, { passive: true, capture: true });
    every(tagCdCases, 2000, 6000, 'mut: main side mainimg');

    // Botão de play dos atalhos do Início: marco o BOTÃO (data-jc-scplay) e o CSS faz dele
    // a bolinha pérola; antes o estilo pegava dois elementos (um círculo dentro do outro).
    // Pílula da página (aleatório, curtir, baixar): o que estiver ligado ganha data-jc-on
    // (o CSS mostra o círculo claro e esconde o pontinho que ficava para fora da pílula).
    function tagButtons() {
        try {
            document.querySelectorAll('#main-view .view-homeShortcutsGrid-shortcut').forEach((t) => {
                const b = t.querySelector('.view-homeShortcutsGrid-PlayButtonContainer button, button[data-encore-id="buttonPrimary"], button.view-homeShortcutsGrid-playButton');
                if (b && !b.hasAttribute('data-jc-scplay')) b.setAttribute('data-jc-scplay', '');
            });
            document.querySelectorAll('#main-view [data-testid="action-bar-row-actions"] button').forEach((b) => {
                if (b.matches('[data-testid="watch-feed-entity-button"]')) return;
                const on = isOnBtn(b);
                if (on !== b.hasAttribute('data-jc-on')) { if (on) b.setAttribute('data-jc-on', ''); else b.removeAttribute('data-jc-on'); }
            });
        } catch (e) { /* enfeite */ }
    }
    every(tagButtons, 1500, 0, 'mut: main');
    // clicou num botão da barra de ações (aleatório, curtir...): atualiza o "ligado" logo
    document.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('#main-view [data-testid="action-bar-row-actions"]')) { setTimeout(tagButtons, 80); setTimeout(tagButtons, 450); }
    }, true);
    document.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('#main-view [data-testid="action-bar-row-actions"]')) [60, 250, 600].forEach((ms) => setTimeout(tagButtons, ms));
    }, true);

    // ---------------------------------------------------------------------
    // Onda sonora no lugar do "equalizador" do Spotify (aquele ícone que mexe na
    // playlist/faixa tocando). Barras finas e arredondadas com o degradê da barra de
    // tempo (branco -> cor viva) e o mesmo brilho, movidas pela própria música: o
    // volume e as notas de cada trecho da análise de áudio do Spotify, com um toque
    // a cada batida. Pausado, a onda descansa numa linha. Nos atalhos do Início ela
    // fica larga; nas listas, do tamanho do ícone original.
    // ---------------------------------------------------------------------
    const eqData = new Map();                 // uri -> { segs, beats } | 'carregando' | null
    function eqLoad(uri) {
        if (!uri || eqData.has(uri) || !/^spotify:(track|episode):/.test(uri)) return;
        eqData.set(uri, 'carregando');
        if (eqData.size > 24) eqData.delete(eqData.keys().next().value);
        const id = uri.split(':')[2];
        // duas fontes: a função do Spicetify e, se ela falhar, o mesmo endereço interno direto
        const viaCosmos = () => Spicetify.CosmosAsync.get('https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/' + id + '?format=json');
        let p;
        try {
            p = (typeof Spicetify.getAudioData === 'function') ? Promise.resolve(Spicetify.getAudioData(uri)).catch(() => viaCosmos()) : viaCosmos();
        } catch (e) { p = Promise.reject(e); }
        Promise.resolve(p).then((a) => {
            if (!a || !Array.isArray(a.segments) || !a.segments.length) throw new Error('sem análise');
            eqData.set(uri, { segs: a.segments, beats: Array.isArray(a.beats) ? a.beats : [] });
        }).catch(() => eqData.set(uri, null));
    }
    const eqFind = (arr, t, key) => {          // último item com start <= t
        let lo = 0, hi = arr.length - 1, r = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m][key] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
        return r;
    };
    // nível da música agora: volume (0..1), as 12 notas e o pulso da batida
    function eqLevels(t) {
        let uri = '';
        try { uri = Spicetify.Player.data.item.uri; } catch (e) { /* nada tocando */ }
        eqLoad(uri);
        const d = eqData.get(uri);
        if (!d || d === 'carregando') return null;
        const i = eqFind(d.segs, t, 'start');
        if (i < 0) return null;
        const s = d.segs[i], n = d.segs[i + 1];
        const lt = t - s.start, lmt = Math.max(0.001, s.loudness_max_time || 0);
        const L = lt < lmt
            ? s.loudness_start + (s.loudness_max - s.loudness_start) * (lt / lmt)
            : s.loudness_max + ((n ? n.loudness_start : s.loudness_max) - s.loudness_max) * Math.min(1, (lt - lmt) / Math.max(0.001, s.duration - lmt));
        const vol = Math.pow(Math.max(0, Math.min(1, (L + 42) / 38)), 1.25);
        let pulse = 0, beatPos = NaN;
        const bi = eqFind(d.beats, t, 'start');
        if (bi >= 0) {
            const b = d.beats[bi];
            pulse = Math.exp(-(t - b.start) * 9) * (b.confidence > 0.2 ? 1 : 0.5);
            beatPos = bi + Math.max(0, Math.min(1, (t - b.start) / Math.max(0.05, b.duration || 0.5)));   // 7.25 = 1/4 depois da 8ª batida
        }
        return { vol, pitches: s.pitches || [], pulse, beatPos };
    }
    function eqScan() {
        try {
            document.querySelectorAll('.Root img[src*="equaliser"]').forEach((img) => {
                let cv = img.nextElementSibling;
                if (!cv || !cv.classList || !cv.classList.contains('jc-eq')) {
                    const wide = !!img.closest('.view-homeShortcutsGrid-playingEqualizer, .view-homeShortcutsGrid-shortcut');
                    cv = document.createElement('canvas');
                    cv.className = 'jc-eq' + (wide ? ' jc-eq-wide' : '');
                    cv.setAttribute('aria-hidden', 'true');
                    if (!wide) {
                        const sz = parseFloat(img.getAttribute('width')) || img.clientWidth || 14;
                        cv.style.width = sz + 'px'; cv.style.height = sz + 'px';
                    }
                    cv.__bars = null;
                    img.after(cv);
                    if (wide && img.parentElement) img.parentElement.setAttribute('data-jc-eqbox', '');
                }
                if (!img.hasAttribute('data-jc-eqimg')) img.setAttribute('data-jc-eqimg', '');
            });
            // ondas órfãs (o Spotify trocou ou tirou o ícone)
            document.querySelectorAll('.Root canvas.jc-eq').forEach((cv) => {
                const prev = cv.previousElementSibling;
                if (!prev || prev.tagName !== 'IMG' || !/equaliser/.test(prev.getAttribute('src') || '')) cv.remove();
            });
            eqList = Array.from(document.querySelectorAll('.Root canvas.jc-eq'));
            if (eqList.length && !eqRunning) { eqRunning = true; fxStart('ondas', eqFrameT, 0); }
        } catch (e) { /* enfeite */ }
    }
    // ~30 quadros por segundo tocando; parado e já em repouso, só confere de vez em quando
    let eqFrameTimed = null;
    let eqRunning = false, eqColor = '255, 255, 255', eqColorAt = 0, eqList = [], eqIdle = false;
    function eqFrameT() { return eqFrameTimed(); }
    function eqFrame() {
        const list = eqList.filter((c) => c.isConnected);
        if (!list.length) { eqRunning = false; fxSet('ondas', -1); return; }
        if (fxPause || lite) { fxSet('ondas', 400); return; }
        const ts = performance.now();
        let playing = false, t = 0;
        try { playing = !!Spicetify.Player.isPlaying(); t = (Spicetify.Player.getProgress() || 0) / 1000 + 0.06; } catch (e) { /* parado */ }
        fxSet('ondas', document.hidden ? 500 : playing ? FX_GRID : eqIdle ? 240 : 80);
        if (document.hidden || (!playing && eqIdle)) return;
        try {
            eqColor = pcv();
            const lv = playing ? eqLevels(t) : null;
            let still = !playing;
            const dpr = window.devicePixelRatio || 1;
            const now = ts / 1000;
            list.forEach((cv) => {
                const r = sizeOf(cv);
                if (!r || !r.w || !r.h || !isVis(cv)) return;
                r.width = r.w; r.height = r.h;
                const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
                if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
                const wide = cv.classList.contains('jc-eq-wide');
                if (wide) { eqWave(cv, W, H, r.width, r.height, dpr, now, playing, lv); if (playing) still = false; return; }
                const N = 4;
                if (!cv.__bars || cv.__bars.length !== N) cv.__bars = new Array(N).fill(0.08);
                const bars = cv.__bars;
                for (let j = 0; j < N; j++) {
                    let target = 0.08;
                    if (playing) {
                        const x = N > 1 ? j / (N - 1) : 0.5;
                        const env = wide ? (0.35 + 0.65 * Math.sin(Math.PI * (0.08 + 0.84 * x))) : 1;
                        const wave = (0.5 + 0.5 * Math.sin(j * 1.15 - now * 6.4)) * (0.55 + 0.45 * Math.sin(j * 0.43 + now * 2.7));
                        if (lv) {
                            // cada barra pega uma nota (as 12 da análise) e o volume do trecho
                            const pk = ((j * 5) % 12) + (x * 0.999), p0 = Math.floor(pk) % 12, p1 = (p0 + 1) % 12, f = pk - Math.floor(pk);
                            const pitch = (lv.pitches[p0] || 0) * (1 - f) + (lv.pitches[p1] || 0) * f;
                            const mix = 0.62 * pitch + 0.38 * wave;
                            target = lv.vol * env * (0.06 + 1.15 * Math.pow(mix, 1.8)) + lv.pulse * 0.3 * env;
                        } else {
                            target = env * (0.08 + 0.95 * Math.pow(wave, 1.6));
                        }
                        target = Math.max(0.07, Math.min(1, target));
                    }
                    bars[j] += (target - bars[j]) * (target > bars[j] ? 0.5 : 0.16);
                    if (Math.abs(bars[j] - 0.08) > 0.004) still = false;
                }
                const ctx = cv.getContext('2d');
                ctx.clearRect(0, 0, W, H);
                const gap = W / N, bw = Math.max(1.5 * dpr, Math.min(gap * 0.55, (wide ? 2.1 : 2.8) * dpr));
                const g = ctx.createLinearGradient(0, 0, W, 0);
                g.addColorStop(0, '#fff');
                g.addColorStop(wide ? 0.32 : 0.15, 'rgb(' + eqColor + ')');
                g.addColorStop(1, 'rgb(' + eqColor + ')');
                ctx.strokeStyle = g;
                ctx.lineWidth = bw;
                ctx.lineCap = 'round';
                ctx.beginPath();
                const mid = H / 2, maxH = H - bw - 1;
                for (let j = 0; j < N; j++) {
                    const x = gap * (j + 0.5);
                    const h = Math.max(0, bars[j] * maxH - 0.01);
                    ctx.moveTo(x, mid - h / 2);
                    ctx.lineTo(x, mid + h / 2 + 0.01);
                }
                ctx.stroke();
            });
            eqIdle = still;
        } catch (e) { /* enfeite */ }
    }
    // atalhos do Início: em vez de barrinhas, a mesma onda de luz da barra lateral (aura), deitada:
    // uma linha que balança com o volume e as notas da música, com brilho em camadas na cor viva dela
    function eqWave(cv, W, H, cw, ch, dpr, now, playing, lv) {
        const volT = playing ? (lv ? lv.vol : 0.5 + 0.25 * Math.sin(now * 1.9)) : 0;
        cv.__amp = (cv.__amp || 0) + (volT - (cv.__amp || 0)) * 0.2;
        const pT = lv ? lv.pulse : 0;
        cv.__pul = (cv.__pul || 0) + (pT - (cv.__pul || 0)) * (pT > (cv.__pul || 0) ? 0.6 : 0.15);
        const amp = cv.__amp, pul = cv.__pul;
        const A = playing ? 1.5 + amp * 6.5 + pul * 2.5 : 0.9 + Math.sin(now * 1.1) * 0.35;   // altura da onda (px)
        const pad = 6, mid = ch / 2, x0 = pad, x1 = cw - pad;
        const pts = [];
        for (let x = x0; x <= x1 + 0.01; x += 2.5) {
            const u = (x - x0) / Math.max(1, x1 - x0);
            const env = Math.min(1, (x - x0) / 22) * Math.min(1, (x1 - x) / 22);
            let pitch = 0.5 + 0.5 * Math.sin(u * 7.3 + now * 1.4);
            if (lv && lv.pitches && lv.pitches.length) {
                const pk = (u * 11 + now * 0.7) % 12, p0 = Math.floor(pk) % 12, p1 = (p0 + 1) % 12, f = pk - Math.floor(pk);
                pitch = (lv.pitches[p0] || 0) * (1 - f) + (lv.pitches[p1] || 0) * f;
            }
            const ph = lv && isFinite(lv.beatPos) ? lv.beatPos * Math.PI : now * 3.2;   // anda meia onda por batida
            const wave = Math.sin(x * 0.11 - ph) * 0.62 + Math.sin(x * 0.05 + ph * 0.5 + 1.3) * 0.38;
            pts.push([x, mid + wave * A * (0.4 + 0.95 * pitch) * env]);
        }
        const path = (c) => {
            c.beginPath();
            c.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length - 1; i++) c.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
            c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        };
        const grad = (c, c0, c1, c2, c3, a) => {
            const g = c.createLinearGradient(x0, 0, x1, 0);
            g.addColorStop(0, c0); g.addColorStop(0.12, c1); g.addColorStop(a, c2); g.addColorStop(1, c3);
            return g;
        };
        const col = eqColor, k = playing ? 1 : 0.6, boost = 1 + pul * 0.7;
        const ctx = cv.__ctx || (cv.__ctx = cv.getContext('2d'));
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        // brilho em camadas (como a aura), em escala pequena
        const gH = grad(ctx, 'rgba(' + col + ', 0)', 'rgba(' + col + ', 0.85)', 'rgba(' + col + ', 1)', 'rgba(' + col + ', 0)', 0.55);
        [[5, 10, 0.34], [2.5, 5, 0.42], [1.2, 2.4, 0.40]].forEach(([b, w, a]) => {
            ctx.filter = 'blur(' + b + 'px)';
            ctx.globalAlpha = Math.min(1, a * k * boost);
            ctx.strokeStyle = gH; ctx.lineWidth = w;
            path(ctx); ctx.stroke();
        });
        ctx.filter = 'none';
        // linha de luz: cor viva com um fio branco por cima
        ctx.globalAlpha = 0.7 * k;
        ctx.strokeStyle = grad(ctx, 'rgba(' + col + ', 0)', 'rgba(' + col + ', 0.85)', 'rgba(' + col + ', 1)', 'rgba(' + col + ', 0)', 0.55);
        ctx.lineWidth = 1.8;
        path(ctx); ctx.stroke();
        ctx.globalAlpha = 0.45 * k;
        ctx.strokeStyle = grad(ctx, 'rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.95)', 'rgba(255, 255, 255, 0.85)', 'rgba(255, 255, 255, 0)', 0.5);
        ctx.lineWidth = 0.8;
        path(ctx); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
    }
    eqFrameTimed = timed('ondas', eqFrame);
    every(eqScan, 1000, 0, 'mut: main side');

    // ---- barra de tempo em onda -------------------------------------------------------------------
    // Quando a onda dos atalhos do Início não está na tela (a música tocando não é um deles, ou você está
    // em outra página), ela "desce" para a barra de tempo do player: a barra vira a mesma onda de luz, de
    // ponta a ponta desde o começo da música, e o tempo é a cor: o trecho já tocado fica na cor viva (com
    // brilho) e o que falta fica branco claro. Clicar/arrastar continua funcionando (a barra do Spotify
    // segue lá, invisível, por baixo).
    let pwOn = null;
    function pwMount() {
        const el = document.querySelector(PB_SEL);
        if (!el) return;
        let cv = el.querySelector(':scope > canvas.jc-pwave');
        if (!cv) {
            cv = document.createElement('canvas');
            cv.className = 'jc-pwave';
            cv.setAttribute('aria-hidden', 'true');
            el.appendChild(cv);
        }
        fxStart('tempo', () => pwFrame(), 0);
    }
    every(pwMount, 2000, 0, 'mut: bar');
    function pwFrame() {
        const el = document.querySelector(PB_SEL);
        const cv = el && el.querySelector(':scope > canvas.jc-pwave');
        if (!cv) { fxSet('tempo', -1); return; }
        let playing = false, t = 0, pct = 0;
        try { const P = Spicetify.Player; playing = !!P.isPlaying(); t = (P.getProgress() || 0) / 1000 + 0.06; pct = P.getProgressPercent(); } catch (e) { /* sem player */ }
        if (!isFinite(pct)) pct = 0;
        const cut = eqList.some((c) => c.isConnected && c.classList.contains('jc-eq-wide') && isVis(c));
        const on = !cut && !lite;
        if (on !== pwOn) { pwOn = on; if (on) root.setAttribute('data-jc-pwave', ''); else root.removeAttribute('data-jc-pwave'); }
        fxSet('tempo', document.hidden || fxPause ? 500 : on ? (playing ? FX_GRID : 200) : 400);
        if (!on || document.hidden || fxPause) return;
        const z = sizeOf(cv);
        if (!z || !z.w || !z.h) return;
        const dpr = window.devicePixelRatio || 1, cw = z.w, ch = z.h;
        const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
        const now = performance.now() / 1000;
        const lv = playing ? eqLevels(t) : null;
        // na barra de tempo a onda segue as BATIDAS: a cada batida ela "pula" (sobe de uma vez e desce
        // devagar até a próxima) e o brilho acende junto; entre as batidas fica calma (sem a variação das
        // notas, que fazia tremer). O deslocamento também é preso à batida: meia onda por batida.
        const volT = playing ? (lv ? lv.vol : 0.5) : 0;
        cv.__amp = (cv.__amp || 0) + (volT - (cv.__amp || 0)) * 0.08;
        let beat = 0;
        if (playing && lv && isFinite(lv.beatPos)) {
            const fr = lv.beatPos - Math.floor(lv.beatPos);   // 0 na batida -> 1 logo antes da próxima
            beat = Math.pow(1 - fr, 2.2);                       // pico na batida, cai suave
        }
        cv.__pul = (cv.__pul || 0) + (beat - (cv.__pul || 0)) * (beat > (cv.__pul || 0) ? 0.85 : 0.3);
        const A = playing ? 0.7 + cv.__amp * 2.2 + cv.__pul * (2.5 + cv.__amp * 4) : 0.6 + Math.sin(now * 1.1) * 0.25;
        const ph = playing && lv && isFinite(lv.beatPos) ? lv.beatPos * Math.PI : now * 1.6;
        const pad = 4, mid = ch / 2, x0 = pad, x1 = cw - pad;
        const px = x0 + Math.max(0, Math.min(1, pct)) * (x1 - x0);   // até onde já tocou
        const pts = [];
        for (let x = x0; x <= x1 + 0.01; x += 3) {
            const u = (x - x0) / Math.max(1, x1 - x0);
            const env = Math.min(1, (x - x0) / 14) * Math.min(1, (x1 - x) / 14);
            const wave = Math.sin(x * 0.05 - ph) * 0.7 + Math.sin(x * 0.021 + ph * 0.5 + 1.3) * 0.3;
            pts.push([x, mid + wave * A * env]);
        }
        const path = (c) => {
            c.beginPath();
            c.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length - 1; i++) c.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
            c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        };
        const col = pcv(), k = playing ? 1 : 0.7, boost = 1 + cv.__pul * 1.1;
        // brilho (só no trecho já tocado): numa tela pequena com desfoque, refeito um quadro sim, outro não
        const HK = 0.35;
        let halo = cv.__halo;
        cv.__hn = (cv.__hn || 0) + 1;
        const hw = Math.max(8, Math.round(cw * HK)), hh = Math.max(4, Math.round(ch * HK));
        if (!halo) halo = cv.__halo = document.createElement('canvas');
        const hre = halo.width !== hw || halo.height !== hh;
        if (hre) { halo.width = hw; halo.height = hh; }
        if (hre || cv.__hn % 2 === 0 || cv.__pul > 0.05) {
            const hx = halo.getContext('2d');
            hx.setTransform(1, 0, 0, 1, 0, 0);
            hx.clearRect(0, 0, hw, hh);
            hx.setTransform(HK, 0, 0, HK, 0, 0);
            hx.save(); hx.beginPath(); hx.rect(0, 0, px + 3, ch); hx.clip();
            hx.globalCompositeOperation = 'lighter';
            hx.lineCap = 'round'; hx.lineJoin = 'round';
            hx.strokeStyle = 'rgb(' + col + ')';
            [[5, 8, 0.32], [2.2, 4, 0.5]].forEach(([b, w, a]) => {
                hx.filter = 'blur(' + (b * HK) + 'px)';
                hx.globalAlpha = Math.min(1, a * k * boost);
                hx.lineWidth = w;
                path(hx); hx.stroke();
            });
            hx.restore();
            hx.filter = 'none'; hx.globalAlpha = 1;
        }
        const ctx = cv.__ctx || (cv.__ctx = cv.getContext('2d'));
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'lighter';
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(halo, 0, 0, hw, hh, 0, 0, W, H);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        // o que falta tocar: fio branco discreto
        ctx.save(); ctx.beginPath(); ctx.rect(px, 0, cw - px, ch); ctx.clip();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.38;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        path(ctx); ctx.stroke();
        ctx.restore();
        // o que já tocou: branco -> cor viva, com um fio branco por cima (como a onda da barra lateral)
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, px, ch); ctx.clip();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createLinearGradient(x0, 0, Math.max(x0 + 40, px), 0);
        g.addColorStop(0, 'rgba(255, 255, 255, .9)'); g.addColorStop(0.35, 'rgb(' + col + ')'); g.addColorStop(1, 'rgb(' + col + ')');
        ctx.globalAlpha = 0.9 * k;
        ctx.strokeStyle = g; ctx.lineWidth = 2.2;
        path(ctx); ctx.stroke();
        ctx.globalAlpha = 0.45 * k;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.8;
        path(ctx); ctx.stroke();
        ctx.restore();
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }

    // ---------------------------------------------------------------------
    // Aura sonora da barra lateral: uma linha de luz vertical ATRÁS das capas, que balança como
    // uma onda (volume e notas da análise de áudio do Spotify, mais um pulso a cada batida), com
    // brilho em camadas (aura) na cor viva da música. Pausada, fica uma linha calma que "respira".
    // Barra lateral aberta (larga) ou sem capas: não aparece. O canvas fica atrás do conteúdo.
    // ---------------------------------------------------------------------
    let auraAmp = 0, auraColor = '255, 255, 255', auraColorAt = 0, auraPulse = 0;
    const auraGeo = { at: 0, ok: false, sb: null, cv: null, sw: 0, sh: 0, cx: 0, yTop: 0 };
    const HALO_K = 0.3;   // o halo é desenhado em 30% do tamanho (e desfocado ali) e esticado: fica igual e custa ~10x menos
    function auraHide(cv) { if (cv && cv.style.opacity !== '0') cv.style.opacity = '0'; }
    // Onde ficam a barra lateral e as capas: confere a cada ~0,3 s (as capas só andam quando a lista rola)
    function auraMeasure(now) {
        const G = auraGeo;
        G.at = now; G.ok = false;
        const sb = document.getElementById('Desktop_LeftSidebar_Id');
        if (!sb) return;
        let cv = sb.querySelector(':scope > canvas.jc-aura');
        const sr = sb.getBoundingClientRect();
        if (!sr.width || !sr.height || sr.width > 140) { auraHide(cv); return; }      // barra aberta
        const covers = Array.from(sb.querySelectorAll('img[data-jc-sh]')).map((i) => i.getBoundingClientRect()).filter((r) => r.width > 24 && r.bottom > sr.top && r.top < sr.bottom);
        if (!covers.length) { auraHide(cv); return; }
        if (!cv) {
            cv = document.createElement('canvas');
            cv.className = 'jc-aura';
            cv.setAttribute('aria-hidden', 'true');
            sb.insertBefore(cv, sb.firstChild);
            if (getComputedStyle(sb).position === 'static') sb.style.position = 'relative';
        }
        G.sb = sb; G.cv = cv; G.sw = sr.width; G.sh = sr.height;
        G.cx = covers.reduce((a, r) => a + (r.left + r.width / 2), 0) / covers.length - sr.left;
        G.yTop = Math.max(0, Math.min.apply(null, covers.map((r) => r.top)) - sr.top - 22);
        G.ok = true;
    }
    function auraFrame() {
        let playing = false;
        try { playing = !!Spicetify.Player.isPlaying(); } catch (e) { /* parado */ }
        fxSet('aura', document.hidden || fxPause || lite ? 500 : playing ? FX_GRID : 160);   // 25 quadros/s tocando; pausada só "respira" devagar
        if (document.hidden || fxPause || lite) return;
        const ts = performance.now();
        try {
            if ((ts - auraGeo.at > 2500 || !auraGeo.cv || !auraGeo.cv.isConnected) && !auraGeo.pending) {
                auraGeo.pending = true; auraGeo.at = ts;
                cleanRead(() => { auraGeo.pending = false; try { auraMeasure(performance.now()); } catch (e) { /* enfeite */ } });
            }
            const G = auraGeo;
            if (!G.ok) return;
            const cv = G.cv, sw = G.sw, sh = G.sh;
            const dpr = window.devicePixelRatio || 1;
            const PAD = 28;   // o canvas passa 28px de cada lado da barra, para o brilho ter onde se apagar
            const W = Math.round((sw + PAD * 2) * dpr), H = Math.round(sh * dpr);
            if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
            auraColor = pcv();
            const now = ts / 1000;
            let lv = null;
            if (playing) { try { lv = eqLevels((Spicetify.Player.getProgress() || 0) / 1000 + 0.06); } catch (e) { lv = null; } }
            const volT = playing ? (lv ? lv.vol : 0.5 + 0.25 * Math.sin(now * 1.9)) : 0;
            auraAmp += (volT - auraAmp) * 0.18;
            const pulseT = lv ? lv.pulse : 0;
            auraPulse += (pulseT - auraPulse) * (pulseT > auraPulse ? 0.6 : 0.15);

            const cx = G.cx, yTop = G.yTop, yBot = sh - 2;
            const A = playing ? 4 + auraAmp * 17 + auraPulse * 7 : 2.2 + Math.sin(now * 1.1) * 0.9;
            const padX = 8;
            const pts = [];
            for (let y = yTop; y <= yBot; y += 4) {
                const u = (y - yTop) / Math.max(1, yBot - yTop);
                const env = Math.min(1, (y - yTop) / 46) * Math.min(1, (yBot - y) / 110);
                let pitch = 0.5 + 0.5 * Math.sin(u * 7.3 + now * 1.4);
                if (lv && lv.pitches && lv.pitches.length) {
                    const pk = (u * 11 + now * 0.7) % 12, p0 = Math.floor(pk) % 12, p1 = (p0 + 1) % 12, f = pk - Math.floor(pk);
                    pitch = (lv.pitches[p0] || 0) * (1 - f) + (lv.pitches[p1] || 0) * f;
                }
                const wave = Math.sin(y * 0.043 - now * 3.2) * 0.62 + Math.sin(y * 0.019 + now * 1.6 + 1.3) * 0.38;
                const x = cx + wave * A * (0.4 + 0.95 * pitch) * env;
                pts.push([Math.max(padX, Math.min(sw - padX, x)), y]);
            }
            const path = (ctx) => {
                ctx.beginPath();
                ctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length - 1; i++) {
                    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
                    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
                }
                ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
            };
            const grad = (ctx, c0, c1, c2, c3, a) => {
                const g = ctx.createLinearGradient(0, yTop, 0, yBot);
                g.addColorStop(0, c0); g.addColorStop(0.07, c1); g.addColorStop(a, c2); g.addColorStop(1, c3);
                return g;
            };
            const k = playing ? 1 : 0.6, boost = 1 + auraPulse * 0.7;
            // aura: halo desenhado com desfoque de verdade (sem faixas), mas numa tela pequena
            let halo = cv.__halo;
            cv.__hn = (cv.__hn || 0) + 1;
            const redoHalo = !halo || cv.__hn % 2 === 0;
            const hw = Math.max(8, Math.round((sw + PAD * 2) * HALO_K)), hh = Math.max(8, Math.round(sh * HALO_K));
            if (!halo) halo = cv.__halo = document.createElement('canvas');
            const resized = halo.width !== hw || halo.height !== hh;
            if (resized) { halo.width = hw; halo.height = hh; }
            if (redoHalo || resized) {   // o brilho em volta é suave: redesenhá-lo um quadro sim, outro não não se nota
                const hx = halo.getContext('2d');
                hx.setTransform(HALO_K, 0, 0, HALO_K, PAD * HALO_K, 0);
                hx.filter = 'none';
                hx.clearRect(-PAD, 0, sw + PAD * 2, sh);
                hx.globalCompositeOperation = 'lighter';
                hx.lineCap = 'round'; hx.lineJoin = 'round';
                const gH = grad(hx, 'rgba(' + auraColor + ', 0)', 'rgba(' + auraColor + ', 0.85)', 'rgba(' + auraColor + ', 1)', 'rgba(' + auraColor + ', 0)', 0.55);
                [[18, 34, 0.34], [9, 16, 0.42], [4, 7, 0.40]].forEach(([blur, w, a]) => {
                    hx.filter = 'blur(' + (blur * HALO_K) + 'px)';
                    hx.globalAlpha = Math.min(1, a * k * boost);
                    hx.strokeStyle = gH;
                    hx.lineWidth = w;
                    path(hx);
                    hx.stroke();
                });
                hx.filter = 'none';
            }
            const ctx = cv.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, PAD * dpr, 0);
            ctx.filter = 'none';
            ctx.globalAlpha = 1;
            ctx.clearRect(-PAD, 0, sw + PAD * 2, sh);
            ctx.globalCompositeOperation = 'lighter';
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(halo, 0, 0, hw, hh, -PAD, 0, sw + PAD * 2, sh);
            ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            const gP = grad(ctx, 'rgba(' + auraColor + ', 0)', 'rgba(' + auraColor + ', 0.85)', 'rgba(' + auraColor + ', 1)', 'rgba(' + auraColor + ', 0)', 0.55);
            const gW = grad(ctx, 'rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.95)', 'rgba(255, 255, 255, 0.85)', 'rgba(255, 255, 255, 0)', 0.5);
            ctx.globalAlpha = 0.62 * k;
            ctx.strokeStyle = gP;
            ctx.lineWidth = 2.4;
            path(ctx);
            ctx.stroke();
            ctx.globalAlpha = 0.34 * k;
            ctx.strokeStyle = gW;
            ctx.lineWidth = 1;
            path(ctx);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            if (cv.style.opacity !== '1') cv.style.opacity = '1';
        } catch (e) { /* enfeite */ }
    }
    auraFrame = timed('aura', auraFrame);
    fxStart('aura', () => auraFrame(), 500);

    // ---------------------------------------------------------------------
    // Ícones próprios do player: um conjunto em SVG com o mesmo traço e tamanho
    // (no estilo dos botões do Lyrics). Só troco o DESENHO: o botão do Spotify
    // continua o mesmo (clique, estado ativo, dica). Botões escondidos não são tocados.
    // ---------------------------------------------------------------------
    // ---------------------------------------------------------------------
    // Ícones "hintados": desenhados numa grade de 24 e convertidos na hora para a
    // grade de PIXELS FÍSICOS da tela (zoom do Spotify x escala do Windows). Cada linha
    // reta cai inteira dentro de pixels e o traço tem largura inteira; assim ficam
    // nítidos como os ícones do próprio Spotify, em qualquer zoom.
    // Primitivas (coordenadas 0..24): s = linha/caminho com traço, f = forma cheia.
    // ---------------------------------------------------------------------
    const ICON_DEFS = {
        shuffle: [
            ['s', 'M3 17 L5.6 17 Q7.2 17 8.2 15.7 L13.8 8.3 Q14.8 7 16.4 7 L20.5 7'],
            ['s', 'M3 7 L5.6 7 Q7.2 7 8.2 8.3 L9.6 10.2'],
            ['s', 'M12.4 13.8 L13.8 15.7 Q14.8 17 16.4 17 L20.5 17'],
            ['s', 'M17.8 4.3 L20.5 7 L17.8 9.7'],
            ['s', 'M17.8 14.3 L20.5 17 L17.8 19.7'],
        ],
        prev: [
            ['f', 'M11.5 5.6 L11.5 18.4 L3 12 Z'],
            ['f', 'M20.5 5.6 L20.5 18.4 L12 12 Z'],
        ],
        next: [
            ['f', 'M12.5 5.6 L12.5 18.4 L21 12 Z'],
            ['f', 'M3.5 5.6 L3.5 18.4 L12 12 Z'],
        ],
        repeat: [
            ['s', 'M3.5 11.5 L3.5 10 A3.5 3.5 0 0 1 7 6.5 L20 6.5'],
            ['s', 'M17.3 3.8 L20 6.5 L17.3 9.2'],
            ['s', 'M20.5 12.5 L20.5 14 A3.5 3.5 0 0 1 17 17.5 L4 17.5'],
            ['s', 'M6.7 20.2 L4 17.5 L6.7 14.8'],
        ],
        repeat1: [
            ['s', 'M3.5 11.5 L3.5 10 A3.5 3.5 0 0 1 7 6.5 L20 6.5'],
            ['s', 'M17.3 3.8 L20 6.5 L17.3 9.2'],
            ['s', 'M20.5 12.5 L20.5 14 A3.5 3.5 0 0 1 17 17.5 L4 17.5'],
            ['s', 'M6.7 20.2 L4 17.5 L6.7 14.8'],
            ['s', 'M10.6 10.2 L12 9.2 L12 14.6'],
        ],
        // balão cheio com duas linhas recortadas (forma cheia, como o botão de salvar)
        lyrics: [
            ['f', 'RR 2.5 3.5 21.5 16.5 3.5', 'TRI 6.5 16 11.5 16 6.5 21', 'HOLE 6.5 7.5 17.5 9.5 1', 'HOLE 6.5 11 13 13 1'],
        ],
        queue: [
            ['f', 'RR 3 4 21 6 1'],
            ['f', 'RR 3 11 21 13 1'],
            ['f', 'RR 3 18 12.5 20 1'],
            ['f', 'M15 15 L15 21.5 L21 18.25 Z'],
        ],
        // caixa de som cheia, com o alto-falante recortado
        devices: [
            ['f', 'RR 5.5 2 18.5 22 3', 'HOLEC 12 14.5 3.8', 'HOLEC 12 7.2 1.5'],
            ['f', 'C 12 14.5 1.5'],
        ],
        npv: [
            ['s', 'RR 3 4.5 21 19.5 3.5'],
            ['f', 'M14.5 4.5 L17.5 4.5 A3.5 3.5 0 0 1 21 8 L21 16 A3.5 3.5 0 0 1 17.5 19.5 L14.5 19.5 Z'],
        ],
        pip: [
            ['s', 'RR 3 4.5 21 19.5 3.5'],
            ['f', 'RR 11.5 11 18 16 1.5'],
        ],
        fullscreen: [
            ['s', 'M14 4 L20 4 L20 10'],
            ['s', 'M20 4 L14 10'],
            ['s', 'M10 20 L4 20 L4 14'],
            ['s', 'M4 20 L10 14'],
        ],
    };
    // Ligados (aleatório / repetir): o desenho vira uma plaquinha CHEIA, como os ícones de
    // letra e de dispositivo, com o símbolo recortado em escuro por dentro.
    const scalePath = (d, sc) => d.replace(/([MLQA])([^MLQAZ]*)/g, (m, cmd, args) => {
        const n = args.trim().split(/[\s,]+/).map(Number);
        const P = (x, y) => (12 + (x - 12) * sc).toFixed(2) + ' ' + (12 + (y - 12) * sc).toFixed(2);
        if (cmd === 'A') return 'A' + (n[0] * sc).toFixed(2) + ' ' + (n[1] * sc).toFixed(2) + ' ' + n[2] + ' ' + n[3] + ' ' + n[4] + ' ' + P(n[5], n[6]);
        let out = cmd;
        for (let i = 0; i + 1 < n.length; i += 2) out += (i ? ' ' : '') + P(n[i], n[i + 1]);
        return out;
    });
    const iconBadge = (defs, sc) => [['f', 'RR 0.5 2 23.5 22 5.5']].concat(defs.map((d) => ['k'].concat(d.slice(1).map((pp) => scalePath(pp, sc)))));
    ICON_DEFS.shuffleOn = iconBadge(ICON_DEFS.shuffle, 0.8);
    ICON_DEFS.repeatOn = iconBadge(ICON_DEFS.repeat, 0.8);
    ICON_DEFS.repeat1On = iconBadge(ICON_DEFS.repeat1, 0.8);
    const ICON_ON = '[aria-checked="true"], [aria-checked="mixed"], [aria-pressed="true"], [data-active="true"], .active, .main-genericButton-buttonActive, .main-genericButton-buttonActiveDot, .A6OB2PW88hienapJaToK';
    // pontinho de "ligado" do Spotify: um ::after redondo de ~4px no botão ou dentro dele
    const hasOnDot = (el) => {
        try {
            for (const n of [el, ...el.querySelectorAll('*')]) {
                const a = getComputedStyle(n, '::after');
                if (!a || a.content === 'none' || a.content === 'normal') continue;
                const w = parseFloat(a.width), h = parseFloat(a.height);
                if (w > 0 && w <= 6 && h > 0 && h <= 6 && a.position === 'absolute') return true;
            }
        } catch (e) { /* sem estilo */ }
        return false;
    };
    const onDotSeen = new WeakMap();
    const isOnBtn = (b) => {
        if (b.matches(ICON_ON)) return true;
        // o pontinho de "ligado" vem com mudança de classe/estado; ler innerHTML aqui era caro (e mudava sozinho
        // quando o ícone do tema entrava no botão, obrigando a recalcular o estilo da página toda vez)
        const k = (b.getAttribute('class') || '') + '|' + (b.getAttribute('aria-checked') || '') + (b.getAttribute('aria-pressed') || '') + (b.getAttribute('data-active') || '');
        const c = onDotSeen.get(b);
        if (c && c.k === k) return c.v;
        const v = hasOnDot(b);
        onDotSeen.set(b, { k, v });
        return v;
    };

    // converte uma definição para a grade de D pixels, traço w
    function hintIcon(defs, D, w) {
        const k = D / 24, o = (w % 2) ? 0.5 : 0;
        const ss = (v) => Math.round(v * k - o) + o;          // centro do traço
        const sf = (v) => Math.round(v * k);                  // borda de forma cheia
        const sr = (v) => Math.max(0.5, Math.round(v * k * 2) / 2);
        const fmt = (n) => (Math.round(n * 1000) / 1000).toString();
        // bordas encaixadas no pixel; em partes finas (até 4 unidades) a espessura é mantida,
        // senão o arredondamento deixava uma barrinha com 1px e outra com 3px
        const fit = (p, q, snap) => {
            const s = snap(p);
            let e = snap(q);
            if (q - p <= 4) {
                const t = Math.max(1, Math.round((q - p) * k));
                if (Math.abs((e - s) - t) >= 1) e = s + t;
            }
            return [s, e];
        };
        const rrect = (x1, y1, x2, y2, r, snap, cw) => {      // retângulo arredondado (sentido horário ou anti)
            const [a, c] = fit(x1, x2, snap), [b, d] = fit(y1, y2, snap);
            const rr = Math.min(sr(r), (c - a) / 2, (d - b) / 2);
            if (cw) return 'M' + fmt(a + rr) + ' ' + fmt(b) + 'H' + fmt(c - rr) + 'A' + fmt(rr) + ' ' + fmt(rr) + ' 0 0 1 ' + fmt(c) + ' ' + fmt(b + rr) + 'V' + fmt(d - rr) + 'A' + fmt(rr) + ' ' + fmt(rr) + ' 0 0 1 ' + fmt(c - rr) + ' ' + fmt(d) + 'H' + fmt(a + rr) + 'A' + fmt(rr) + ' ' + fmt(rr) + ' 0 0 1 ' + fmt(a) + ' ' + fmt(d - rr) + 'V' + fmt(b + rr) + 'A' + fmt(rr) + ' ' + fmt(rr) + ' 0 0 1 ' + fmt(a + rr) + ' ' + fmt(b) + 'Z';
            return 'M' + fmt(a + rr) + ' ' + fmt(b) + 'A' + fmt(rr) + ' ' + fmt(rr) + ' 0 0 0 ' + fmt(a) + ' ' + fmt(b + rr) + 'V' + fmt(d - rr) + 'A' + fmt(rr) + ' ' + fmt(rr) + ' 0 0 0 ' + fmt(a + rr) + ' ' + fmt(d) + 'H' + fmt(c - rr) + 'A' + fmt(rr) + ' ' + fmt(rr) + ' 0 0 0 ' + fmt(c) + ' ' + fmt(d - rr) + 'V' + fmt(b + rr) + 'A' + fmt(rr) + ' ' + fmt(rr) + ' 0 0 0 ' + fmt(c - rr) + ' ' + fmt(b) + 'Z';
        };
        const circ = (cx, cy, r, snapc, cw) => {
            const x = snapc(cx), y = snapc(cy), R = sr(r);
            return 'M' + fmt(x - R) + ' ' + fmt(y) + 'A' + fmt(R) + ' ' + fmt(R) + ' 0 1 ' + (cw ? 1 : 0) + ' ' + fmt(x + R) + ' ' + fmt(y) + 'A' + fmt(R) + ' ' + fmt(R) + ' 0 1 ' + (cw ? 1 : 0) + ' ' + fmt(x - R) + ' ' + fmt(y) + 'Z';
        };
        const path = (d, snap) => d.replace(/([MLQAZ])([^MLQAZ]*)/g, (m, cmd, args) => {
            const n = args.trim() ? args.trim().split(/[\s,]+/).map(Number) : [];
            if (cmd === 'Z') return 'Z';
            if (cmd === 'A') return 'A' + fmt(sr(n[0])) + ' ' + fmt(sr(n[1])) + ' ' + n[2] + ' ' + n[3] + ' ' + n[4] + ' ' + fmt(snap(n[5])) + ' ' + fmt(snap(n[6]));
            return cmd + n.map((v) => fmt(snap(v))).join(' ');
        });
        let out = '';
        for (const def of defs) {
            const mode = def[0];
            const snap = (mode === 's' || mode === 'k') ? ss : sf;
            let d = '';
            for (const part of def.slice(1)) {
                const t = part.split(/\s+/);
                if (t[0] === 'RR') d += rrect(+t[1], +t[2], +t[3], +t[4], +t[5], snap, true);
                else if (t[0] === 'HOLE') d += rrect(+t[1], +t[2], +t[3], +t[4], +t[5], sf, false);
                else if (t[0] === 'HOLEC') d += circ(+t[1], +t[2], +t[3], sf, false);
                else if (t[0] === 'C') d += circ(+t[1], +t[2], +t[3], mode === 's' ? ss : sf, true);
                else if (t[0] === 'TRI') d += 'M' + fmt(sf(+t[1])) + ' ' + fmt(sf(+t[2])) + 'L' + fmt(sf(+t[3])) + ' ' + fmt(sf(+t[4])) + 'L' + fmt(sf(+t[5])) + ' ' + fmt(sf(+t[6])) + 'Z';
                else d += path(part, snap);
            }
            out += mode === 's'
                ? '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"/>'
                : mode === 'k'
                    ? '<path class="k" d="' + d + '" fill="none" stroke="#141418" stroke-width="' + Math.max(1, Math.round(w * 0.7 * 2) / 2) + '" stroke-linecap="round" stroke-linejoin="round"/>'
                    : '<path class="f" d="' + d + '" fill="currentColor" fill-rule="nonzero" stroke="none"/>';
        }
        return out;
    }
    const tipText = (b) => {
        try {
            const c = b._tippy && b._tippy.props && b._tippy.props.content;
            if (typeof c === 'string') return c;
            if (c && c.textContent) return c.textContent;
        } catch (e) { /* sem tippy */ }
        return '';
    };
    const iconType = (b) => {
        const t = (b.getAttribute('data-testid') || '').toLowerCase();
        const l = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + tipText(b)).toLowerCase();
        const k = t + ' ' + l;
        // botões do Spicy Lyrics (sem aria-label; o nome fica na dica)
        if (b.classList.contains('SpicyLyrics_PlaybarButton')) {
            if (/popup|pip|picture/.test(l)) return 'pip';
            if (/fullscreen|full screen|tela cheia/.test(l)) return 'fullscreen';
            if (/lyric|letra/.test(l)) return 'lyrics';
            const html = b.innerHTML;
            if (html.includes('M6.064 10.229') || html.includes('M6.064')) return 'fullscreen';
            const all = Array.from(document.querySelectorAll('.main-nowPlayingBar-right .SpicyLyrics_PlaybarButton'));
            return ['lyrics', 'fullscreen', 'pip'][all.indexOf(b)] || null;
        }
        if (/shuffle|aleat/.test(k)) return 'shuffle';
        if (/skip-back|anterior|previous/.test(k)) return 'prev';
        if (/skip-forward|próxima|proxima|\bnext\b|avançar/.test(k)) return 'next';
        if (/repeat|repeti/.test(k)) return (/desativar|disable/.test(l) || b.getAttribute('aria-checked') === 'mixed') ? 'repeat1' : 'repeat';
        if (/lyric|letra/.test(k)) return 'lyrics';
        if (/queue|fila/.test(k)) return 'queue';
        if (/device|dispositivo|connect/.test(k)) return 'devices';
        if (/npv|tocando agora|now playing/.test(k)) return 'npv';
        if (/pip|miniplayer|mini player|minipl/.test(k)) return 'pip';
        if (/fullscreen|full screen|tela cheia/.test(k)) return 'fullscreen';
        // sem nome reconhecível: o último botão visível da direita é o de tela cheia
        try {
            const right = b.closest('.main-nowPlayingBar-right');
            if (right) {
                const vis = Array.from(right.querySelectorAll('button')).filter((x) => x.offsetWidth && !x.closest('.jc-knob') && !x.hasAttribute('data-jc-volmute'));
                if (vis.length && vis[vis.length - 1] === b) return 'fullscreen';
            }
        } catch (e) { /* segue */ }
        return null;
    };
    // tamanho do ícone em PIXELS FÍSICOS (D) e largura do traço (w) para o zoom atual
    const iconGrid = () => {
        const dpr = window.devicePixelRatio || 1;
        return { dpr, D: Math.max(16, Math.round(20 * dpr)), w: Math.max(2, Math.round(1.5 * dpr)) };
    };
    // O navegador encaixa o <svg> em pixel inteiro: no modo "zoom pela escala da tela"
    // (Windows com escala + zoom do Spotify) o encaixe já é no pixel físico; no outro modo é
    // no pixel CSS. Descubro qual é medindo como ele arredonda posições fracionárias.
    let layoutPhysical = null;
    function detectLayoutPhysical() {
        try {
            const dpr = window.devicePixelRatio || 1;
            if (Math.abs(dpr - Math.round(dpr)) < 0.01) return true;
            const el = document.createElement('div');
            el.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;visibility:hidden;pointer-events:none';
            document.body.appendChild(el);
            let eCss = 0, eDev = 0;
            for (const v of [0.31, 0.37, 0.53, 0.71, 0.83, 1.29]) {
                el.style.left = v + 'px';
                const x = el.getBoundingClientRect().left;
                eCss += Math.abs(x * 64 - Math.round(x * 64));
                eDev += Math.abs(x * dpr * 64 - Math.round(x * dpr * 64));
            }
            el.remove();
            return eDev < eCss;
        } catch (e) { return true; }
    }
    function skinIcons() {   // devolve true quando criou/trocou algum ícone
        let made = false;
        try {
            const { dpr, D, w } = iconGrid();
            const scope = document.querySelectorAll('.main-nowPlayingBar-center [data-testid="player-controls"] button, .main-nowPlayingBar-right button');
            scope.forEach((b) => {
                if (b.matches('[data-testid="control-button-playpause"], [data-jc-volmute]') || b.closest('.jc-knob, [data-tippy-root], [role="dialog"], [role="menu"]')) return;
                const type = iconType(b);
                if (!type || !ICON_DEFS[type]) return;
                const mine = b.querySelector(':scope > svg.jc-ico');
                if (!b.hasAttribute('data-jc-ico')) { const z = sizeOf(b); if (!z || !z.w) return; }   // escondido de propósito: não mexe
                const on = /^(shuffle|repeat|repeat1)$/.test(type) && isOnBtn(b);
                if (on !== b.hasAttribute('data-jc-on')) { if (on) b.setAttribute('data-jc-on', ''); else b.removeAttribute('data-jc-on'); }
                const draw = (on && ICON_DEFS[type + 'On']) ? type + 'On' : type;
                const key = draw + '@' + D + '/' + w;
                if (mine && mine.getAttribute('data-k') === key && b.getAttribute('data-jc-ico') === type) return;
                if (mine) mine.remove();
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('class', 'jc-ico');
                svg.setAttribute('viewBox', '0 0 ' + D + ' ' + D);
                svg.setAttribute('aria-hidden', 'true');
                svg.setAttribute('data-t', type);
                svg.setAttribute('data-k', key);
                svg.innerHTML = '<g class="jc-g">' + hintIcon(ICON_DEFS[draw], D, w) + '</g>';
                if (draw !== type) svg.setAttribute('data-on', ''); 
                // tamanho exato: D pixels físicos (inline !important vence o CSS do Spicy)
                const css = (D / dpr).toFixed(4) + 'px';
                svg.style.setProperty('width', css, 'important');
                svg.style.setProperty('height', css, 'important');
                b.appendChild(svg);
                b.setAttribute('data-jc-ico', type);
                made = true;
            });
        } catch (e) { /* enfeite */ }
        return made;
    }
    // A barra do player é uma camada própria (CSS: will-change). Encaixo a camada no pixel
    // físico inteiro com um translate de fração de pixel: assim ela é desenhada na tela sem
    // ser reamostrada (esticada), que era o que deixava os ícones borrados.
    const BAR_SEL = '.Root aside.main-nowPlayingBar-container';
    function alignBar(dpr) {
        const bar = document.querySelector(BAR_SEL);
        if (!bar) return null;
        const applied = bar.style.getPropertyValue('transform');
        const cur = (bar.__jcAl && applied === bar.__jcAl[2]) ? bar.__jcAl : [0, 0, ''];
        const r = bar.getBoundingClientRect();
        if (!r.width) return bar;
        const lx = r.left - cur[0], ly = r.top - cur[1];
        const dx = (Math.round(lx * dpr) - lx * dpr) / dpr, dy = (Math.round(ly * dpr) - ly * dpr) / dpr;
        const f4 = (n) => (Math.abs(n) < 5e-5 ? 0 : n).toFixed(4);
        const val = 'translate(' + f4(dx) + 'px, ' + f4(dy) + 'px)';
        if (applied !== val) bar.style.setProperty('transform', val, 'important');
        bar.__jcAl = [dx, dy, bar.style.getPropertyValue('transform')];
        return bar;
    }
    // Encaixe fino: se o navegador encaixa o <svg> no pixel CSS (e não no físico), desloco o
    // desenho POR DENTRO do ícone (atributo transform do <g>) a fração que falta. A conta é
    // feita a partir da origem da camada da barra (que já está no pixel inteiro).
    const q64 = (v) => Math.round(Math.round(v * 64) / 64);   // arredonda como o navegador (1/64 px)
    function snapIcons() {
        try {
            const { dpr, D } = iconGrid();
            if (layoutPhysical === null) layoutPhysical = detectLayoutPhysical();
            const css = (D / dpr).toFixed(4) + 'px';
            if (root.style.getPropertyValue('--jc-ico-size') !== css) root.style.setProperty('--jc-ico-size', css);
            const bar = alignBar(dpr);
            const br = bar ? bar.getBoundingClientRect() : null;
            const todo = [];
            document.querySelectorAll('.Root svg.jc-ico').forEach((svg) => {
                const g = svg.querySelector(':scope > g.jc-g');
                if (!g) return;
                let val = 'translate(0 0)';
                if (!layoutPhysical) {
                    const r = svg.getBoundingClientRect();
                    if (!r.width) return;
                    const inBar = br && bar.contains(svg);
                    const ox = inBar ? br.left : 0, oy = inBar ? br.top : 0;
                    const px = q64(r.left - ox) * dpr, py = q64(r.top - oy) * dpr;
                    val = 'translate(' + (Math.round(px) - px).toFixed(3) + ' ' + (Math.round(py) - py).toFixed(3) + ')';
                }
                todo.push([svg, g, val]);
            });
            todo.forEach(([svg, g, val]) => {
                if (svg.style.transform) svg.style.transform = '';
                if (g.getAttribute('transform') !== val) g.setAttribute('transform', val);
            });
        } catch (e) { /* enfeite */ }
    }
    every(function icons() { if (skinIcons()) snapIcons(); }, 1500, 0, 'mut: bar');
    every(snapIcons, 30000, 60000, 'mut: bar');
    try {
        let skinRaf = 0;
        const skinMo = new MutationObserver(() => {
            if (!skinRaf) skinRaf = requestAnimationFrame(() => { skinRaf = 0; skinIcons(); snapIcons(); });
        });
        const watchSkin = () => {
            const c = document.querySelector('.main-nowPlayingBar-nowPlayingBar');
            if (c && !c.__jcSkinMo) {
                c.__jcSkinMo = true;
                skinMo.observe(c, { attributes: true, subtree: true, attributeFilter: ['aria-checked', 'aria-pressed', 'data-active', 'aria-label'] });
            }
        };
        watchSkin();
        every(watchSkin, 1500, 4000);
    } catch (e) { /* sem observador */ }
    window.addEventListener('resize', () => { layoutPhysical = null; setTimeout(() => { skinIcons(); snapIcons(); }, 60); });
    every(mountKnob, 500);

    // a lista reaproveita as linhas ao rolar: recalcula a faixa tocando logo após a rolagem,
    // para o anel não "grudar" em outra música
    let playRaf = 0;
    document.addEventListener('scroll', (e) => {
        if (!(e.target instanceof Element) || !e.target.closest('#main-view')) return;
        if (root.hasAttribute('data-jc-lyricspage') || e.target.closest('#SpicyLyricsPage, .LyricsContainer')) return;
        if (playRaf) return;
        playRaf = requestAnimationFrame(() => { playRaf = 0; updatePlaying(); });
    }, true);

    // ---------------------------------------------------------------------
    // Página de letras: a barra do player continua o FUNDO ANIMADO das letras.
    // Atrás da barra (fora dela, para não mexer na nitidez dos ícones) fica um
    // bloco .jc-lyrbar do mesmo tamanho. Nele vai a faixa de baixo do fundo do
    // Spicy: o canvas animado (copiado pelo bgLyr, em pequeno) ou, sem ele, a capa
    // borrada / a cor de fundo. Fora das letras o bloco é o vidro fosco da barra.
    function lyrSource() {
        const box = document.querySelector('#main-view #SpicyLyricsPage .ContentBox') || document.querySelector('#SpicyLyricsPage .ContentBox');
        if (!box || !box.getClientRects().length) return null;
        const page = box.closest('#SpicyLyricsPage');
        const amb = box.querySelector(':scope > canvas.CanvasAmbient');
        if (amb && page && page.classList.contains('CanvasImmersive') && amb.width > 1 && amb.height > 1) return { kind: 'canvas', el: amb };
        const layers = Array.from(box.querySelectorAll(':scope > .spicy-dynamic-bg'))
            .filter((e) => !e.classList.contains('transition_Out') && !e.classList.contains('is-pending'));
        const top = layers[layers.length - 1];
        if (!top) return null;
        if (top.tagName === 'CANVAS') return (top.width > 1 && top.height > 1) ? { kind: 'canvas', el: top } : null;
        if (top.classList.contains('StaticBackground')) return { kind: 'image', el: top };
        if (top.classList.contains('ColorBackground')) return { kind: 'color', el: top };
        return null;
    }
    function lyrHost(bar) {
        let host = document.querySelector('.jc-lyrbar');
        if (!host) {
            host = document.createElement('div');
            host.className = 'jc-lyrbar';
            host.setAttribute('aria-hidden', 'true');
            host.innerHTML = '<div class="jc-lyrbar-art"></div><div class="jc-lyrbar-col"></div><canvas class="jc-lyrbar-cv" width="2" height="2"></canvas>';
        }
        if (host.nextElementSibling !== bar) bar.parentElement.insertBefore(host, bar);
        return host;
    }
    // posição/tamanho do bloco atrás da barra, capa e cor de fundo das letras (o canvas é copiado pelo bgLyr)
    let lyrPosDirty = true, lyrStyleAt = 0;
    window.addEventListener('resize', () => { lyrPosDirty = true; auraGeo.at = 0; });
    document.addEventListener('scroll', (e) => {   // a barra lateral rolou: a aura remede as capas
        if (e.target instanceof Element && e.target.closest('#Desktop_LeftSidebar_Id')) auraGeo.at = 0;
    }, { capture: true, passive: true });
    function lyrSync() {
        try {
            const lyr = root.hasAttribute('data-jc-lyricspage');
            const bar = document.querySelector('.Root aside.main-nowPlayingBar-container');
            if (!bar || !bar.parentElement) return;
            const host = lyrHost(bar);
            // posição do bloco: só quando a barra muda de tamanho (ResizeObserver) ou a janela muda,
            // medida logo após um quadro (antes era medida 4x por segundo)
            if (!bar.__onSize) { bar.__onSize = () => { lyrPosDirty = true; }; sizeOf(bar); }
            if (lyrPosDirty || host.__bar !== bar) {
                lyrPosDirty = false; host.__bar = bar;
                cleanRead(() => {
                    const pos = bar.offsetLeft + ',' + bar.offsetTop + ',' + bar.offsetWidth + ',' + bar.offsetHeight;
                    if (host.__pos === pos) return;
                    host.__pos = pos;
                    host.style.left = bar.offsetLeft + 'px';
                    host.style.top = bar.offsetTop + 'px';
                    host.style.width = bar.offsetWidth + 'px';
                    host.style.height = bar.offsetHeight + 'px';
                });
            }
            if (!bar.hasAttribute('data-jc-barbg')) bar.setAttribute('data-jc-barbg', '');
            if (!lyr) return;
            const nowL = performance.now();
            if (nowL - lyrStyleAt < 2000) return;   // capa/cor das letras: confere a cada 2 s
            lyrStyleAt = nowL;
            const art = host.querySelector('.jc-lyrbar-art');
            const col = host.querySelector('.jc-lyrbar-col');
            const src = lyrSource();
            // capa (base e reserva)
            let img = '';
            if (src && src.kind === 'image') img = getComputedStyle(src.el).getPropertyValue('--BackgroundImage').trim();
            if (!img || img === 'none') {
                try {
                    const md = (Spicetify.Player.data.item || {}).metadata || {};
                    const u = (md.image_xlarge_url || md.image_large_url || md.image_url || '').replace(/^spotify:image:/, 'https://i.scdn.co/image/');
                    img = u ? 'url("' + u + '")' : '';
                } catch (e) { img = ''; }
            }
            if (art.__img !== img) { art.__img = img; art.style.backgroundImage = img || 'none'; }
            if (src && src.kind === 'color') {
                const c = getComputedStyle(src.el).backgroundColor;
                if (col.__c !== c) { col.__c = c; col.style.backgroundColor = c; }
                col.style.opacity = '1';
            } else {
                col.style.opacity = '0';
            }
        } catch (e) { /* fica a capa borrada */ }
    }
    every(lyrSync, 500);


    // ---------------------------------------------------------------------
    // Barras que grudam no topo da página (barra do título com o play e o
    // cabeçalho "# Título · Álbum"). No Spotify 1.3.x as classes viram hash,
    // então em vez de adivinhar nomes pergunto ao navegador o que está
    // desenhado nesses pontos (elementsFromPoint) e marco, com data-jc-sticky,
    // o que for sticky/fixed/absolute, largo e baixo. O CSS dá fundo sólido a
    // essas marcas, para as linhas das faixas não aparecerem por baixo.
    // ---------------------------------------------------------------------
    // O CSS inteiro vem do user.css (um só lugar). Se ele estiver ausente ou de outra versão, avisa uma vez.
    const JC_CSS_V = '65';
    setTimeout(() => {
        try {
            const v = getComputedStyle(root).getPropertyValue('--jc-css-v').trim();
            if (v !== JC_CSS_V && Spicetify.showNotification) Spicetify.showNotification('Liquid Glass: o user.css está ausente ou desatualizado. Copie o user.css novo para Themes\\Hazy e rode "spicetify apply".', true, 9000);
        } catch (e) { /* sem aviso */ }
    }, 4000);

    // ---- fundo do Hazy já desfocado -----------------------------------------------------------------
    // O Hazy desenha a capa em tela cheia (.Root__top-container::before) e a desfoca AO VIVO com
    // filter: blur(...) contrast(...) ... Esse filtro em tela cheia era, de longe, o maior custo de GPU
    // do tema. Aqui a capa é desenhada uma vez por música, em miniatura e já com os mesmos filtros (ele
    // é só um degradê suave, então a miniatura esticada fica igual), e entregue ao CSS como imagem
    // (--jc-bgimg). O CSS então desliga o filtro (data-jc-bgbaked). Se a imagem não carregar, o filtro
    // ao vivo do user.css continua valendo.
    const BAKE_W = 176;
    let bakeCheap = '', bakeKey = '', bakeFail = '', bakeBusy = false, bakeImg = null, bakeImgSrc = '', bakeProbe = null;
    // o Chromium devolve o filtro com contas por resolver (blur(calc(15px + 12px))): resolve as simples
    function calcOnce(m, a, ua, op, b, ub) {
        const x = parseFloat(a), y = parseFloat(b), u = ua || ub || '';
        const r = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : x / y;
        return (+r.toFixed(4)) + u;
    }
    function bakeFilter() {
        if (!bakeProbe) {
            if (!document.body) return 'none';
            bakeProbe = document.createElement('i');
            bakeProbe.style.cssText = 'position:fixed;left:-9px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none;filter:var(--jc-bg-filter)';
            document.body.appendChild(bakeProbe);
        }
        const f = getComputedStyle(bakeProbe).filter;
        if (!f || f === 'none') return 'none';
        const g = f.replace(/calc\(\s*(-?[\d.]+)(px|%)?\s*([-+*\/])\s*(-?[\d.]+)(px|%)?\s*\)/g, (m, a, ua, op, b, ub) => calcOnce(m, a, ua, op, b, ub));
        return g.indexOf('calc(') < 0 ? g : 'none';
    }
    function bakeUnset() {
        if (root.hasAttribute('data-jc-bgbaked')) root.removeAttribute('data-jc-bgbaked');
    }
    function bakeCheck() {
        if (bakeBusy) return;
        // a chave usa só o que o Hazy grava direto no <html> (ler isso não recalcula nada); o estilo
        // calculado (filtro, cor da paleta) só é lido quando a chave muda (música, ajuste, janela)
        const rs = root.style;
        const W = window.innerWidth, H = window.innerHeight;
        const cheap = rs.getPropertyValue('--image_url') + '|' + rs.getPropertyValue('--blur') + rs.getPropertyValue('--cont') + rs.getPropertyValue('--satu') + rs.getPropertyValue('--bright') + '|' + (root.getAttribute('data-jc-palette') || '') + '|' + W + 'x' + H;
        if (cheap === bakeCheap && rs.getPropertyValue('--image_url')) return;
        bakeCheap = cheap;
        const iv = rs.getPropertyValue('--image_url') || getComputedStyle(root).getPropertyValue('--image_url') || '';
        const m = /^\s*url\(\s*"([\s\S]*)"\s*\)\s*$/.exec(iv) || /^\s*url\(\s*'([\s\S]*)'\s*\)\s*$/.exec(iv) || /^\s*url\(\s*([^"'\s)][^)]*)\)\s*$/.exec(iv);
        const f = bakeFilter();
        if (!m || !f || f === 'none') { bakeCheap = ''; return; }
        const pal = root.hasAttribute('data-jc-palette') ? getComputedStyle(root).getPropertyValue('--np-vivid').trim() + '/' + getComputedStyle(root).getPropertyValue('--jc-bgtint').trim() : '';
        const key = m[1] + '|' + f + '|' + pal + '|' + W + 'x' + H;
        if (key === bakeKey || key === bakeFail) return;
        const url = m[1].replace(/^spotify:image:/, 'https://i.scdn.co/image/');
        bakeBusy = true;
        let fin = false;
        const to = setTimeout(() => done(false), 8000);
        const done = (ok) => {
            if (fin) return;
            fin = true; clearTimeout(to); bakeBusy = false;
            if (ok) { bakeKey = key; bakeFail = ''; } else { bakeFail = key; bakeUnset(); }
        };
        const paint = (img) => {
            try {
                // a camada é a janela + 12px de cada lado (igual ao inset:-12px do ::before no user.css), com a
                // capa em "cover", e o desfoque deixa a borda levemente mais escura, como o filtro ao vivo
                const M = 12, CW = W + 2 * M, CH = H + 2 * M, k = BAKE_W / CW;
                const cw = Math.max(8, Math.round(CW * k)), ch = Math.max(8, Math.round(CH * k));
                const a = document.createElement('canvas'); a.width = cw; a.height = ch;
                const c = a.getContext('2d'); c.imageSmoothingQuality = 'high';
                const iw = img.naturalWidth, ih = img.naturalHeight;
                const sc = Math.max(CW / iw, CH / ih), sw = CW / sc, sh = CH / sc;
                c.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, cw, ch);
                if (pal) {   // paleta sólida: o tom entra antes dos filtros (igual ao user.css)
                    const rgb = getComputedStyle(root).getPropertyValue('--np-vivid').trim();
                    const al = parseFloat(getComputedStyle(root).getPropertyValue('--jc-bgtint')) || 0.7;
                    c.globalCompositeOperation = 'color'; c.fillStyle = 'rgba(' + rgb + ',' + al + ')'; c.fillRect(0, 0, cw, ch);
                    c.globalCompositeOperation = 'source-over';
                }
                const b = document.createElement('canvas'); b.width = cw; b.height = ch;
                const d = b.getContext('2d');
                d.filter = f.replace(/blur\(([\d.]+)px\)/, (s0, n) => 'blur(' + (parseFloat(n) * k).toFixed(2) + 'px)');
                d.drawImage(a, 0, 0);
                // data: (e não blob:) porque o Spotify já usa imagens data: nas próprias folhas de estilo
                const u = b.toDataURL('image/png');
                root.style.setProperty('--jc-bgimg', 'url("' + u + '")');
                root.setAttribute('data-jc-bgbaked', '1');
                done(true);
            } catch (err) { done(false); }
        };
        if (bakeImg && bakeImgSrc === url && bakeImg.complete && bakeImg.naturalWidth) { paint(bakeImg); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { bakeImg = img; bakeImgSrc = url; paint(img); };
        img.onerror = () => done(false);
        img.src = url;
    }
    every(bakeCheck, 1000, 3000, 'live');
    setTimeout(songSoon, 300);   // ao abrir: cores, brilho e fundo já, sem esperar o resto

    function stickyCandidates() {
        const mv = document.querySelector('#main-view');
        if (!mv) return [];
        const mr = mv.getBoundingClientRect();
        if (!mr.width) return [];
        const x = mr.left + mr.width * 0.45;
        const ys = [mr.top + 30];
        const hdr = mv.querySelector('[role="row"][aria-rowindex="1"]');
        if (hdr) {
            const hr = hdr.getBoundingClientRect();
            if (hr.height) ys.push(hr.top + hr.height / 2);
        }
        const out = [];
        ys.forEach((y) => {
            let stack = [];
            try { stack = document.elementsFromPoint(x, y); } catch (e) { /* ignora */ }
            stack.forEach((el) => {
                if (el === mv || !mv.contains(el) || out.includes(el)) return;
                // só o que é realmente "sticky" (a barra de colunas); nada de dentro da página de letras
                if (el.closest('#SpicyLyricsPage, .LyricsContainer, .SpicyLyricsScrollContainer')) return;
                const cs = getComputedStyle(el);
                if (cs.position !== 'sticky') return;
                const r = el.getBoundingClientRect();
                if (r.height < 30 || r.height > 140 || r.width < mr.width * 0.6) return;
                out.push(el);
            });
        });
        return out;
    }

    function tagSticky() {
        try {
            const found = stickyCandidates();
            document.querySelectorAll('[data-jc-sticky]').forEach((el) => {
                if (!found.includes(el)) { el.removeAttribute('data-jc-sticky'); el.removeAttribute('data-jc-stuck'); }
            });
            found.forEach((el) => {
                if (!el.hasAttribute('data-jc-sticky')) el.setAttribute('data-jc-sticky', '');
                // presa de verdade = está na altura em que o "sticky" segura (top do CSS)
                const sc = el.closest('.main-view-container__scroll-node, [data-overlayscrollbars-viewport]') || document.querySelector('#main-view');
                const top = parseFloat(getComputedStyle(el).top) || 0;
                const stuck = !!sc && Math.abs(el.getBoundingClientRect().top - (sc.getBoundingClientRect().top + top)) < 1.5;
                if (stuck !== el.hasAttribute('data-jc-stuck')) {
                    if (stuck) el.setAttribute('data-jc-stuck', ''); else el.removeAttribute('data-jc-stuck');
                }
            });
        } catch (e) { /* enfeite */ }
    }
    every(tagSticky, 1500, 0, 'mut: main');
    // ao rolar, confere na hora (a faixa de filtros ganha o fundo assim que gruda no topo)
    let stickyRaf = 0;
    document.addEventListener('scroll', (e) => {
        if (stickyRaf || !(e.target instanceof Element) || !e.target.closest('#main-view')) return;
        stickyRaf = requestAnimationFrame(() => { stickyRaf = 0; tagSticky(); });
    }, true);


    // ---------------------------------------------------------------------
    // Ícone ou letra ESCURO sobre fundo escuro (ex.: seta do carrossel de
    // gêneros, pause da barra do título). Procura na tela, ignora o que tem
    // fundo claro de verdade (botão verde/pérola) e marca data-jc-fixlight
    // para o CSS clarear.
    // ---------------------------------------------------------------------
    function parseCol(s) {
        if (!s) return null;
        const m = String(s).match(/-?[\d.]+%?/g);
        if (!m || m.length < 3) return null;
        let v = m.slice(0, 3).map(parseFloat);
        if (/^color\(/.test(s)) v = v.map((x) => x * 255);
        let a = 1;
        if (m.length > 3) a = /%$/.test(m[3]) ? parseFloat(m[3]) / 100 : parseFloat(m[3]);
        return { l: (0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2]) / 255, a };
    }

    function bgIsLight(el) {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const cs = getComputedStyle(n);
            const c = parseCol(cs.backgroundColor);
            if (c && c.a > 0.5) return c.l > 0.35;
            if (cs.backgroundImage && cs.backgroundImage !== 'none') {
                const cols = (cs.backgroundImage.match(/(?:rgba?|color)\([^)]*\)/g) || []).map(parseCol).filter((x) => x && x.a > 0.5);
                if (cols.length) return cols.reduce((t, x) => t + x.l, 0) / cols.length > 0.35;
            }
            if (n.id === 'main-view') break;
        }
        return false;   // vidro escuro do painel
    }

    const FIX_SEL = 'button, a, span, p, h1, h2, h3, h4, svg, [data-encore-id="text"]';
    const darkSeen = new WeakMap();   // elemento -> escuro? (já conferido; o fundo atrás quase nunca muda)
    function tagDark() {
        try {
            const mv = document.querySelector('#main-view');
            if (!mv || document.hidden) return;
            // página de letras: não tocar em nada (as cores das palavras fazem parte da animação do Spicy)
            if (root.hasAttribute('data-jc-lyricspage') || mv.querySelector('#SpicyLyricsPage')) {
                document.querySelectorAll('[data-jc-fixlight]').forEach((el) => el.removeAttribute('data-jc-fixlight'));
                return;
            }
            // só elementos ainda não vistos (o resultado fica guardado neles), no máximo 80 por rodada,
            // sem medir posições: só estilos
            const add = [];
            let budget = 80;
            const els = mv.querySelectorAll(FIX_SEL);
            for (let i = 0; i < els.length && budget > 0; i++) {
                const el = els[i];
                if (darkSeen.has(el)) continue;
                budget--;
                darkSeen.set(el, false);
                if (el.closest('[data-encore-id="buttonPrimary"], [data-testid="play-button"], .jc-knob, .jc-hero, [data-jc-fixlight]')) continue;   // ícone escuro de propósito (pérola)
                const isSvg = el.namespaceURI === 'http://www.w3.org/2000/svg';
                if (isSvg && el.tagName.toLowerCase() !== 'svg') continue;
                if (!isSvg && el.tagName !== 'BUTTON') {
                    let hasText = false;
                    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { hasText = true; break; }
                    if (!hasText) continue;
                }
                const cs = getComputedStyle(el);
                const c = parseCol(isSvg ? cs.fill : cs.color);
                if (c && c.a >= 0.5 && c.l < 0.30 && !bgIsLight(el)) { darkSeen.set(el, true); add.push(el); }
            }
            add.forEach((el) => el.setAttribute('data-jc-fixlight', ''));
        } catch (e) { /* enfeite */ }
    }
    every(tagDark, 3000, 8000, 'mut: main');


    // ---------------------------------------------------------------------
    // Painel "Tocando agora": a pílula Lyrics fica sempre no pé da primeira tela.
    // A arte tem altura fixa (~507px); em janelas mais altas sobrava espaço e os
    // "Videoclipes relacionados" apareciam logo abaixo. Aqui medimos onde o cartão
    // cai naturalmente e damos uma margem (--jc-npv-gap) para ele descer até o pé
    // do painel (16px de folga, igual às laterais). Em janelas baixas a margem fica
    // negativa (até -16px) para a folga de baixo ficar igual também.
    // ---------------------------------------------------------------------
    let npvGapLast = null;
    let npvInfo = null;
    const bigMediaIn = (el) => Array.from(el.querySelectorAll('img, video')).some((m) => { const r = m.getBoundingClientRect(); return r.width > 150 && r.height > 150; });
    // ---- capa do painel responsiva ----
    // A capa é um quadrado do tamanho da largura do painel (~388px). Em telas menores
    // (ou janelas baixas) ela empurrava o nome da música e a pílula "Lyrics" para
    // fora do painel. Aqui a capa encolhe (--jc-npv-art) só o necessário para o nome,
    // o artista e a pílula caberem na altura disponível; em telas altas ela fica inteira.
    const NPV_ART_MIN = 150;
    let npvArtEl = null, npvArtLast = '', npvRe = false;
    function npvFindArt(vp, start) {
        if (!start) return null;
        let media = null, top = 1e9;
        vp.querySelectorAll('img, video').forEach((m) => {
            if (!(start.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_PRECEDING)) return;   // só o que vem antes do nome
            if (m.closest('#SpicyLyricsNPVCard')) return;
            const r = m.getBoundingClientRect();
            if (r.width > 150 && r.height > 150 && r.top < top) { top = r.top; media = m; }
        });
        if (!media) return null;
        const sq = (el) => { const w = el.offsetWidth, h = el.offsetHeight; return w > 100 && Math.abs(w - h) <= 3; };
        // sobe da imagem: o primeiro quadrado que a envolve e, enquanto o pai continuar quadrado, o pai
        let el = null;
        for (let n = media, i = 0; n && n !== vp && i < 8; n = n.parentElement, i++) {
            if (sq(n)) el = n; else if (el) break;
        }
        if (!el || el.offsetWidth < vp.clientWidth * 0.5) return null;      // vídeo/canvas em pé: não mexo
        const par = el.parentElement;
        if (!par) return null;
        const cs = getComputedStyle(par);
        const N = Math.min(par.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0), vp.clientWidth);
        if (!(N > NPV_ART_MIN)) return null;
        return { el, N };
    }
    // devolve true se o tamanho da capa mudou (quem chamou mede tudo de novo)
    // a música tem "Canvas" (vídeo ou imagem em pé no lugar da capa)? Só conta o que fica ACIMA do nome
    // da música: vídeos e fotos dos videoclipes relacionados, mais abaixo, não contam
    function npvHasCanvas(vp, start) {
        if (vp.closest('[data-sl-npv-canvas]') || vp.querySelector('[data-sl-npv-canvas]')) return true;
        if (!start) return false;
        let found = false;
        vp.querySelectorAll('video, img').forEach((m) => {
            if (found || !(start.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_PRECEDING) || m.closest('#SpicyLyricsNPVCard')) return;
            const r = m.getBoundingClientRect();
            if (r.width < 150 || r.height < 150) return;
            if (m.tagName === 'VIDEO' || r.height > r.width * 1.2) found = true;
        });
        return found;
    }
    function npvFitArt(panel, vp, start, base, tail) {
        const a = npvHasCanvas(vp, start) ? null : npvFindArt(vp, start);
        if (!a) {
            if (npvArtEl) { npvArtEl.removeAttribute('data-jc-npv-art'); npvArtEl = null; }
            if (npvArtLast !== '') { npvArtLast = ''; panel.style.removeProperty('--jc-npv-art'); return true; }
            return false;
        }
        if (a.el !== npvArtEl) {
            if (npvArtEl) npvArtEl.removeAttribute('data-jc-npv-art');
            npvArtEl = a.el;
            a.el.setAttribute('data-jc-npv-art', '');
        }
        const hA = a.el.offsetHeight;                   // offsetHeight ignora a animação (transform) do Spotify
        let h = Math.round(vp.clientHeight - tail - (base - hA));
        h = Math.max(NPV_ART_MIN, Math.min(Math.floor(a.N), h));
        const val = h >= Math.floor(a.N) - 1 ? '' : h + 'px';   // '' = tamanho natural
        if (val === npvArtLast) return false;
        npvArtLast = val;
        if (val) panel.style.setProperty('--jc-npv-art', val); else panel.style.removeProperty('--jc-npv-art');
        return true;
    }
    let npvCardInit = false, npvPrevCol = null, npvAutoTop = 0, npvFitTop = 0, npvUserAt = -1e9;
    function layoutNpv() {
        try {
            const panel = document.getElementById('Desktop_PanelContainer_Id');
            if (!panel) return;
            let card = document.getElementById('SpicyLyricsNPVCard');
            if (card && !card.getClientRects().length) card = null;
            let vp = (card && card.closest('[data-overlayscrollbars-viewport]')) || panel.querySelector('[data-overlayscrollbars-viewport]');
            if (!vp) vp = Array.from(panel.querySelectorAll('div')).find((n) => n.clientHeight > 200 && n.scrollHeight > n.clientHeight + 50) || null;
            if (!vp || !vp.clientHeight) return;

            // bloco que vem logo depois da arte (nome da música, artista, pílula e o resto):
            // ELE recebe o espaço, então o nome desce junto e fica no pé da tela.
            // Ponto de partida: a pílula (se existir) ou o próprio nome da música.
            let start = card, titleBlock = null, anchor = null;
            if (!card) {
                let nm = '';
                try { const it = Spicetify.Player.data.item; nm = ((it && (it.name || (it.metadata && it.metadata.title))) || '').trim(); } catch (e) { /* sem nome */ }
                if (nm) {
                    const w = document.createTreeWalker(vp, NodeFilter.SHOW_TEXT);
                    let t;
                    while ((t = w.nextNode())) { if ((t.nodeValue || '').trim() === nm && t.parentElement.getClientRects().length) { start = t.parentElement; break; } }
                }
                // sobe do nome até achar um irmão seguinte "grande" (videoclipes, sobre o artista...)
                for (let n = start; n && n !== vp; n = n.parentElement) {
                    let sib = n.nextElementSibling;
                    while (sib && !(sib.getClientRects().length && sib.getBoundingClientRect().height >= 60)) sib = sib.nextElementSibling;
                    if (sib) { titleBlock = n; anchor = sib; break; }
                }
            }
            let push = null;
            if (start) {
                let p = start;
                while (p.parentElement && p.parentElement !== vp && p.parentElement !== panel) {
                    const par = p.parentElement;
                    const kids = Array.from(par.children);
                    const ai = kids.findIndex((k) => k !== p && !k.contains(start) && bigMediaIn(k));
                    if (ai >= 0) {
                        const ci = kids.indexOf(p);
                        if (ai < ci) push = kids[ai + 1] || p;
                        break;
                    }
                    p = par;
                }
            }
            document.querySelectorAll('[data-jc-npv-push]').forEach((el) => { if (el !== push) el.removeAttribute('data-jc-npv-push'); });
            if (push && !push.hasAttribute('data-jc-npv-push')) push.setAttribute('data-jc-npv-push', '');

            const vr = vp.getBoundingClientRect();
            const mtPush = push ? (parseFloat(getComputedStyle(push).marginTop) || 0) : 0;
            let gPush = 0, gCard = 0, base = 0;
            if (card) {
                // o cartão começa FECHADO (só a pílula): na primeira vez que aparece aberto,
                // uso o próprio botão dele (a setinha), e daí em diante quem manda é você
                if (!npvCardInit) {
                    npvCardInit = true;
                    if (!card.classList.contains('Collapsed') && !card.classList.contains('Expanded')) {
                        const tg = card.querySelector('#NPVCardToggle');
                        if (tg) tg.click();
                    }
                }
                // acabou de abrir (setinha): rola o painel até o cartão aparecer inteiro
                const isCol = card.classList.contains('Collapsed');
                if (npvPrevCol === true && !isCol && !card.classList.contains('Expanded')) {
                    const vp0 = vp;
                    setTimeout(() => {
                        try {
                            const c2 = document.getElementById('SpicyLyricsNPVCard');
                            if (!c2 || c2.classList.contains('Collapsed')) return;
                            const over = c2.getBoundingClientRect().bottom - (vp0.getBoundingClientRect().bottom - 16);
                            if (over > 1) { npvAutoTop = vp0.scrollTop + Math.ceil(over); vp0.scrollTo({ top: npvAutoTop, behavior: 'smooth' }); }
                        } catch (e) { /* sem rolagem */ }
                    }, 420);   // depois da animação de abrir
                }
                // fechou de novo: se o painel ainda está onde eu deixei, volta para o topo
                if (npvPrevCol === false && isCol) {
                    if (npvAutoTop > 0 && Math.abs(vp.scrollTop - npvAutoTop) < 6) vp.scrollTo({ top: 0, behavior: 'smooth' });
                    npvAutoTop = 0;
                }
                npvPrevCol = isCol;
                const cr = card.getBoundingClientRect();
                const mtCard = parseFloat(getComputedStyle(card).marginTop) || 0;
                base = cr.top - vr.top + vp.scrollTop - mtPush - mtCard;   // onde a pílula cairia sem as margens
                if (!npvRe && npvFitArt(panel, vp, start, base, 70)) { npvRe = true; try { layoutNpv(); } finally { npvRe = false; } return; }   // 70 = pílula (54) + folga de baixo (16)
                // fechado: a pílula fica no pé do painel; aberto: o cartão inteiro cabe na tela
                const cardH = isCol ? 54 : Math.min(Math.round(cr.height), vp.clientHeight - 32);
                let gap = card.classList.contains('Expanded') ? 0 : Math.max(-16, Math.round(vp.clientHeight - 16 - cardH - base));
                if (!isCol) gap = Math.max(0, gap);   // aberto: fica logo abaixo do nome (o painel rola até ele)
                gPush = push ? Math.max(0, gap) : 0;
                gCard = push ? Math.min(0, gap) : gap;
                // janela baixa e a música com "Canvas" (vídeo/imagem alta): não dá para encolher o Canvas sem
                // cortar a imagem, então o painel rola sozinho só o necessário para a pílula Lyrics aparecer
                // inteira no pé (se você rolar o painel com o mouse, ele respeita por alguns segundos)
                if (!vp.__jcUserScroll) {
                    vp.__jcUserScroll = true;
                    let reT = 0;
                    const mark = () => {   // você rolou: respeita, e confere de novo daqui a pouco
                        npvUserAt = performance.now();
                        clearTimeout(reT); reT = setTimeout(() => { mutR.panel++; act(); }, 6500);
                    };
                    ['wheel', 'touchstart', 'keydown'].forEach((ev) => vp.addEventListener(ev, mark, { passive: true }));
                }
                if (isCol && !card.classList.contains('Expanded')) {
                    const need = Math.ceil(base + gCard + cardH + 16 - vp.clientHeight);
                    if (need > 2) {
                        if (performance.now() - npvUserAt > 6000 && vp.scrollTop < need - 2) { npvFitTop = need; vp.scrollTop = need; }
                    } else if (npvFitTop > 0) {
                        if (Math.abs(vp.scrollTop - npvFitTop) < 6) vp.scrollTop = 0;
                        npvFitTop = 0;
                    }
                }
            } else if (push && anchor) {
                // o que vem depois do nome (videoclipes...) fica logo abaixo da dobra
                base = anchor.getBoundingClientRect().top - vr.top + vp.scrollTop - mtPush;
                if (!npvRe && npvFitArt(panel, vp, start, base, 12)) { npvRe = true; try { layoutNpv(); } finally { npvRe = false; } return; }
                gPush = Math.max(0, Math.round(vp.clientHeight + 4 - base));
            } else if (npvArtEl || npvArtLast !== '') {
                npvFitArt(panel, vp, null, 0, 0);
            }
            npvInfo = { vpH: vp.clientHeight, base: Math.round(base), gPush, gCard, card: !!card, inicio: start ? (start.className || start.tagName).toString().slice(0, 40) : null, ancora: anchor ? (anchor.className || anchor.tagName).toString().slice(0, 40) : null, push: push ? (push.className || push.tagName).toString().slice(0, 60) : null };
            const key = gPush + '/' + gCard;
            if (key !== npvGapLast) {
                npvGapLast = key;
                panel.style.setProperty('--jc-npv-gap', gPush + 'px');
                panel.style.setProperty('--jc-npv-gap-card', gCard + 'px');
            }
        } catch (e) { npvInfo = { erro: String(e && e.message || e) }; }
    }
    every(layoutNpv, 1500, 0, 'mut: panel');
    try {
        const ro = new ResizeObserver(() => layoutNpv());
        const watch = () => {
            const p = document.getElementById('Desktop_PanelContainer_Id');
            if (p && !p.__jcRo) { p.__jcRo = true; ro.observe(p); }
            const c = document.getElementById('SpicyLyricsNPVCard');     // abrir/fechar o cartão reposiciona na hora
            if (c && !c.__jcRo) { c.__jcRo = true; ro.observe(c); }
        };
        every(watch, 1500, 4000);
    } catch (e) { /* sem ResizeObserver */ }

    // 'scroll' não borbulha, então escutamos na fase de captura.
    let raf = 0;
    document.addEventListener('scroll', (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        // painel direito (Tocando agora): o cartão de letras só abre por inteiro depois de rolar
        const pan = t.closest('#Desktop_PanelContainer_Id');
        if (pan) {
            if (!t.closest('#SpicyLyricsNPVCard')) {   // ignora a rolagem da própria letra
                if (t.scrollTop > 24) pan.setAttribute('data-jc-npv-scrolled', '1');
                else pan.removeAttribute('data-jc-npv-scrolled');
            }
            return;
        }
        const isMain = t.matches(MAIN_VIEWPORT);
        // Plano B se a estrutura mudar: qualquer rolador alto dentro da área principal
        const looksMain = t.closest('.main-view-container') && t.clientHeight >= 400;
        if (!isMain && !looksMain) return;

        setY(-t.scrollTop);
        setAtTop(t.scrollTop);

        if (!raf) {
            raf = requestAnimationFrame(() => {
                raf = 0;
                if (!topbar || !topbar.isConnected) tagTopbar();
                tagSticky();
            });
        }
    }, true);

    // Ao trocar de página o scroll volta ao topo
    Spicetify.Platform.History.listen(() => {
        setY(0);
        setAtTop(0);
        // a página nova demora um pouco para montar a barra do título e a capa
        [150, 500, 1200].forEach((ms) => setTimeout(() => { tagTopbar(); updateGlow(); }, ms));
    });

    if (Spicetify.Player && Spicetify.Player.addEventListener) {
        Spicetify.Player.addEventListener('songchange', () => setTimeout(updateGlow, 200));
    }

    // Estado inicial
    const init = () => {
        const v = document.querySelector(MAIN_VIEWPORT);
        setAtTop(v ? v.scrollTop : 0);
        tagTopbar();
        updateGlow();
    };
    init();
    setTimeout(init, 1500);
    // Reaplica se o React recriar a capa; barato (poucas consultas por ciclo)
    every(updateGlow, 2000, 0, 'mut: main bar mainimg');

    // ---------------------------------------------------------------------
    // Paleta de cores do tema: um botão junto de Novidades e Atividade dos amigos
    // (aparece ao passar o mouse na foto da conta). "Cor dinâmica" deixa tudo como
    // sempre foi (cores da capa da música). As outras trocam a cor dos detalhes
    // (barra de tempo, brilhos, onda sonora, botões ligados, traço dos títulos...) e
    // tingem as animações de fundo (painel da direita, boas-vindas, barra do player e
    // página de letras). A escolha fica salva.
    // ---------------------------------------------------------------------
    const PALETTES = [
        { id: 'dinamica', nome: 'Cor dinâmica' },
        { id: 'branco', nome: 'Branco', c: [245, 245, 247], claro: true },
        { id: 'vermelho', nome: 'Vermelho', c: [255, 69, 58] },
        { id: 'laranja', nome: 'Laranja', c: [255, 159, 10] },
        { id: 'dourado', nome: 'Dourado', c: [230, 185, 92], claro: true },
        { id: 'amarelo', nome: 'Amarelo', c: [255, 214, 10], claro: true },
        { id: 'verde', nome: 'Verde', c: [30, 215, 96], claro: true },
        { id: 'menta', nome: 'Menta', c: [99, 230, 190], claro: true },
        { id: 'ciano', nome: 'Ciano', c: [100, 210, 255], claro: true },
        { id: 'azul', nome: 'Azul', c: [10, 132, 255] },
        { id: 'indigo', nome: 'Índigo', c: [94, 92, 230] },
        { id: 'roxo', nome: 'Roxo', c: [191, 90, 242] },
        { id: 'rosa', nome: 'Rosa', c: [255, 55, 95] },
    ];
    const palMix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
    function palHue(c, deg) {                      // gira o matiz (HSL), mantendo claridade e saturação
        const [r, g, b] = c.map((x) => x / 255);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
        if (mx - mn < 1e-6) return c.slice();
        const dd = mx - mn, sat = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
        let h = mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
        h = (((h * 60 + deg) % 360) + 360) % 360 / 360;
        const f = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
        return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)].map((x) => Math.round(x * 255));
    }
    function palShades(c) {
        const W = [255, 255, 255], K = [0, 0, 0];
        return {
            vivid: c, deep: palMix(c, K, 0.62), m: palMix(c, K, 0.16),
            tl: palMix(palHue(c, -14), W, 0.10), tr: palHue(c, 12), bl: palMix(palHue(c, -8), K, 0.28),
            br: palMix(palHue(c, 18), K, 0.10), l: palMix(c, W, 0.06), r: palMix(c, K, 0.08),
        };
    }
    const palRgb = (a) => a.join(', ');
    const palHex = (a) => '#' + a.map((x) => x.toString(16).padStart(2, '0')).join('');
    function palCss(p) {
        const s = palShades(p.c), v = [], keys = ['tl', 'tr', 'bl', 'br', 'm', 'l', 'r'];
        keys.forEach((k) => {
            v.push('--np-' + k + ': ' + palRgb(s[k]) + ' !important;');
            v.push('--pg-' + k + ': ' + palRgb(s[k]) + ' !important;');
        });
        v.push('--np-vivid: ' + palRgb(s.vivid) + ' !important;', '--np-deep: ' + palRgb(s.deep) + ' !important;');
        ['m', 'bl', 'tl'].forEach((k) => v.push('--al-' + k + ': ' + palRgb(s[k]) + ' !important;'));
        ['--spice-button', '--spice-button-active', '--spice-accent'].forEach((k) => v.push(k + ': ' + palHex(p.c) + ' !important;'));
        ['--spice-rgb-button', '--spice-rgb-button-active', '--spice-rgb-accent'].forEach((k) => v.push(k + ': ' + palRgb(p.c) + ' !important;'));
        // força do tom no fundo (a capa desfocada do Hazy): cores claras ganham menos, para não "lavar" a tela
        v.push('--jc-bgtint: ' + (p.claro ? 0.55 : 0.72) + ' !important;');
        const gc = keys.map((k) => '--gc-' + k + ': ' + palRgb(s[k]) + ' !important;').join(' ');
        return 'html[data-jc-palette] { ' + v.join(' ') + ' }\n' +
            'html[data-jc-palette] [data-jc-glow] { ' + gc + ' }\n' +
            // animações de fundo tingidas (o filtro #jc-tint fica nesta página)
            'html[data-jc-palette] #Desktop_PanelContainer_Id > canvas.spicy-dynamic-bg,\n' +
            'html[data-jc-palette] aside.spicy-dynamic-bg-in-this > canvas.spicy-dynamic-bg { filter: url(#jc-tint) brightness(.74) !important; }\n' +
            'html[data-jc-palette] #SpicyLyricsPage .ContentBox > canvas.spicy-dynamic-bg,\n' +
            'html[data-jc-palette] #SpicyLyricsPage .ContentBox > canvas.CanvasAmbient { filter: url(#jc-tint) brightness(.72) !important; }\n';
    }
    // filtro que pinta uma imagem com uma cor só, mantendo a luz e a sombra dela
    function palFilter(c) {
        let svg = document.getElementById('jc-tint-svg');
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.id = 'jc-tint-svg';
            svg.setAttribute('aria-hidden', 'true');
            svg.setAttribute('width', '0');
            svg.setAttribute('height', '0');
            svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
            svg.innerHTML = '<defs><filter id="jc-tint" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/></filter></defs>';
            document.body.appendChild(svg);
        }
        const [r, g, b] = c.map((x) => x / 255);
        // cores claras (branco, amarelo...) ganham menos luz, para o texto branco continuar legível
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b, G = 1.45 - Math.max(0, lum - 0.5), L = 0.045;
        const row = (k) => [0.2126 * G * k, 0.7152 * G * k, 0.0722 * G * k, 0, L * k].map((x) => x.toFixed(4)).join(' ');
        const fm = svg.querySelector('feColorMatrix');
        if (fm) fm.setAttribute('values', row(r) + ' ' + row(g) + ' ' + row(b) + ' 0 0 0 1 0');
    }
    let palCur = 'dinamica', palPop = null;
    function palApply(id, save) {
        const p = PALETTES.find((x) => x.id === id) || PALETTES[0];
        palCur = p.id;
        let st = document.getElementById('jc-palette-css');
        if (!st) {
            st = document.createElement('style');
            st.id = 'jc-palette-css';
            document.head.appendChild(st);
        }
        if (p.c) {
            palFilter(p.c);
            st.textContent = palCss(p);
            if (root.getAttribute('data-jc-palette') !== p.id) root.setAttribute('data-jc-palette', p.id);
        } else {
            st.textContent = '';
            root.removeAttribute('data-jc-palette');
        }
        if (save) { try { localStorage.setItem('jc-palette', p.id); } catch (e) { /* sem armazenamento: vale só agora */ } }
        palSync();
    }
    const PAL_ICON = '<svg class="jc-pal-ico" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M12 3.2a8.8 8.8 0 0 0 0 17.6c1.06 0 1.75-.78 1.75-1.66 0-.46-.18-.86-.47-1.17-.28-.3-.46-.7-.46-1.14 0-.92.75-1.66 1.66-1.66h1.98a4.75 4.75 0 0 0 4.74-4.74C21.2 6.6 17.1 3.2 12 3.2Z" style="fill:none;stroke:currentColor;stroke-width:1.7;stroke-linejoin:round"/>' +
        '<circle cx="7.3" cy="11.2" r="1.5" style="fill:#ff453a;stroke:none"/><circle cx="9.7" cy="7.3" r="1.5" style="fill:#ffd60a;stroke:none"/>' +
        '<circle cx="14.4" cy="7.1" r="1.5" style="fill:#30d158;stroke:none"/><circle cx="17.1" cy="10.6" r="1.5" style="fill:#0a84ff;stroke:none"/></svg>';
    function palBuild() {
        const pop = document.createElement('div');
        pop.className = 'jc-pal-pop';
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', 'Cores do tema');
        pop.innerHTML = '<div class="jc-pal-title">Cores do tema</div>' +
            '<div class="jc-pal-sub">Detalhes e animações na cor que você escolher</div>' +
            '<div class="jc-pal-list" role="radiogroup" aria-label="Cores do tema">' +
            '<button type="button" class="jc-pal-dyn" role="radio" data-pal="dinamica"><i></i><span><b>Cor dinâmica</b><small>Segue a capa da música tocando</small></span></button>' +
            '<div class="jc-pal-grid">' + PALETTES.filter((p) => p.c).map((p) =>
                '<button type="button" class="jc-pal-sw" role="radio" data-pal="' + p.id + '" title="' + p.nome + '" style="--c: ' + palRgb(p.c) + '; --k: ' + (p.claro ? '#141418' : '#ffffff') + '"><i></i><span>' + p.nome + '</span></button>'
            ).join('') + '</div></div>' +
            '<div class="jc-pal-extra">' +
            '<button type="button" class="jc-pal-opt" data-act="lite" role="switch" aria-checked="' + lite + '"><span><b>Modo leve</b><small>Sem aura, ondas e fundos animados do tema</small></span><i></i></button>' +
            '<button type="button" class="jc-pal-opt" data-act="perf"><span><b>Testar desempenho</b><small>~1–2 min; mostra onde está pesando</small></span></button>' +
            '</div>';
        pop.addEventListener('click', (e) => {
            e.stopPropagation();
            const o = e.target.closest('[data-act]');
            if (o) {
                if (o.getAttribute('data-act') === 'perf') { jcPerf(); return; }
                lite = !lite;
                try { localStorage.setItem('jc-lite', lite ? '1' : '0'); } catch (er) { /* sem armazenamento */ }
                if (lite) root.setAttribute('data-jc-lite', ''); else root.removeAttribute('data-jc-lite');
                o.setAttribute('aria-checked', String(lite));
                return;
            }
            const b = e.target.closest('[data-pal]');
            if (b) palApply(b.getAttribute('data-pal'), true);
        });
        document.body.appendChild(pop);
        return pop;
    }
    function palSync() {
        if (!palPop) return;
        palPop.querySelectorAll('[data-pal]').forEach((b) => {
            const on = String(b.getAttribute('data-pal') === palCur);
            if (b.getAttribute('aria-checked') !== on) b.setAttribute('aria-checked', on);
        });
    }
    function palPlace() {
        const btn = document.querySelector('#global-nav-bar .jc-pal-btn');
        if (!palPop || !btn) return;
        const group = btn.closest('.main-actionButtons') || btn;
        palPop.style.top = Math.round(btn.getBoundingClientRect().bottom + 10) + 'px';
        palPop.style.right = Math.max(8, Math.round(window.innerWidth - group.getBoundingClientRect().right)) + 'px';
    }
    function palOpen(open) {
        if (open && !palPop) palPop = palBuild();
        if (!palPop) return;
        if (open) {
            palSync();
            palPlace();
            palPop.setAttribute('data-open', '');
            root.setAttribute('data-jc-palopen', '');
        } else {
            palPop.removeAttribute('data-open');
            root.removeAttribute('data-jc-palopen');
        }
    }
    const palToggle = () => palOpen(!(palPop && palPop.hasAttribute('data-open')));
    document.addEventListener('click', (e) => {
        if (palPop && palPop.hasAttribute('data-open') && !(e.target instanceof Element && e.target.closest('.jc-pal-pop, .jc-pal-btn'))) palOpen(false);
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && palPop && palPop.hasAttribute('data-open')) palOpen(false);
    });
    window.addEventListener('resize', () => { if (palPop && palPop.hasAttribute('data-open')) palPlace(); });
    function palMount() {
        try {
            const group = document.querySelector('#global-nav-bar .main-actionButtons');
            const av = group && group.querySelector(':scope > [data-testid="user-widget-link"]');
            if (!group || !av) return;
            let btn = group.querySelector(':scope > .jc-pal-btn');
            if (!btn) {
                btn = document.createElement('button');
                btn.type = 'button';
                // mesmo tipo de botão que Novidades/Amigos (o Spotify e o Hazy já estilizam)
                const sib = Array.from(group.children).find((e) => e.tagName === 'BUTTON' && e !== av);
                btn.className = (sib ? sib.className + ' ' : '') + 'jc-pal-btn';
                if (sib && sib.offsetWidth) {
                    btn.style.width = sib.offsetWidth + 'px';
                    btn.style.height = sib.offsetHeight + 'px';
                }
                btn.setAttribute('aria-label', 'Cores do tema');
                btn.setAttribute('aria-haspopup', 'dialog');
                btn.title = 'Cores do tema';
                btn.innerHTML = PAL_ICON;
                btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); palToggle(); });
            }
            if (btn.parentElement !== group || btn.nextElementSibling !== av) group.insertBefore(btn, av);
        } catch (e) { /* enfeite */ }
    }
    try { palApply(localStorage.getItem('jc-palette') || 'dinamica', false); } catch (e) { palApply('dinamica', false); }
    palMount();
    every(palMount, 2000, 0, 'mut: nav');

    // Lápis (ajustes do Hazy) e carrinho (loja): o Spotify/Spicetify os põem na ponta esquerda da
    // barra de cima, dentro de elementos que o React ou o Spicetify refazem a cada navegação (mover
    // esses elementos quebraria a tela). Então ficam onde estão, escondidos, e cada um ganha um
    // "gêmeo" entre os botões da foto da conta (aparecem juntos com Novidades, Amigos e a paleta);
    // o clique do gêmeo aperta o botão de verdade.
    const navTwins = new Map();   // botão original -> gêmeo
    const NAV_NATIVE_RE = /voltar|avan[cç]ar|retroceder|\bback\b|\bforward\b|go back|go forward|zur[uü]ck|retour|suivant|atr[aá]s|adelante|indietro|avanti/i;
    function navProxies() {
        try {
            const group = document.querySelector('#global-nav-bar .main-actionButtons');
            const av = group && group.querySelector(':scope > [data-testid="user-widget-link"]');
            if (!group || !av) return;
            // Só ganham gêmeo os botões do SPICETIFY (lápis do Hazy, loja): ficam em .spicetify-topbar-button
            // e .custom-navlinks-scrollable_container. Voltar/avançar do Spotify moram junto deles (no mesmo
            // contêiner), então além da lista de permitidos o filtro barra data-testid e nome ("Voltar",
            // "Avançar", "Go back"...): só o data-testid falhou no Spotify real e os dois apareciam repetidos.
            const isNavNative = (b) => b.matches('[data-testid*="back" i], [data-testid*="forward" i]')
                || NAV_NATIVE_RE.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || ''));
            const isSpice = (b) => !!b.closest('.spicetify-topbar-button, .custom-navlinks-scrollable_container, .custom-navlink') || b.matches('.spicetify-topbar-button, .custom-navlink');
            const origs = Array.from(document.querySelectorAll('#global-nav-bar .main-globalNav-historyButtonsWrapper button'))
                .filter((b) => isSpice(b) && !isNavNative(b));
            navTwins.forEach((tw, o) => { if (!o.isConnected || !origs.includes(o)) { tw.remove(); navTwins.delete(o); } });
            let prev = null;
            origs.forEach((o) => {
                let tw = navTwins.get(o);
                if (!tw) {
                    tw = document.createElement('button');
                    tw.type = 'button';
                    tw.className = 'jc-nav-proxy';
                    tw.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); o.click(); });
                    navTwins.set(o, tw);
                }
                const label = o.getAttribute('aria-label') || o.getAttribute('title') || '';
                if (tw.getAttribute('aria-label') !== label) { tw.setAttribute('aria-label', label); tw.title = label; }
                if (tw.innerHTML !== o.innerHTML) tw.innerHTML = o.innerHTML;
                if (tw.disabled !== o.disabled) tw.disabled = o.disabled;
                const act = o.classList.contains('main-globalNav-navLinkActive');
                if (act !== tw.hasAttribute('data-jc-active')) { if (act) tw.setAttribute('data-jc-active', ''); else tw.removeAttribute('data-jc-active'); }
                if (tw.parentElement !== group || tw.previousElementSibling !== prev) group.insertBefore(tw, prev ? prev.nextElementSibling : group.firstElementChild);
                prev = tw;
            });
            const has = navTwins.size > 0;
            if (has !== root.hasAttribute('data-jc-navproxy')) { if (has) root.setAttribute('data-jc-navproxy', ''); else root.removeAttribute('data-jc-navproxy'); }
        } catch (e) { /* enfeite */ }
    }
    navProxies();
    every(navProxies, 1500, 0, 'mut: nav');

    // ---------------------------------------------------------------------
    // Minimizar e Fechar: sem a barra de título (tbApply) não sobra jeito de minimizar ou fechar com
    // o mouse. Dois botões de vidro entram junto dos que aparecem ao passar o mouse na foto de perfil
    // (ficam antes da paleta, longe da foto, para não fechar sem querer). Falam com o serviço de estado
    // da janela do próprio Spotify: setWindowState({state: 3}) minimiza e closeWindow({}) fecha. O
    // cliente fica escondido dentro de uma das APIs da Platform (a FocusMainWindowAPI guarda um em
    // _windowStateClient), então procuro por quem tem as duas funções, sem depender do nome.
    // Com a barra nativa de volta (F8) os dois somem.
    // ---------------------------------------------------------------------
    const WIN_ICON = {
        min: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
        close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    };
    let winCl = null;
    function winClient() {
        const ok = (o) => !!o && typeof o === 'object' && typeof o.closeWindow === 'function' && typeof o.setWindowState === 'function';
        if (winCl && ok(winCl)) return winCl;
        winCl = null;
        try {
            const P = Spicetify.Platform;
            if (!P) return null;
            for (const k of Object.keys(P)) {
                const o = P[k];
                if (!o || typeof o !== 'object') continue;
                if (ok(o)) return (winCl = o);
                for (const k2 of Object.keys(o)) {
                    if (k2.charAt(0) === '_' && ok(o[k2])) return (winCl = o[k2]);
                }
            }
        } catch (e) { /* sem a Platform */ }
        return null;
    }
    function winAct(kind) {
        const warn = (m) => { try { Spicetify.showNotification(m); } catch (e) { /* sem aviso */ } };
        const c = winClient();
        if (!c) { warn('Não consegui falar com a janela do Spotify. Use a barra de tarefas ou Alt+F4.'); return; }
        try {
            const r = kind === 'min' ? c.setWindowState({ state: 3 }) : c.closeWindow({});   // 3 = WINDOW_STATE_MINIMIZED
            if (r && r.catch) r.catch(() => warn('O Spotify não aceitou o pedido. Use a barra de tarefas ou Alt+F4.'));
        } catch (e) { warn('O Spotify não aceitou o pedido. Use a barra de tarefas ou Alt+F4.'); }
    }
    function winMount() {
        try {
            const group = document.querySelector('#global-nav-bar .main-actionButtons');
            const av = group && group.querySelector(':scope > [data-testid="user-widget-link"]');
            if (!group || !av) return;
            const before = group.querySelector(':scope > .jc-pal-btn') || av;
            const made = [];
            [['min', 'Minimizar'], ['close', 'Fechar']].forEach(([k, label]) => {
                let b = group.querySelector(':scope > .jc-win-btn[data-act="' + k + '"]');
                if (!b) {
                    b = document.createElement('button');
                    b.type = 'button';
                    const sib = Array.from(group.children).find((e) => e.tagName === 'BUTTON' && e !== av && !/jc-(pal-btn|win-btn|nav-proxy)/.test(e.className));
                    b.className = ((sib ? sib.className : '') + ' jc-win-btn').trim();
                    b.setAttribute('data-act', k);
                    b.setAttribute('aria-label', label);
                    b.title = label;
                    b.innerHTML = WIN_ICON[k];
                    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); winAct(k); });
                }
                made.push(b);
            });
            if (made[0].parentElement !== group || made[0].nextElementSibling !== made[1] || made[1].nextElementSibling !== before) {
                group.insertBefore(made[0], before);
                group.insertBefore(made[1], before);
            }
        } catch (e) { /* enfeite */ }
    }
    winMount();
    every(winMount, 2000, 0, 'mut: nav');

    // ---------------------------------------------------------------------
    // Página Navegar (todas as seções): cada cartão de categoria é um <div> com a cor de fundo
    // INLINE dentro de um link, tendo a capa (<img>) e o título. Marco o cartão (data-jc-cat) e
    // guardo a cor dele em --jc-bc, para o CSS fazer o vidro colorido e o rótulo do disco de vinil.
    // Cores escuras ganham luz (o máximo do canal sobe até ~215) para o brilho aparecer no escuro.
    // ---------------------------------------------------------------------
    function catScan() {
        try {
            document.querySelectorAll('#main-view a[href] > div[style*="background-color"]:not([data-jc-cat])').forEach((t) => {
                if (!t.querySelector(':scope > img')) return;
                const m = (t.style.backgroundColor || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
                if (!m) return;
                let c = [+m[1], +m[2], +m[3]];
                const mx = Math.max(c[0], c[1], c[2]);
                if (mx > 0 && mx < 215) { const k = 215 / mx; c = c.map((x) => Math.min(255, Math.round(x * k))); }
                else if (mx === 0) c = [120, 120, 150];
                t.style.setProperty('--jc-bc', c.join(', '));
                t.setAttribute('data-jc-cat', '');
            });
        } catch (e) { /* enfeite */ }
    }
    catScan();
    every(catScan, 1500, 0, 'mut: main');
    window.jcPalette = (id) => palApply(id, true);   // também dá para trocar pelo Console: jcPalette('azul')

    // ---- teste de desempenho ----------------------------------------------------------------------
    // Na janelinha de cores (botão de paleta) > "Testar desempenho", ou F9, ou jcPerf() no Console.
    // 1) Fluidez: quadros por segundo com tudo ligado e desligando, um de cada vez, o que mais pesa.
    // 2) Troca de tela: vai para "Músicas Curtidas" e volta, medindo quanto a página demora para
    //    assentar e as travadas, com tudo ligado, sem as tarefas do tema e sem o CSS.
    // Deixe uma música tocando e não mexa no Spotify durante o teste (~1 min).
    const CANVAS_FX = 'canvas.jc-aura,canvas.jc-eq,canvas.jc-hero-bg,canvas.jc-hdr-bg,canvas.jc-lyrbar-cv{visibility:hidden!important}';
    function themeLinks() {
        return Array.from(document.querySelectorAll('link[rel="stylesheet"], style')).filter((l) => (l.href && /user\.css/.test(l.href)) || l.classList.contains('userCSS'));
    }
    // interações lentas desde que o Spotify abriu (Event Timing): passar o mouse, clicar, teclar
    const slowEv = [];
    try {
        const tname = (el) => { if (!el || !el.tagName) return '?'; const t = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.getAttribute('class')); return el.tagName.toLowerCase() + (t ? '[' + String(t).slice(0, 28) + ']' : ''); };
        new PerformanceObserver((l) => l.getEntries().forEach((e) => {
            if (e.duration < 120 || perfBusy) return;
            slowEv.push({ n: e.name, d: Math.round(e.duration), espera: Math.round(e.processingStart - e.startTime), js: Math.round(e.processingEnd - e.processingStart), alvo: tname(e.target) });
            if (slowEv.length > 60) slowEv.shift();
        })).observe({ type: 'event', durationThreshold: 104, buffered: true });
    } catch (e) { /* sem Event Timing */ }
    const PERF_TESTS = [
        ['Normal', ''],
        ['Sem vidro ao vivo (backdrop-filter)', '*,*::before,*::after{backdrop-filter:none!important}'],
        ['Sem filtros (filter)', '*,*::before,*::after{filter:none!important}'],
        ['Sem sombras', '*,*::before,*::after{box-shadow:none!important;text-shadow:none!important}'],
        ['Sem fundo animado do Spicy', '.spicy-dynamic-bg,canvas.spicy-dynamic-bg{visibility:hidden!important}'],
        ['Sem vídeos', 'video{visibility:hidden!important}'],
        ['Sem efeitos e tarefas do tema', CANVAS_FX, 'fx'],
        ['Sem o CSS (tema + Hazy)', '', 'css'],
        ['Só o Hazy (sem o CSS do tema)', '', 'hazy'],
        ['Sem o painel da direita', '#Desktop_PanelContainer_Id > *,.Root__right-sidebar > *{visibility:hidden!important}'],
    ];
    let perfBusy = false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    function perfLong() {   // tarefas longas (> 50 ms) do processo da página
        const L = { n: 0, tot: 0, max: 0 };
        let po = null;
        try { po = new PerformanceObserver((l) => l.getEntries().forEach((e) => { L.n++; L.tot += e.duration; if (e.duration > L.max) L.max = e.duration; })); po.observe({ type: 'longtask' }); } catch (e) { /* sem suporte */ }
        L.stop = () => { try { po && po.disconnect(); } catch (e) { /* nada */ } return L; };
        return L;
    }
    function perfMeasure(ms) {
        return new Promise((res) => {
            const d = []; let last = 0; const t0 = performance.now(); const L = perfLong();
            const f = (ts) => {
                if (last) d.push(ts - last);
                last = ts;
                if (ts - t0 < ms) requestAnimationFrame(f);
                else {
                    L.stop();
                    const tot = d.reduce((x, y) => x + y, 0) || 1;
                    const so = d.slice().sort((x, y) => x - y);
                    res({ fps: Math.round(d.length * 1000 / tot), trav: d.filter((x) => x > 34).length, pior: Math.round(so[so.length - 1] || 0), longas: Math.round(L.tot) });
                }
            };
            requestAnimationFrame(f);
        });
    }
    function perfSettle(maxMs) {   // espera a página parar de mudar (600 ms sem elementos novos)
        return new Promise((res) => {
            const t0 = performance.now(); let lastM = t0; const L = perfLong();
            const mo = new MutationObserver((recs) => { for (const r of recs) if (r.addedNodes.length) { lastM = performance.now(); break; } });
            mo.observe(document.body, { childList: true, subtree: true });
            const iv = setInterval(() => {
                const now = performance.now();
                if (now - lastM > 600 || now - t0 > maxMs) {
                    clearInterval(iv); mo.disconnect(); L.stop();
                    res({ ms: Math.round(lastM - t0), longas: Math.round(L.tot), pior: Math.round(L.max) });
                }
            }, 50);
        });
    }
    function perfSet(st, test, on) {
        st.textContent = on ? test[1] : '';
        if (test[2] === 'fx') fxPause = on;
        if (test[2] === 'css' || test[2] === 'hazy') themeLinks().forEach((l) => { l.disabled = on; });
        if (test[2] === 'hazy') {
            let hz = document.getElementById('jc-perf-hazy');
            if (on && !hz) { hz = document.createElement('link'); hz.id = 'jc-perf-hazy'; hz.rel = 'stylesheet'; hz.href = 'https://cdn.jsdelivr.net/gh/astromations/hazy/app.css'; document.head.appendChild(hz); }
            if (!on && hz) hz.remove();
        }
    }
    async function jcPerf() {
        if (perfBusy) return null;
        perfBusy = true;
        palOpen(false);
        const st = document.createElement('style'); st.id = 'jc-perf-style'; document.head.appendChild(st);
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:16px;top:16px;z-index:2147483647;padding:14px 16px;border-radius:14px;background:rgba(20,20,24,.95);color:#fff;font:12.5px/1.5 Consolas,ui-monospace,monospace;box-shadow:0 10px 40px rgba(0,0,0,.6);max-width:94vw;white-space:pre;pointer-events:auto;user-select:text';
        const say = (t) => { box.textContent = 'Liquid Glass: ' + t + '\n(não mexa no Spotify; deixe a música tocando)'; };
        document.body.appendChild(box);
        const A = [], B = [];
        const H = Spicetify.Platform.History, back = (H.location && H.location.pathname) || '/';
        const nMut = () => Object.keys(mutCount).reduce((x, k) => x + mutCount[k], 0);
        try {
            // a página precisa estar parada (capas carregadas): espera até 2 s sem mudanças (no máximo 15 s)
            say('esperando a página terminar de carregar…');
            for (let w = 0, last = nMut(), quiet = 0; w < 30 && quiet < 4; w++) { await sleep(500); const n = nMut(); quiet = n === last ? quiet + 1 : 0; last = n; }
            const steps = PERF_TESTS.concat([['Normal (de novo, no fim)', '']]);
            for (let i = 0; i < steps.length; i++) {
                const tst = steps[i];
                say('fluidez ' + (i + 1) + '/' + steps.length + ' — ' + tst[0] + '…');
                perfSet(st, tst, true);
                await sleep(tst[2] === 'css' || tst[2] === 'hazy' ? 2000 : 800);
                const m0 = nMut();
                const r = await perfMeasure(3000);
                r.mud = nMut() - m0;
                A.push([tst[0], r]);
                perfSet(st, tst, false);
                if (tst[2] === 'css' || tst[2] === 'hazy') await sleep(2500);   // o CSS voltou: espera a página se redesenhar
            }
            const NAV = [['Normal', null], ['Sem tarefas do tema', PERF_TESTS[6]], ['Sem o CSS (tema + Hazy)', PERF_TESTS[7]]];
            const dest = back.indexOf('/collection/tracks') === 0 ? '/' : '/collection/tracks';
            for (let i = 0; i < NAV.length; i++) {
                if (NAV[i][1]) perfSet(st, NAV[i][1], true);
                await sleep(1200);
                const r = [];
                for (const to of [dest, back]) {
                    say('troca de tela ' + (i + 1) + '/' + NAV.length + ' — ' + NAV[i][0] + ' (' + to + ')…');
                    const p = perfSettle(8000);
                    H.push(to);
                    r.push(await p);
                    await sleep(500);
                }
                if (NAV[i][1]) perfSet(st, NAV[i][1], false);
                B.push([NAV[i][0], { ms: Math.round((r[0].ms + r[1].ms) / 2), longas: r[0].longas + r[1].longas, pior: Math.max(r[0].pior, r[1].pior) }]);
            }
        } catch (e) {
            A.push(['ERRO no teste: ' + ((e && e.message) || e), { fps: 0, trav: 0, pior: 0, longas: 0 }]);
        } finally {
            st.remove(); fxPause = false; themeLinks().forEach((l) => { l.disabled = false; });
            const hz = document.getElementById('jc-perf-hazy'); if (hz) hz.remove();
        }
        const w = Math.max(...A.concat(B).map((o) => o[0].length));
        const la = A.map(([n, r]) => n.padEnd(w) + ' ' + String(r.fps).padStart(4) + ' fps  travadas ' + String(r.trav).padStart(3) + '  pior ' + String(r.pior).padStart(4) + ' ms  JS longo ' + String(r.longas).padStart(4) + ' ms' + (r.mud ? '  (página mudou ' + r.mud + 'x)' : ''));
        const lb = B.map(([n, r]) => n.padEnd(w) + ' assenta em ' + String(r.ms).padStart(5) + ' ms  JS longo ' + String(r.longas).padStart(5) + ' ms  pior ' + String(r.pior).padStart(4) + ' ms');
        const top = Array.from(taskStat.entries()).map(([t, v]) => [(t.fn.name || 'anon'), v, t.err]).sort((x, y) => y[1].tot - x[1].tot).slice(0, 7)
            .map(([n, v, err]) => n + ' ' + Math.round(v.tot) + 'ms/' + v.n + 'x (máx ' + Math.round(v.max) + ')' + (err ? ' ERRO: ' + err : ''));
        const errs = Array.from(taskStat.keys()).filter((t) => t.err).map((t) => (t.fn.name || 'anon') + ': ' + t.err);
        const scr = window.screen || {};
        const txt = 'Liquid Glass — teste de desempenho (v' + JC_CSS_V + ')\n' +
            'tela ' + (scr.width || '?') + 'x' + (scr.height || '?') + ' @' + (window.devicePixelRatio || 1) + 'x  janela ' + innerWidth + 'x' + innerHeight +
            '  nós ' + document.getElementsByTagName('*').length + '  ' + (root.hasAttribute('data-jc-bgbaked') ? 'fundo pronto' : 'fundo AO VIVO') + (lite ? '  modo leve' : '') + '\n\n' +
            'FLUIDEZ (3 s cada)\n' + la.join('\n') + '\n\nTROCA DE TELA (ida e volta)\n' + lb.join('\n') +
            '\nPainel: ' + JSON.stringify(npvInfo || {}).slice(0, 300) + '  capa ' + (npvArtLast || 'natural') +
            '\nAnálise de áudio (batidas) da música: ' + (() => { let u = ''; try { u = Spicetify.Player.data.item.uri; } catch (e) { /* nada */ } const d = eqData.get(u); return d === 'carregando' ? 'carregando' : d ? 'sim (' + d.beats.length + ' batidas)' : 'NÃO (a onda usa um movimento padrão)'; })() +
            '\nInterações lentas (desde que abriu): ' + (slowEv.length ? slowEv.slice().sort((x, y) => y.d - x.d).slice(0, 6).map((e) => e.n + ' ' + e.d + 'ms (espera ' + e.espera + ', js ' + e.js + ') ' + e.alvo).join(' | ') : 'nenhuma') +
            '\n\nTarefas do tema: ' + top.join(' | ') + '\nMudanças na página: ' + Object.keys(mutCount).map((k) => k + ' ' + mutCount[k]).join(', ') + (errs.length ? '\nERROS: ' + errs.join(' | ') : '') +
            '\n\nTire um print desta caixa (ou cole o texto: já foi copiado). Clique para fechar.';
        box.textContent = txt;
        box.style.cursor = 'pointer';
        box.addEventListener('click', () => box.remove());
        try { console.log(txt); } catch (e) { /* sem console */ }
        try { if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {}); } catch (e) { /* sem área de transferência */ }
        perfBusy = false;
        return txt;
    }
    window.jcPerf = jcPerf;
    const perfKey = (e) => {
        if (e.key === 'F9' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); jcPerf(); }
        else if (e.ctrlKey && e.altKey && (e.code === 'KeyP' || e.key === 'p' || e.key === 'P')) { e.preventDefault(); e.stopPropagation(); jcPerf(); }
    };
    window.addEventListener('keydown', perfKey, true);
})();
